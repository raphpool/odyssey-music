import Foundation
import Track1Core
import XCTest

@testable import Track1

final class ContentReadersTests: XCTestCase {
	override func setUp() {
		super.setUp()
		RecordingURLProtocol.reset()
	}

	override func tearDown() {
		RecordingURLProtocol.reset()
		super.tearDown()
	}

	func testEveryLiveReaderIssuesExactlyOneGetRequestToItsEndpoint() async throws {
		let readers = ContentReaders.live(makeRecordingClient())
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "artist:x"))

		// Each reader runs alone so a request is attributed to the reader that issued it.
		let expectations: [(name: String, expected: String, call: () async -> Void)] = [
			("catalog", "GET /mobile/v1/catalog", { _ = await readers.catalog() }),
			("node", "GET /mobile/v1/nodes/artist:x", { _ = await readers.node(identity) }),
			("image", "GET /mobile/v1/nodes/artist:x/image", { _ = await readers.image(identity) }),
			("links", "GET /mobile/v1/nodes/artist:x/links", { _ = await readers.links(identity) }),
			("search", "GET /mobile/v1/search?q=ab&type=genre", { _ = await readers.search("ab", .genre) }),
		]

		var observed = Set<String>()
		for expectation in expectations {
			RecordingURLProtocol.reset()
			await expectation.call()
			let requests = RecordingURLProtocol.requests()
			XCTAssertEqual(requests, [expectation.expected], "reader \(expectation.name)")
			observed.formUnion(requests)
		}

		XCTAssertEqual(Set(observed.map { $0.split(separator: " ")[0] }), ["GET"])
	}
}

private func makeRecordingClient() -> APIClient {
	// The protocol is attached to this session only; it is never registered process-wide, so it
	// cannot intercept requests made by other tests.
	let configuration = URLSessionConfiguration.ephemeral
	configuration.protocolClasses = [RecordingURLProtocol.self]
	guard
		case .success(let appConfiguration) = AppConfiguration.validate(
			values: AppConfigurationValues(
				environment: "development", apiBaseURL: "https://fixture.invalid/mobile/v1/", segmentWriteKey: nil)
		)
	else { fatalError("The fixture API configuration must be valid.") }
	return APIClient(configuration: appConfiguration, session: URLSession(configuration: configuration))
}

private final class RecordingURLProtocol: URLProtocol, @unchecked Sendable {
	private static let log = RequestLog()

	static func reset() { log.reset() }
	static func requests() -> [String] { log.all() }

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

	override func startLoading() {
		let url = request.url
		// `path` is the decoded path, so `artist%3Ax` is compared as `artist:x`.
		// APIClient always sets query items, so a parameterless read ends with an empty `?` (2026-10-11,
		// ios-check on #322: `GET /mobile/v1/catalog?`). The empty query carries nothing; drop it.
		let query = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedQuery }
			.flatMap { $0.isEmpty ? nil : $0 }
		let target = (url?.path ?? "") + (query.map { "?\($0)" } ?? "")
		Self.log.append("\(request.httpMethod ?? "?") \(target)")

		// A 404 is enough: only the outgoing request matters here, never the decoded response.
		let response = HTTPURLResponse(url: url!, statusCode: 404, httpVersion: nil, headerFields: [:])!
		client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: Data())
		client?.urlProtocolDidFinishLoading(self)
	}

	override func stopLoading() {}
}

private final class RequestLog: @unchecked Sendable {
	private let lock = NSLock()
	private var entries: [String] = []

	func append(_ entry: String) {
		lock.lock()
		entries.append(entry)
		lock.unlock()
	}

	func reset() {
		lock.lock()
		entries = []
		lock.unlock()
	}

	func all() -> [String] {
		lock.lock()
		defer { lock.unlock() }
		return entries
	}
}
