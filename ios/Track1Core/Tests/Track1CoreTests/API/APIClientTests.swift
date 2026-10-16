import Foundation
import XCTest

@testable import Track1Core

final class APIClientTests: XCTestCase {
	func testDecodesCatalogAndCarriesETag() async {
		let client = makeClient { request in
			XCTAssertEqual(request.url?.path, "/mobile/v1/catalog")
			XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), "old")
			return response(request, status: 200, headers: ["ETag": "catalog-v1"], body: catalogJSON)
		}

		let result = await client.catalog(etag: "old", hasCachedRepresentation: true)
		guard case .success(let catalog, let etag) = result else { return XCTFail("Expected a catalog") }
		XCTAssertEqual(catalog.version, "v1")
		XCTAssertEqual(catalog.nodes.first?.identity.rawValue, "artist:massive-attack")
		XCTAssertEqual(etag, "catalog-v1")
	}

	func testRejectsIncoherentIdentityAndUnsafeExternalURL() async {
		let client = makeClient { request in
			XCTAssertEqual(
				URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.percentEncodedPath,
				"/mobile/v1/nodes/artist%3Amassive-attack")
			let payload = nodeJSON.replacingOccurrences(
				of: "\"artist\"", with: "\"track\"", options: [], range: nodeJSON.range(of: "\"artist\"")!)
			return response(request, status: 200, body: payload)
		}
		assertFailure(await client.node(identity), equals: .invalidResponse)

		let unsafeClient = makeClient { request in
			let payload = nodeJSON.replacingOccurrences(
				of: "https://example.com/source", with: "https://127.0.0.1/source")
			return response(request, status: 200, body: payload)
		}
		assertFailure(await unsafeClient.node(identity), equals: .invalidResponse)

		let mappedIPv4Client = makeClient { request in
			let payload = nodeJSON.replacingOccurrences(
				of: "https://example.com/source", with: "https://[::ffff:7f00:1]/source")
			return response(request, status: 200, body: payload)
		}
		assertFailure(await mappedIPv4Client.node(identity), equals: .invalidResponse)
	}

	func testDecodesTheImageSourceOfANodeWithoutRequiringIt() async {
		let image = "\"image_url\":\"https://img.example.com/cover.jpg\""
		let withSource = makeClient { request in
			let payload = nodeJSON.replacingOccurrences(
				of: "\"image_url\":null", with: "\(image),\"image_source\":\"derived-cover\"")
			return response(request, status: 200, body: payload)
		}
		guard case .success(let decoded, _) = await withSource.node(identity) else {
			return XCTFail("Expected a node")
		}
		XCTAssertEqual(decoded.node.imageURL?.absoluteString, "https://img.example.com/cover.jpg")
		XCTAssertEqual(decoded.node.imageSource, "derived-cover")

		let withoutSource = makeClient { request in
			response(request, status: 200, body: nodeJSON.replacingOccurrences(of: "\"image_url\":null", with: image))
		}
		guard case .success(let plain, _) = await withoutSource.node(identity) else {
			return XCTFail("Expected a node")
		}
		XCTAssertNil(plain.node.imageSource)

		let nullSource = makeClient { request in
			let payload = nodeJSON.replacingOccurrences(
				of: "\"image_url\":null", with: "\"image_url\":null,\"image_source\":null")
			return response(request, status: 200, body: payload)
		}
		guard case .success(let none, _) = await nullSource.node(identity) else {
			return XCTFail("Expected a node")
		}
		XCTAssertNil(none.node.imageSource)

		let invalidSource = makeClient { request in
			let payload = nodeJSON.replacingOccurrences(
				of: "\"image_url\":null", with: "\"image_url\":null,\"image_source\":[]")
			return response(request, status: 200, body: payload)
		}
		assertFailure(await invalidSource.node(identity), equals: .invalidResponse)
	}

	func testRejectsMissingRequiredNullableFields() async {
		let missingCatalogTeaser = makeClient { request in
			response(request, status: 200, body: catalogJSON.replacingOccurrences(of: ",\"teaser\":null", with: ""))
		}
		assertFailure(await missingCatalogTeaser.catalog(), equals: .invalidResponse)

		let missingNodeTeaser = makeClient { request in
			response(request, status: 200, body: nodeJSON.replacingOccurrences(of: ",\"teaser\":null", with: ""))
		}
		assertFailure(await missingNodeTeaser.node(identity), equals: .invalidResponse)

		let invalidImage = makeClient { request in
			response(
				request, status: 200,
				body: "{\"slug\":\"artist:massive-attack\",\"image_url\":[],\"source\":\"cache\"}")
		}
		assertFailure(await invalidImage.image(identity), equals: .invalidResponse)

		let missingImage = makeClient { request in
			response(request, status: 200, body: "{\"slug\":\"artist:massive-attack\",\"source\":\"cache\"}")
		}
		assertFailure(await missingImage.image(identity), equals: .invalidResponse)

		let missingLinks = makeClient { request in
			response(
				request, status: 200,
				body:
					"{\"slug\":\"artist:massive-attack\",\"apple\":null,\"sources\":{},\"resolvedAt\":\"2026-09-26T12:00:00.000Z\"}"
			)
		}
		assertFailure(await missingLinks.links(identity), equals: .invalidResponse)

		let missingApple = makeClient { request in
			response(
				request, status: 200,
				body:
					"{\"slug\":\"artist:massive-attack\",\"spotify\":null,\"sources\":{},\"resolvedAt\":\"2026-09-26T12:00:00.000Z\"}"
			)
		}
		assertFailure(await missingApple.links(identity), equals: .invalidResponse)
	}

	func testOnlyUses304WithKnownRepresentation() async {
		let client = makeClient { request in response(request, status: 304, body: "") }
		guard case .notModified(let etag) = await client.catalog(etag: "catalog-v1", hasCachedRepresentation: true)
		else { return XCTFail("Expected 304") }
		XCTAssertEqual(etag, "catalog-v1")
		assertFailure(await client.catalog(), equals: .invalidResponse)
	}

	func testDistinguishesAPIAndCancellationErrorsWithoutRetryingPost() async {
		let errorClient = makeClient { request in
			response(
				request, status: 429, headers: ["Retry-After": "30"],
				body: "{\"error\":{\"code\":\"busy\",\"message\":\"private\",\"retryable\":true}}")
		}
		assertFailure(
			await errorClient.search(query: "massive"),
			equals: .http(status: 429, code: "busy", retryable: true, retryAfterSeconds: 30))

		let cancelled = Task { await errorClient.search(query: "massive") }
		cancelled.cancel()
		assertFailure(await cancelled.value, equals: .cancelled)
		assertFailure(await makeErrorClient(.timedOut).search(query: "massive"), equals: .timeout)
		assertFailure(await makeErrorClient(.notConnectedToInternet).search(query: "massive"), equals: .network)
	}

	func testImageResponseFromAnOlderServerHasNoStateAndIsNotPending() throws {
		let body = #"{"slug":"artist:massive-attack","image_url":null,"source":"cache"}"#

		let decoded = try JSONDecoder().decode(ImageResponse.self, from: Data(body.utf8))

		XCTAssertNil(decoded.state)
		XCTAssertNil(decoded.retryAfterSeconds)
		XCTAssertFalse(decoded.isPending)
	}

	func testImageResponseReadsAMalformedStateOrDelayAsAbsent() throws {
		let body =
			#"{"slug":"artist:massive-attack","image_url":null,"source":"cache","state":[],"retry_after_seconds":"soon"}"#

		let decoded = try JSONDecoder().decode(ImageResponse.self, from: Data(body.utf8))

		XCTAssertNil(decoded.state)
		XCTAssertNil(decoded.retryAfterSeconds)
	}

	func testReadsImageLinksSearchAndGenerationResponses() async {
		let requestID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
		let client = makeClient { request in
			switch request.url?.path {
			case "/mobile/v1/nodes/artist:massive-attack/image":
				return response(
					request, status: 200,
					body:
						"{\"slug\":\"artist:massive-attack\",\"image_url\":null,\"source\":\"cache\",\"state\":\"pending\",\"retry_after_seconds\":5}"
				)
			case "/mobile/v1/nodes/artist:massive-attack/links":
				return response(
					request, status: 200,
					body:
						"{\"slug\":\"artist:massive-attack\",\"spotify\":null,\"apple\":null,\"sources\":{},\"resolvedAt\":\"2026-09-26T12:00:00.000Z\"}"
				)
			case "/mobile/v1/search":
				return response(
					request, status: 200,
					body:
						"{\"q\":\"acid&bass\",\"hits\":[{\"source\":\"cache\",\"type\":\"artist\",\"name\":\"Massive Attack\",\"slug\":\"artist:massive-attack\"}],\"sources\":{\"cache\":1,\"catalog\":0}}"
				)
			case "/mobile/v1/generations/11111111-1111-4111-8111-111111111111":
				return response(
					request, status: 200,
					body:
						"{\"request_id\":\"11111111-1111-4111-8111-111111111111\",\"status\":\"queued\",\"created_at\":\"2026-09-26T12:00:00.000Z\",\"updated_at\":\"2026-09-26T12:00:00.000Z\",\"node_id\":null,\"error\":null}"
				)
			default:
				return response(request, status: 404, body: "{\"error\":{\"code\":\"missing\",\"retryable\":false}}")
			}
		}

		guard case .success(let image, _) = await client.image(identity) else {
			return XCTFail("Expected image response.")
		}
		XCTAssertEqual(image.state, "pending")
		XCTAssertEqual(image.retryAfterSeconds, 5)
		XCTAssertTrue(image.isPending)
		guard case .success = await client.links(identity) else { return XCTFail("Expected links response.") }
		guard case .success = await client.search(query: "acid&bass") else {
			return XCTFail("Expected search response.")
		}
		guard case .success = await client.generation(requestID: requestID) else {
			return XCTFail("Expected generation response.")
		}
	}

	func testRejectsRedirectWithoutRepeatingGenerationPost() async {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [RedirectURLProtocol.self]
		RedirectURLProtocol.reset()
		let client = APIClient(
			configuration: testConfiguration(), session: URLSession(configuration: configuration))
		let result = await client.createGeneration(
			GenerationRequest(
				requestID: UUID(), type: .artist, name: "Massive Attack", slug: nil, mbid: nil, qid: nil,
				disambiguator: nil))
		guard case .failure = result else { return XCTFail("A redirect must not be accepted.") }
		XCTAssertEqual(RedirectURLProtocol.requestCount(), 1)

		let rejected = expectation(description: "redirect rejected")
		let original = URL(string: "https://api.example.test/mobile/v1/generations")!
		let destination = URLRequest(url: URL(string: "https://attacker.example/generations")!)
		let response = HTTPURLResponse(
			url: original, statusCode: 307, httpVersion: nil,
			headerFields: ["Location": destination.url!.absoluteString])!
		RejectRedirectDelegate.shared.urlSession(
			URLSession.shared, task: URLSession.shared.dataTask(with: original), willPerformHTTPRedirection: response,
			newRequest: destination
		) { request in
			XCTAssertNil(request)
			rejected.fulfill()
		}
		await fulfillment(of: [rejected], timeout: 1)
	}

	func testInFlightCancellationDoesNotReturnAStaleSuccess() async {
		let started = expectation(description: "request started")
		let releaseResponse = DispatchSemaphore(value: 0)
		let client = makeClient { request in
			started.fulfill()
			releaseResponse.wait()
			return response(request, status: 200, body: catalogJSON)
		}
		let task = Task { await client.catalog() }
		await fulfillment(of: [started], timeout: 1)
		task.cancel()
		releaseResponse.signal()
		assertFailure(await task.value, equals: .cancelled)
	}

	func testGenerationPostIsSentOnce() async {
		let lock = NSLock()
		var requestCount = 0
		let client = makeClient { request in
			XCTAssertEqual(request.url?.path, "/mobile/v1/generations")
			lock.lock()
			requestCount += 1
			lock.unlock()
			return response(
				request, status: 503,
				body: "{\"error\":{\"code\":\"provider_unavailable\",\"message\":\"private\",\"retryable\":true}}")
		}
		let result = await client.createGeneration(
			GenerationRequest(
				requestID: UUID(), type: .artist, name: "Massive Attack", slug: nil, mbid: nil, qid: nil,
				disambiguator: nil))
		assertFailure(
			result, equals: .http(status: 503, code: "provider_unavailable", retryable: true, retryAfterSeconds: nil))
		XCTAssertEqual(requestCount, 1)
	}

	// TRA-482: the contract of TRA-477 for a work tapped from an artist page.
	func testGenerationPostCarriesTheArtistAndTheSourceEdgeAsSnakeCaseKeys() async throws {
		let box = BodyBox()
		let client = makeClient { request in
			box.set(Self.body(of: request))
			return response(request, status: 200, body: Self.succeededGenerationJSON)
		}
		let requestID = try XCTUnwrap(UUID(uuidString: "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd"))
		let result = await client.createGeneration(
			GenerationRequest(
				requestID: requestID, type: .track, name: "Fitna", slug: NodeIdentity(rawValue: "track:fitna--rohff"),
				mbid: nil, qid: nil, disambiguator: nil, artist: "Rohff",
				source: GenerationSource(
					slug: try XCTUnwrap(NodeIdentity(rawValue: "artist:rohff")), field: "notable_tracks")
			))
		guard case .success = result else { return XCTFail("Expected a generation.") }
		let sent = try Self.canonical(try XCTUnwrap(box.value))
		// The server reads the UUID case-insensitively; Foundation writes it in capitals.
		XCTAssertEqual((sent["request_id"] as? String)?.lowercased(), "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd")
		let mutable = NSMutableDictionary(dictionary: sent)
		mutable.removeObject(forKey: "request_id")
		XCTAssertEqual(
			mutable,
			try Self.canonical(
				Data(
					#"{"type":"track","name":"Fitna","slug":"track:fitna--rohff","artist":"Rohff","source":{"slug":"artist:rohff","field":"notable_tracks"}}"#
						.utf8)))
	}

	func testGenerationRequestOmitsArtistAndSourceWhenNil() throws {
		let request = GenerationRequest(
			requestID: UUID(), type: .genre, name: "Trip hop", slug: nil, mbid: nil, qid: nil, disambiguator: nil)
		let object = try XCTUnwrap(
			JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
		XCTAssertEqual(Set(object.keys), ["request_id", "type", "name"])
	}

	func testGenerationRequestKeepsMbidAndQidAlongsideTheContext() throws {
		let mbid = try XCTUnwrap(UUID(uuidString: "11111111-1111-4111-8111-111111111111"))
		let request = GenerationRequest(
			requestID: UUID(), type: .project, name: "Mezzanine", slug: nil, mbid: mbid, qid: "Q1",
			disambiguator: nil, artist: "Massive Attack", source: nil)
		let object = try XCTUnwrap(
			JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
		XCTAssertEqual(object["mbid"] as? String, "11111111-1111-4111-8111-111111111111")
		XCTAssertEqual(object["qid"] as? String, "Q1")
		XCTAssertEqual(object["artist"] as? String, "Massive Attack")
		XCTAssertNil(object["source"])
	}

	func testGenerationWithAMalformedSourceFieldIsRefusedBeforeAnyRequest() async throws {
		let box = BodyBox()
		let client = makeClient { request in
			box.set(Data())
			return response(request, status: 200, body: Self.succeededGenerationJSON)
		}
		for field in ["", "Notable_tracks", "notable-tracks", "__proto__", String(repeating: "a", count: 41)] {
			let result = await client.createGeneration(
				GenerationRequest(
					requestID: UUID(), type: .track, name: "Fitna", slug: nil, mbid: nil, qid: nil, disambiguator: nil,
					artist: "Rohff", source: GenerationSource(slug: identity, field: field)))
			assertFailure(result, equals: .invalidRequest)
		}
		XCTAssertNil(box.value)
	}

	private static let succeededGenerationJSON =
		#"{"request_id":"f9cdb447-c46d-4a97-b4bc-0f7ad73466bd","status":"succeeded","created_at":"2026-10-15T00:00:00.000Z","updated_at":"2026-10-15T00:00:00.000Z","node_id":"track:fitna--rohff"}"#

	private static func body(of request: URLRequest) -> Data {
		if let body = request.httpBody { return body }
		guard let stream = request.httpBodyStream else { return Data() }
		stream.open()
		defer { stream.close() }
		var data = Data()
		var buffer = [UInt8](repeating: 0, count: 1024)
		while stream.hasBytesAvailable {
			let count = stream.read(&buffer, maxLength: buffer.count)
			if count <= 0 { break }
			data.append(buffer, count: count)
		}
		return data
	}

	/// Key order and spacing are not part of the contract: compare the parsed JSON, not the bytes.
	private static func canonical(_ data: Data) throws -> NSDictionary {
		try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
	}
}

private final class BodyBox: @unchecked Sendable {
	private let lock = NSLock()
	private var stored: Data?
	var value: Data? { lock.withLock { stored } }
	func set(_ data: Data) { lock.withLock { stored = data } }
}

private func assertFailure<Value: Sendable>(
	_ result: APIResult<Value>, equals expected: APIError, file: StaticString = #filePath, line: UInt = #line
) {
	guard case .failure(let error) = result else {
		return XCTFail("Expected API failure", file: file, line: line)
	}
	XCTAssertEqual(error, expected, file: file, line: line)
}

private let identity = NodeIdentity(rawValue: "artist:massive-attack")!
private let catalogJSON = """
	{"version":"v1","revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taxonomy":{"mode":"degraded","available":true},"nodes":[{"identity":"artist:massive-attack","type":"artist","name":"Massive Attack","teaser":null}],"edges":[]}
	"""
private let nodeJSON = """
	{"node":{"id":"artist:massive-attack","type":"artist","name":"Massive Attack","teaser":null,"article":"Article","citations":[{"url":"https://example.com/source","title":"Source"}],"facts":{"origin":"Bristol"},"edges":{},"materialized_at":"2026-09-26T12:00:00.000Z","image_url":null},"source":"cache"}
	"""

private func makeClient(handler: @escaping (URLRequest) -> (HTTPURLResponse, Data)) -> APIClient {
	StubURLProtocol.setHandler(handler)
	let configuration = URLSessionConfiguration.ephemeral
	configuration.protocolClasses = [StubURLProtocol.self]
	return APIClient(configuration: testConfiguration(), session: URLSession(configuration: configuration))
}

private func makeErrorClient(_ error: URLError.Code) -> APIClient {
	ErrorURLProtocol.setError(URLError(error))
	let configuration = URLSessionConfiguration.ephemeral
	configuration.protocolClasses = [ErrorURLProtocol.self]
	return APIClient(configuration: testConfiguration(), session: URLSession(configuration: configuration))
}

private func testConfiguration() -> AppConfiguration {
	guard
		case .success(let configuration) = AppConfiguration.validate(
			values: AppConfigurationValues(
				environment: "development", apiBaseURL: "https://api.example.test/mobile/v1/", segmentWriteKey: nil))
	else { fatalError("The test API configuration must be valid.") }
	return configuration
}

private func response(_ request: URLRequest, status: Int, headers: [String: String] = [:], body: String) -> (
	HTTPURLResponse, Data
) {
	(
		HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!,
		Data(body.utf8)
	)
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
	private static let store = HandlerStore()

	static func setHandler(_ handler: @escaping (URLRequest) -> (HTTPURLResponse, Data)) {
		store.set(handler)
	}

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		guard let handler = Self.store.get() else { return }
		let (response, data) = handler(request)
		client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: data)
		client?.urlProtocolDidFinishLoading(self)
	}
	override func stopLoading() {}
}

