import XCTest

@testable import Track1

final class NodeImageLoaderTests: XCTestCase {
	func testPreviousLoaderWouldFetchThePrivateRedirect() async throws {
		RedirectingImageURLProtocol.reset()
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [RedirectingImageURLProtocol.self]
		let source = try XCTUnwrap(URL(string: "https://images.example.test/source.png"))

		let fetchedURL = await previousLoaderFetch(url: source, session: URLSession(configuration: configuration))

		XCTAssertEqual(fetchedURL?.host, "127.0.0.1")
		XCTAssertEqual(RedirectingImageURLProtocol.requestedPaths(), ["/source.png", "/private.png"])
	}

	func testRejectsPrivateRedirectBeforeItCanBeFetched() async throws {
		RedirectingImageURLProtocol.reset()
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [RedirectingImageURLProtocol.self]
		let source = try XCTUnwrap(URL(string: "https://images.example.test/source.png"))

		let image = await NodeImageLoader.load(url: source, session: URLSession(configuration: configuration))

		XCTAssertNil(image)
		XCTAssertEqual(RedirectingImageURLProtocol.requestedPaths(), ["/source.png"])
	}

	func testAllowsPublicHTTPSRedirectForCDNImages() async throws {
		RedirectingImageURLProtocol.reset()
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [RedirectingImageURLProtocol.self]
		let source = try XCTUnwrap(URL(string: "https://images.example.test/public-source.png"))

		let image = await NodeImageLoader.load(url: source, session: URLSession(configuration: configuration))

		XCTAssertNotNil(image)
		XCTAssertEqual(RedirectingImageURLProtocol.requestedPaths(), ["/public-source.png", "/cdn.png"])
	}

	private func previousLoaderFetch(url: URL, session: URLSession) async -> URL? {
		// Keeps the pre-fix request path executable as a regression witness for redirect validation.
		do {
			let (data, response) = try await session.data(from: url)
			guard !data.isEmpty else { return nil }
			return response.url
		} catch { return nil }
	}
}

private final class RedirectingImageURLProtocol: URLProtocol, @unchecked Sendable {
	private static let requests = RedirectRequestStore()

	static func reset() { requests.reset() }
	static func requestedPaths() -> [String] { requests.paths() }

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

	override func startLoading() {
		guard let url = request.url else {
			client?.urlProtocol(self, didFailWithError: URLError(.badURL))
			return
		}
		Self.requests.record(url.path)
		if url.path == "/source.png" {
			let redirected = URLRequest(url: URL(string: "https://127.0.0.1/private.png")!)
			let response = HTTPURLResponse(
				url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": redirected.url!.absoluteString])!
			client?.urlProtocol(self, wasRedirectedTo: redirected, redirectResponse: response)
			return
		}
		if url.path == "/public-source.png" {
			let redirected = URLRequest(url: URL(string: "https://cdn.example.test/cdn.png")!)
			let response = HTTPURLResponse(
				url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": redirected.url!.absoluteString])!
			client?.urlProtocol(self, wasRedirectedTo: redirected, redirectResponse: response)
			return
		}
		let response = HTTPURLResponse(
			url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!
		client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: Self.onePixelPNG)
		client?.urlProtocolDidFinishLoading(self)
	}

	override func stopLoading() {
		client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
	}

	private static let onePixelPNG = Data(
		base64Encoded:
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
}

private final class RedirectRequestStore: @unchecked Sendable {
	private let lock = NSLock()
	private var values = [String]()

	func reset() {
		lock.lock()
		values = []
		lock.unlock()
	}

	func record(_ value: String) {
		lock.lock()
		values.append(value)
		lock.unlock()
	}

	func paths() -> [String] {
		lock.lock()
		defer { lock.unlock() }
		return values
	}
}
