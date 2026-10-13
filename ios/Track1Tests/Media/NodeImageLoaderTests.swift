import Foundation
import UIKit
import XCTest

@testable import Track1

/// Drives the real loader through a local `URLProtocol`: no network, and the stub records every URL that is
/// actually requested so a refused redirect can be shown never to reach its target.
final class NodeImageLoaderTests: XCTestCase {
	override func setUp() {
		super.setUp()
		StubProtocol.reset()
	}

	override func tearDown() {
		StubProtocol.reset()
		super.tearDown()
	}

	func testPublicHTTPSRedirectLoadsTheImage() async throws {
		StubProtocol.register("https://img.example.com/start", .redirect("https://cdn.example.com/final.png"))
		StubProtocol.register("https://cdn.example.com/final.png", .ok(try Self.pngData(width: 40, height: 20)))

		let image = await Self.load("https://img.example.com/start")

		XCTAssertNotNil(image)
		XCTAssertEqual(
			StubProtocol.requested, ["https://img.example.com/start", "https://cdn.example.com/final.png"])
	}

	func testRedirectsToPrivateHttpOrPortTargetsAreNeverRequested() async throws {
		let targets = [
			"https://127.0.0.1/secret.png", "https://10.0.0.5/secret.png", "https://169.254.169.254/latest",
			"https://2130706433/secret.png", "https://localhost/secret.png",
			"http://cdn.example.com/plain.png", "https://cdn.example.com:8443/port.png",
		]
		for target in targets {
			StubProtocol.reset()
			StubProtocol.register("https://img.example.com/start", .redirect(target))
			StubProtocol.register(target, .ok(try Self.pngData(width: 8, height: 8)))

			let clock = ContinuousClock()
			let started = clock.now
			let image = await Self.load("https://img.example.com/start")
			let elapsed = started.duration(to: clock.now)

			XCTAssertNil(image, target)
			XCTAssertEqual(StubProtocol.requested, ["https://img.example.com/start"], "\(target) was requested.")
			// A refused redirect must end on the 3xx right away. Ending on the loader's 20 s request timeout
			// would also give `nil`, but without exercising the path under test.
			XCTAssertLessThan(elapsed, .seconds(2), "\(target) only ended on the request timeout.")
		}
	}

	func testAnUnsafeInitialURLIsNeverRequested() async throws {
		for value in [
			"http://img.example.com/a.png", "https://127.0.0.1/a.png", "https://img.example.com:8443/a.png",
		] {
			StubProtocol.register(value, .ok(try Self.pngData(width: 8, height: 8)))
			let image = await Self.load(value)
			XCTAssertNil(image, value)
		}
		XCTAssertTrue(StubProtocol.requested.isEmpty)
	}

	func testANon2xxAnswerOrATypeOtherThanAnImageGivesNil() async throws {
		let png = try Self.pngData(width: 8, height: 8)
		StubProtocol.register("https://img.example.com/missing.png", .status(404, png))
		StubProtocol.register("https://img.example.com/page", .ok(png, mimeType: "text/html"))

		for path in ["missing.png", "page"] {
			let image = await Self.load("https://img.example.com/\(path)")
			XCTAssertNil(image, path)
		}
	}

	func testABodyOverTenMegabytesGivesNilWhetherOrNotItIsAnnounced() async throws {
		let oversized = Data(count: NodeImageLoader.maximumBodyBytes + 1)
		StubProtocol.register("https://img.example.com/announced.png", .ok(oversized))
		StubProtocol.register("https://img.example.com/silent.png", .ok(oversized, announcesLength: false))

		for name in ["announced", "silent"] {
			let image = await Self.load("https://img.example.com/\(name).png")
			XCTAssertNil(image, name)
		}
	}

