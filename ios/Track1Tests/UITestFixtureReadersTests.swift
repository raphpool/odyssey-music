#if targetEnvironment(simulator)
	import Foundation
	import XCTest

	@testable import Track1

	final class UITestFixtureReadersTests: XCTestCase {
		// MARK: Activation

		func testMakeReturnsNilWithoutEitherVariable() {
			XCTAssertNil(UITestFixtureReaders.make(environment: [:]))
			XCTAssertNil(UITestFixtureReaders.make(environment: ["TRACK1_UNRELATED": "{}"]))
		}

		func testMakeIsActiveWithEitherVariableAlone() {
			XCTAssertNotNil(UITestFixtureReaders.make(environment: ["TRACK1_UI_TEST_FIXTURES_JSON": "{}"]))
			XCTAssertNotNil(UITestFixtureReaders.make(environment: ["TRACK1_PROFILE_CATALOG_JSON": catalogJSON]))
		}

		// MARK: catalog

		func testCatalogDecodesTheProfileCatalogVariable() async throws {
			let readers = try makeReaders(catalog: catalogJSON)

			let catalog = try success(await readers.catalog())

			XCTAssertEqual(catalog.nodes.map(\.identity.rawValue), ["genre:jazz"])
		}

		func testCatalogFailsWithNetworkWhenTheVariableIsAbsent() async throws {
			let readers = try makeReaders(fixtures: "{}")

			assertFailure(await readers.catalog(), .network)
		}

		func testCatalogMalformedJSONIsInvalidResponse() async throws {
			let readers = try makeReaders(catalog: "{not json")

			assertFailure(await readers.catalog(), .invalidResponse)
		}

		// MARK: node

		func testKnownNodeSucceeds() async throws {
			let readers = try makeReaders(fixtures: fixturesJSON)

			let response = try success(await readers.node(identity("artist:x")))

			XCTAssertEqual(response.node.id.rawValue, "artist:x")
			XCTAssertEqual(response.node.name, "X")
		}

		func testUnavailableNodeIsA503() async throws {
			let readers = try makeReaders(fixtures: fixturesJSON)

			assertFailure(
				await readers.node(identity("artist:down")),
				.http(status: 503, code: "node_unavailable", retryable: true, retryAfterSeconds: nil)
			)
		}

		func testUnknownNodeIsA404() async throws {
			let readers = try makeReaders(fixtures: fixturesJSON)

			assertFailure(
				await readers.node(identity("artist:nobody")),
				.http(status: 404, code: "not_found", retryable: false, retryAfterSeconds: nil)
			)
		}

		func testNodeListedAsUnavailableIsA503EvenWhenItHasABody() async throws {
			let readers = try makeReaders(fixtures: #"{"nodes":{"artist:x":\#(nodeBody)},"unavailable":["artist:x"]}"#)

			assertFailure(
				await readers.node(identity("artist:x")),
				.http(status: 503, code: "node_unavailable", retryable: true, retryAfterSeconds: nil)
			)
		}

		func testNodeBodyThatFailsTheRealValidationIsInvalidResponse() async throws {
			// The identity prefix says "artist" but the body type says "genre": rejected by `NodeDetail`.
			let body = nodeBody.replacingOccurrences(of: #""type":"artist""#, with: #""type":"genre""#)
			let readers = try makeReaders(fixtures: #"{"nodes":{"artist:x":\#(body)}}"#)

			assertFailure(await readers.node(identity("artist:x")), .invalidResponse)
		}

		func testNodeEntryThatIsNotAnObjectIsInvalidResponse() async throws {
			let readers = try makeReaders(fixtures: #"{"nodes":{"artist:x":"oops"}}"#)

			assertFailure(await readers.node(identity("artist:x")), .invalidResponse)
		}

		// MARK: image

		func testImageIsAlways503() async throws {
			let expected = APIError.http(
				status: 503, code: "image_unavailable", retryable: true, retryAfterSeconds: nil)

			for environment in [
				["TRACK1_UI_TEST_FIXTURES_JSON": fixturesJSON],
				["TRACK1_PROFILE_CATALOG_JSON": catalogJSON],
				["TRACK1_UI_TEST_FIXTURES_JSON": "{not json"],
			] {
				let readers = try XCTUnwrap(UITestFixtureReaders.make(environment: environment))
				assertFailure(await readers.image(identity("artist:x")), expected)
			}
		}

		// MARK: links

		func testKnownLinksSucceed() async throws {
			let readers = try makeReaders(fixtures: fixturesJSON)

			let response = try success(await readers.links(identity("artist:x")))

			XCTAssertEqual(response.slug.rawValue, "artist:x")
			XCTAssertEqual(response.spotify?.host, "open.spotify.com")
		}

		func testUnknownLinksFailWithNetwork() async throws {
			let readers = try makeReaders(fixtures: fixturesJSON)

			assertFailure(await readers.links(identity("artist:nobody")), .network)
		}

		func testLinksBodyWithAnUnverifiedHostIsInvalidResponse() async throws {
			let body = linksBody.replacingOccurrences(of: "open.spotify.com", with: "evil.example")
			let readers = try makeReaders(fixtures: #"{"links":{"artist:x":\#(body)}}"#)

			assertFailure(await readers.links(identity("artist:x")), .invalidResponse)
		}

		// MARK: search

		func testKnownQuerySucceedsWithAllHitsWhenNoTypeIsGiven() async throws {
			let readers = try makeReaders(fixtures: fixturesJSON)

			let response = try success(await readers.search("jazz", nil))

			XCTAssertEqual(response.hits.map(\.name), ["Jazz", "Jazzy"])
		}

		func testKnownQueryFiltersHitsByType() async throws {
			let readers = try makeReaders(fixtures: fixturesJSON)

			let genres = try success(await readers.search("jazz", .genre))
			let labels = try success(await readers.search("jazz", .label))

			XCTAssertEqual(genres.hits.map(\.name), ["Jazz"])
			XCTAssertTrue(labels.hits.isEmpty)
		}

		func testQueryIsTrimmedAndLowercasedBeforeLookup() async throws {
			let readers = try makeReaders(fixtures: fixturesJSON)

			let response = try success(await readers.search("  JaZZ \n", nil))

			XCTAssertEqual(response.hits.count, 2)
		}

		func testFixtureKeysAreNormalisedLikeQueries() async throws {
			let readers = try makeReaders(fixtures: #"{"search":{" Jazz ":\#(searchBody)}}"#)

			let response = try success(await readers.search("jazz", nil))

			XCTAssertEqual(response.hits.count, 2)
		}

		func testUnknownQuerySucceedsWithZeroHits() async throws {
			let readers = try makeReaders(fixtures: fixturesJSON)

			let response = try success(await readers.search("  Nothing Here ", .artist))

			XCTAssertEqual(response.query, "nothing here")
			XCTAssertTrue(response.hits.isEmpty)
		}

		func testSearchBodyThatFailsTheRealValidationIsInvalidResponse() async throws {
			// A "cache" hit must carry a slug; this one does not.
			let body =
				#"{"q":"bad","hits":[{"source":"cache","type":"genre","name":"Bad"}],"sources":{"cache":1,"catalog":0}}"#
			let readers = try makeReaders(fixtures: #"{"search":{"bad":\#(body)}}"#)

			assertFailure(await readers.search("bad", nil), .invalidResponse)
		}

		// MARK: Malformed fixtures variable

		func testMalformedFixturesDocumentMakesEveryFixtureReaderInvalidResponse() async throws {
			let documents = ["{not json", "[]", #"{"nodes":[]}"#, #"{"unavailable":"artist:x"}"#, #"{"search":null}"#]
			for document in documents {
				let readers = try makeReaders(fixtures: document)

				assertFailure(await readers.node(identity("artist:x")), .invalidResponse, document)
				assertFailure(await readers.links(identity("artist:x")), .invalidResponse, document)
				assertFailure(await readers.search("jazz", nil), .invalidResponse, document)
			}
		}

		// MARK: Catalog variable alone

		func testCatalogVariableAloneAnswersTheDocumentedMissCases() async throws {
			let readers = try makeReaders(catalog: catalogJSON)

			assertFailure(
				await readers.node(identity("artist:x")),
				.http(status: 404, code: "not_found", retryable: false, retryAfterSeconds: nil)
			)
			assertFailure(await readers.links(identity("artist:x")), .network)
			let search = try success(await readers.search("jazz", nil))
			XCTAssertTrue(search.hits.isEmpty)
		}
	}

	// MARK: Fixtures

	private let catalogJSON = """
		{"version":"v1","revision":"sha256:\(String(repeating: "a", count: 64))",
		"taxonomy":{"mode":"degraded","available":false},
		"nodes":[{"identity":"genre:jazz","type":"genre","name":"Jazz","teaser":null}],"edges":[]}
		"""

	private let nodeBody = """
		{"node":{"id":"artist:x","type":"artist","name":"X","teaser":null,"article":"Article.","citations":[],
		"facts":{},"edges":{},"materialized_at":"2026-01-01T00:00:00Z","image_url":null},"source":"cache"}
		"""

	private let linksBody = """
		{"slug":"artist:x","spotify":"https://open.spotify.com/artist/x","apple":null,"sources":{},
		"resolvedAt":"2026-01-01T00:00:00Z"}
		"""

	private let searchBody = """
		{"q":"jazz","hits":[
		{"source":"cache","type":"genre","name":"Jazz","slug":"genre:jazz"},
		{"source":"cache","type":"artist","name":"Jazzy","slug":"artist:jazzy"}],
		"sources":{"cache":2,"catalog":0}}
		"""

	private let fixturesJSON = """
		{"nodes":{"artist:x":\(nodeBody)},"unavailable":["artist:down"],
		"links":{"artist:x":\(linksBody)},"search":{"jazz":\(searchBody)}}
		"""

	// MARK: Helpers

	private func makeReaders(fixtures: String? = nil, catalog: String? = nil) throws -> ContentReaders {
		var environment: [String: String] = [:]
		if let fixtures { environment["TRACK1_UI_TEST_FIXTURES_JSON"] = fixtures }
		if let catalog { environment["TRACK1_PROFILE_CATALOG_JSON"] = catalog }
		return try XCTUnwrap(UITestFixtureReaders.make(environment: environment))
	}

	private func identity(_ rawValue: String) -> NodeIdentity {
		guard let identity = NodeIdentity(rawValue: rawValue) else {
			preconditionFailure("Invalid node identity in test fixture: \(rawValue)")
		}
		return identity
	}

	private func failure<Value: Sendable>(_ result: APIResult<Value>) -> APIError? {
		guard case .failure(let error) = result else { return nil }
		return error
	}

	// `await` cannot sit inside XCTest assertion autoclosures, so callers await first and pass the result.
	private func assertFailure<Value: Sendable>(
		_ result: APIResult<Value>, _ expected: APIError, _ message: String = "",
		file: StaticString = #filePath, line: UInt = #line
	) {
		XCTAssertEqual(failure(result), expected, message, file: file, line: line)
	}

	private func success<Value: Sendable>(
		_ result: APIResult<Value>, file: StaticString = #filePath, line: UInt = #line
	) throws -> Value {
		try XCTUnwrap(result.value, file: file, line: line)
	}
#endif