private final class ErrorURLProtocol: URLProtocol, @unchecked Sendable {
	private static let store = ErrorStore()

	static func setError(_ error: Error) { store.set(error) }
	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		guard let error = Self.store.get() else { return }
		client?.urlProtocol(self, didFailWithError: error)
	}
	override func stopLoading() {}
}

private final class RedirectURLProtocol: URLProtocol, @unchecked Sendable {
	private static let store = RequestCountStore()

	static func reset() { store.reset() }
	static func requestCount() -> Int { store.value() }
	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		Self.store.increment()
		let destination = URLRequest(url: URL(string: "https://attacker.example/generations")!)
		let response = HTTPURLResponse(
			url: request.url!, statusCode: 307, httpVersion: nil,
			headerFields: ["Location": destination.url!.absoluteString])!
		client?.urlProtocol(self, wasRedirectedTo: destination, redirectResponse: response)
	}
	override func stopLoading() {}
}

private final class HandlerStore: @unchecked Sendable {
	private let lock = NSLock()
	private var handler: ((URLRequest) -> (HTTPURLResponse, Data))?

	func set(_ handler: @escaping (URLRequest) -> (HTTPURLResponse, Data)) {
		lock.lock()
		self.handler = handler
		lock.unlock()
	}

	func get() -> ((URLRequest) -> (HTTPURLResponse, Data))? {
		lock.lock()
		defer { lock.unlock() }
		return handler
	}
}

private final class ErrorStore: @unchecked Sendable {
	private let lock = NSLock()
	private var error: Error?

	func set(_ error: Error) {
		lock.lock()
		self.error = error
		lock.unlock()
	}

	func get() -> Error? {
		lock.lock()
		defer { lock.unlock() }
		return error
	}
}

private final class RequestCountStore: @unchecked Sendable {
	private let lock = NSLock()
	private var count = 0

	func reset() {
		lock.lock()
		count = 0
		lock.unlock()
	}

	func increment() {
		lock.lock()
		count += 1
		lock.unlock()
	}

	func value() -> Int {
		lock.lock()
		defer { lock.unlock() }
		return count
	}
}