	func testLargeImagesAreDownsampledAndSmallOnesKeepTheirSize() async throws {
		StubProtocol.register("https://img.example.com/large.png", .ok(try Self.pngData(width: 1500, height: 900)))
		StubProtocol.register("https://img.example.com/small.png", .ok(try Self.pngData(width: 120, height: 80)))

		let largeImage = await Self.load("https://img.example.com/large.png")
		let smallImage = await Self.load("https://img.example.com/small.png")
		let large = try XCTUnwrap(largeImage?.cgImage)
		let small = try XCTUnwrap(smallImage?.cgImage)

		XCTAssertEqual(max(large.width, large.height), NodeImageLoader.maximumPixelSize)
		XCTAssertEqual(large.width * 900, large.height * 1500, "The aspect ratio is kept.")
		XCTAssertEqual([small.width, small.height], [120, 80])
	}

	func testASourceWithTooManyPixelsIsNotDecoded() throws {
		let data = try Self.pngData(width: 40, height: 20)  // 800 pixels

		XCTAssertNil(NodeImageLoader.downsampledImage(from: data, maximumSourcePixels: 799))
		XCTAssertNotNil(NodeImageLoader.downsampledImage(from: data, maximumSourcePixels: 800))
	}

	// MARK: - Helpers

	private static func load(_ value: String) async -> UIImage? {
		guard let url = URL(string: value) else { return nil }
		return await NodeImageLoader.load(url: url, configuration: stubbed())
	}

	private static func stubbed() -> URLSessionConfiguration {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [StubProtocol.self]
		return configuration
	}

	private static func pngData(width: Int, height: Int) throws -> Data {
		let format = UIGraphicsImageRendererFormat()
		format.scale = 1
		let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
		return try XCTUnwrap(
			renderer.image { context in
				UIColor.systemTeal.setFill()
				context.fill(CGRect(x: 0, y: 0, width: width, height: height))
			}.pngData())
	}
}

/// Answers from a table keyed by absolute URL and records which URLs were really requested.
private final class StubProtocol: URLProtocol, @unchecked Sendable {
	struct Reply {
		var status = 200
		var body = Data()
		var mimeType = "image/png"
		var announcesLength = true
		var redirectTo: String?

		static func ok(_ body: Data, mimeType: String = "image/png", announcesLength: Bool = true) -> Reply {
			Reply(body: body, mimeType: mimeType, announcesLength: announcesLength)
		}
		static func status(_ status: Int, _ body: Data) -> Reply { Reply(status: status, body: body) }
		static func redirect(_ target: String) -> Reply { Reply(status: 302, redirectTo: target) }
	}

	private static let lock = NSLock()
	nonisolated(unsafe) private static var replies: [String: Reply] = [:]
	nonisolated(unsafe) private static var log: [String] = []

	static var requested: [String] {
		lock.lock()
		defer { lock.unlock() }
		return log
	}

	static func register(_ url: String, _ reply: Reply) {
		lock.lock()
		replies[url] = reply
		lock.unlock()
	}

	static func reset() {
		lock.lock()
		replies = [:]
		log = []
		lock.unlock()
	}

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

	/// How long a redirect is left to be followed before its 3xx is delivered as the final response.
	private static let redirectGrace: DispatchTimeInterval = .milliseconds(500)

	private let stateLock = NSLock()
	private var stopped = false

	private var isStopped: Bool {
		stateLock.lock()
		defer { stateLock.unlock() }
		return stopped
	}

	override func stopLoading() {
		stateLock.lock()
		stopped = true
		stateLock.unlock()
	}

	override func startLoading() {
		guard let url = request.url else { return }
		Self.lock.lock()
		Self.log.append(url.absoluteString)
		let reply = Self.replies[url.absoluteString]
		Self.lock.unlock()
		guard let reply else {
			client?.urlProtocol(self, didFailWithError: URLError(.fileDoesNotExist))
			return
		}
		var headers = ["Content-Type": reply.mimeType]
		if reply.announcesLength { headers["Content-Length"] = String(reply.body.count) }
		if let target = reply.redirectTo { headers["Location"] = target }
		guard
			let response = HTTPURLResponse(
				url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers)
		else { return }
		if let target = reply.redirectTo, let targetURL = URL(string: target) {
			client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: targetURL), redirectResponse: response)
			return
		}
		client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: reply.body)
		client?.urlProtocolDidFinishLoading(self)
	}
}
