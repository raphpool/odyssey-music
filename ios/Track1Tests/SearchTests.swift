import XCTest

@testable import Track1

@MainActor
final class SearchTests: XCTestCase {
	// MARK: - Input rules

	func testInvalidInputsNeverCallTheServer() async throws {
		let emoji = String(repeating: "\u{1F600}", count: 61)  // 61 graphemes, 122 UTF-16 units
		let cases: [(input: String, phase: SearchPhase)] = [
			("   ", .idle),
			(" a ", .tooShort),
			(String(repeating: "a", count: 121), .tooLong),
			(emoji, .tooLong),
		]
		for (input, expected) in cases {
			let fixture = Fixture()
			fixture.model.query = input
			await fixture.waitForSleeps(1)
			XCTAssertEqual(fixture.model.phase, .idle, "The delay has not elapsed yet.")
			await fixture.clock.releaseAll()
			await eventually("phase \(expected)") { fixture.model.phase == expected || expected == .idle }
			await settle()

			XCTAssertEqual(fixture.model.phase, expected)
			XCTAssertTrue(fixture.model.hits.isEmpty)
			let calls = await fixture.backend.calls
			XCTAssertTrue(calls.isEmpty, "\(expected) must not reach the server.")
			XCTAssertTrue(fixture.recorder.events.isEmpty)
		}
	}

	func testTrimmedQueryIsSentAndLengthIsMeasuredInUTF16Units() async throws {
		let boundary = String(repeating: "\u{1F600}", count: 60)  // 60 graphemes, exactly 120 UTF-16 units
		for (input, sent) in [(" ab ", "ab"), ("\u{1F600}", "\u{1F600}"), (boundary, boundary)] {
			let fixture = Fixture()
			fixture.model.query = input
			await fixture.waitForSleeps(1)
			await fixture.clock.releaseAll()
			await fixture.waitForCalls(1)

			let calls = await fixture.backend.calls
			XCTAssertEqual(calls, [SearchCall(query: sent, type: nil)])
			XCTAssertEqual(fixture.model.phase, .loading)
		}
	}

	func testChangesBeforeTheDeadlineSendASingleRequest() async throws {
		let fixture = Fixture()

		fixture.model.query = "ab"
		fixture.model.query = "abc"
		fixture.model.query = "abcd"
		await fixture.waitForSleeps(3)
		let beforeDeadline = await fixture.backend.calls
		XCTAssertTrue(beforeDeadline.isEmpty)
		XCTAssertTrue(fixture.recorder.events.isEmpty)

		await fixture.clock.releaseAll()
		await fixture.waitForCalls(1)
		await settle()

		let calls = await fixture.backend.calls
		XCTAssertEqual(calls, [SearchCall(query: "abcd", type: nil)])
		XCTAssertEqual(fixture.recorder.events.map(\.name), [.searchSubmitted])
		let durations = await fixture.clock.durations
		XCTAssertEqual(durations, Array(repeating: .milliseconds(300), count: 3))
	}

	// MARK: - Ordering

	func testResponseOfAnOlderQueryArrivingLastIsNeverApplied() async throws {
		let fixture = Fixture()
		try await fixture.submit("abc")
		try await fixture.submit("abcd")

		await fixture.backend.respond(at: 1, with: try Self.success(names: ["Fresh"]))
		await eventually("results") { fixture.model.phase == .results }
		await fixture.backend.respond(at: 0, with: try Self.success(names: ["Stale"]))
		await settle()

		XCTAssertEqual(fixture.model.phase, .results)
		XCTAssertEqual(fixture.model.hits.map(\.name), ["Fresh"])
	}

	func testResponseOfAnOlderQueryArrivingFirstIsNeverApplied() async throws {
		let fixture = Fixture()
		try await fixture.submit("abc")
		try await fixture.submit("abcd")

		await fixture.backend.respond(at: 0, with: try Self.success(names: ["Stale"]))
		await settle()
		XCTAssertEqual(fixture.model.phase, .loading)
		XCTAssertTrue(fixture.model.hits.isEmpty)

		await fixture.backend.respond(at: 1, with: try Self.success(names: ["Fresh"]))
		await eventually("results") { fixture.model.phase == .results }
		XCTAssertEqual(fixture.model.hits.map(\.name), ["Fresh"])
	}

	func testResponseArrivingAfterTheQueryBecameInvalidIsNeverApplied() async throws {
		let fixture = Fixture()
		try await fixture.submit("abc")

		fixture.model.query = "a"
		await fixture.waitForSleeps(2)
		await fixture.clock.releaseAll()
		await eventually("too short") { fixture.model.phase == .tooShort }
		await fixture.backend.respond(at: 0, with: try Self.success(names: ["Stale"]))
		await settle()

		XCTAssertEqual(fixture.model.phase, .tooShort)
		XCTAssertTrue(fixture.model.hits.isEmpty)
	}

	func testEmptyAnswerEndsInEmptyAndClearingTheQueryEndsInIdle() async throws {
		let fixture = Fixture()
		try await fixture.submit("zzz")
		await fixture.backend.respond(at: 0, with: try Self.success(names: []))
		await eventually("empty") { fixture.model.phase == .empty }

		try await fixture.submit("abc")
		await fixture.backend.respond(at: 1, with: try Self.success(names: ["Found"]))
		await eventually("results") { fixture.model.phase == .results }

		fixture.model.query = ""
		await fixture.waitForSleeps(3)
		await fixture.clock.releaseAll()
		await eventually("idle") { fixture.model.phase == .idle }
		XCTAssertTrue(fixture.model.hits.isEmpty)
	}

	// MARK: - Filter

	func testFilterChangeReplaysTheSearchWithItsTypeAndAllSendsNone() async throws {
		let fixture = Fixture()
		try await fixture.submit("massive")
		await fixture.backend.respond(at: 0, with: try Self.success(names: ["A"]))
		await eventually("results") { fixture.model.phase == .results }

		fixture.model.filter = .artist
		await fixture.waitForSleeps(2)
		await fixture.clock.releaseAll()
		await fixture.waitForCalls(2)
		await fixture.backend.respond(at: 1, with: try Self.success(names: ["B"]))
		await eventually("filtered results") { fixture.model.hits.map(\.name) == ["B"] }

		fixture.model.filter = .all
		await fixture.waitForSleeps(3)
		await fixture.clock.releaseAll()
		await fixture.waitForCalls(3)

		let calls = await fixture.backend.calls
		XCTAssertEqual(
			calls.map(\.type), [nil, .artist, nil], "`.all` must omit the type instead of sending one.")
		XCTAssertEqual(calls.map(\.query), ["massive", "massive", "massive"])
		let filters = fixture.recorder.events.map { $0.properties["filter"] }
		XCTAssertEqual(filters, [.string("all"), .string("artist"), .string("all")])
	}

	func testEveryFilterMapsToItsTypeAndIsAcceptedByAnalytics() {
		XCTAssertEqual(SearchFilter.allCases.map(\.nodeType), [nil] + NodeType.allCases.map { Optional($0) })
		for filter in SearchFilter.allCases {
			let event = AnalyticsEvent(
				name: .searchSubmitted, properties: ["filter": .string(filter.rawValue)], source: .search)
			XCTAssertTrue(AnalyticsValidation.accepts(event), filter.rawValue)
		}
	}

	// MARK: - Retry

	func testRetryAfterAFailureReplaysTheRequestWithoutWaiting() async throws {
		let fixture = Fixture()
		try await fixture.submit("abc")
		await fixture.backend.respond(at: 0, with: .failure(.network))
		await eventually("failed") { fixture.model.phase == .failed }
		XCTAssertTrue(fixture.model.hits.isEmpty)

		fixture.model.retry()
		await fixture.waitForCalls(2)
		XCTAssertEqual(fixture.model.phase, .loading)
		await fixture.backend.respond(at: 1, with: try Self.success(names: ["Back"]))
		await eventually("results") { fixture.model.phase == .results }

		let calls = await fixture.backend.calls
		XCTAssertEqual(calls, [SearchCall(query: "abc", type: nil), SearchCall(query: "abc", type: nil)])
		let sleeps = await fixture.clock.durations.count
		XCTAssertEqual(sleeps, 1, "A retry does not go through the delay.")
		XCTAssertEqual(fixture.recorder.events.map(\.name), [.searchSubmitted, .searchSubmitted])
	}

	func testRetryYieldsToANewerInputStillWaiting() async throws {
		let fixture = Fixture()
		try await fixture.submit("abc")
		await fixture.backend.respond(at: 0, with: .failure(.network))
		await eventually("failed") { fixture.model.phase == .failed }

		fixture.model.query = "abcd"
		await fixture.waitForSleeps(2)
		fixture.model.retry()
		await fixture.clock.releaseAll()
		await fixture.waitForCalls(2)
		await settle()

		let calls = await fixture.backend.calls
		XCTAssertEqual(calls.map(\.query), ["abc", "abcd"], "The retry must not replace the newer query.")
	}

	func testRetryDoesNothingWithoutAValidRequest() async throws {
		let fixture = Fixture()
		fixture.model.retry()
		fixture.model.query = "a"
		await fixture.waitForSleeps(1)
		await fixture.clock.releaseAll()
		await eventually("too short") { fixture.model.phase == .tooShort }
		fixture.model.retry()
		await settle()

		let calls = await fixture.backend.calls
		XCTAssertTrue(calls.isEmpty)
	}

	// MARK: - Opening a result

	func testOpeningACachedHitReturnsItsNodeAndRecordsTheExactEvent() async throws {
		let fixture = Fixture()
		try await fixture.submit("massive attack")
		await fixture.backend.respond(
			at: 0,
			with: try Self.success(hits: [
				Self.hit(source: "cache", type: "artist", name: "Massive Attack", slug: "artist:massive-attack"),
				Self.hit(source: "catalog", type: "project", name: "Mezzanine"),
			]))
		await eventually("results") { fixture.model.phase == .results }
		let cached = try XCTUnwrap(fixture.model.hits.first)
		let before = await fixture.backend.calls.count

		let opening = fixture.model.open(cached)

		let identity = try XCTUnwrap(NodeIdentity(rawValue: "artist:massive-attack"))
		XCTAssertEqual(opening, .node(identity, .independent(source: .search)))
		let event = try XCTUnwrap(fixture.recorder.events.last)
		XCTAssertEqual(event.name, .searchResultOpened)
		XCTAssertEqual(event.source, .search)
		XCTAssertEqual(
			event.properties,
			[
				"node_type": .string("artist"),
				"availability": .string("cached"),
				"results_count": .integer(2),
				"node_id": .string("artist:massive-attack"),
			])
		XCTAssertTrue(AnalyticsValidation.accepts(event))
		XCTAssertFalse(event.properties.values.contains(.string("massive attack")))
		let after = await fixture.backend.calls.count
		XCTAssertEqual(after, before, "Opening a result is not a network request.")
	}

	func testOpeningACatalogHitReturnsMissingWithoutANodeID() async throws {
		let fixture = Fixture()
		try await fixture.submit("mezzanine")
		await fixture.backend.respond(
			at: 0,
			with: try Self.success(hits: [
				Self.hit(source: "catalog", type: "project", name: "Mezzanine"),
				Self.hit(source: "catalog", type: "track", name: "Teardrop", slug: "track:teardrop"),
			]))
		await eventually("results") { fixture.model.phase == .results }
		let calls = await fixture.backend.calls.count

		for (index, expectedType) in [(0, NodeType.project), (1, .track)] {
			let hit = fixture.model.hits[index]
			XCTAssertEqual(fixture.model.open(hit), .missing(name: hit.name, type: expectedType))
			let event = try XCTUnwrap(fixture.recorder.events.last)
			XCTAssertEqual(event.name, .searchResultOpened)
			XCTAssertEqual(
				event.properties,
				[
					"node_type": .string(expectedType.rawValue),
					"availability": .string("missing"),
					"results_count": .integer(2),
				])
			XCTAssertTrue(AnalyticsValidation.accepts(event))
			XCTAssertFalse(event.properties.values.contains(.string("mezzanine")))
		}
		let after = await fixture.backend.calls.count
		XCTAssertEqual(after, calls)
	}

	// MARK: - Helpers

	private static func hit(
		source: String, type: String, name: String, slug: String? = nil
	) throws -> SearchHit {
		let slugField = slug.map { ",\"slug\":\"\($0)\"" } ?? ""
		let json = "{\"source\":\"\(source)\",\"type\":\"\(type)\",\"name\":\"\(name)\"\(slugField)}"
		return try JSONDecoder().decode(SearchHit.self, from: Data(json.utf8))
	}

	private static func success(hits: [SearchHit]) throws -> APIResult<SearchResponse> {
		let cache = hits.filter { $0.source == "cache" }.count
		let json = "{\"q\":\"x\",\"hits\":[],\"sources\":{\"cache\":\(cache),\"catalog\":\(hits.count - cache)}}"
		let base = try JSONDecoder().decode(SearchResponse.self, from: Data(json.utf8))
		return .success(SearchResponse(query: base.query, hits: hits, sources: base.sources), etag: nil)
	}

	private static func success(names: [String]) throws -> APIResult<SearchResponse> {
		try success(hits: names.map { try hit(source: "catalog", type: "artist", name: $0) })
	}

	/// Lets already-resumed tasks run, to assert that something did *not* happen.
	private func settle() async {
		for _ in 0..<100 { await Task.yield() }
	}

	private func eventually(
		_ description: String, file: StaticString = #filePath, line: UInt = #line,
		_ condition: @MainActor () async -> Bool
	) async {
		for attempt in 0..<3000 {
			if await condition() { return }
			if attempt < 100 { await Task.yield() } else { try? await Task.sleep(for: .milliseconds(1)) }
		}
		XCTFail("Timed out waiting for \(description).", file: file, line: line)
	}
}

private struct SearchCall: Equatable, Sendable {
	let query: String
	let type: NodeType?
}

/// Stands in for `Task.sleep`: every sleeper stays suspended until the test releases it, so no real
/// time passes. Like the real one, a cancelled sleeper throws.
private actor DebounceClock {
	private var waiting: [Int: CheckedContinuation<Void, Error>] = [:]
	private(set) var durations: [Duration] = []

	func sleep(for duration: Duration) async throws {
		let id = durations.count
		durations.append(duration)
		try await withTaskCancellationHandler {
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
				if Task.isCancelled {
					continuation.resume(throwing: CancellationError())
				} else {
					waiting[id] = continuation
				}
			}
		} onCancel: {
			Task { await self.cancel(id) }
		}
	}

	func releaseAll() {
		let sleepers = waiting
		waiting = [:]
		for continuation in sleepers.values { continuation.resume() }
	}

	private func cancel(_ id: Int) {
		waiting.removeValue(forKey: id)?.resume(throwing: CancellationError())
	}
}

/// Stands in for the network: each call is recorded, then suspended until the test answers it. It
/// ignores cancellation on purpose, as a transport that already sent its request would.
private actor SearchBackend {
	private(set) var calls: [SearchCall] = []
	private var answers: [Int: CheckedContinuation<APIResult<SearchResponse>, Never>] = [:]

	func search(_ query: String, _ type: NodeType?) async -> APIResult<SearchResponse> {
		let id = calls.count
		calls.append(SearchCall(query: query, type: type))
		return await withCheckedContinuation { answers[id] = $0 }
	}

	func respond(at index: Int, with result: APIResult<SearchResponse>) {
		answers.removeValue(forKey: index)?.resume(returning: result)
	}
}

@MainActor
private final class Recorder {
	private(set) var events = [AnalyticsEvent]()
	var record: NodeEventRecorder { { [self] event in events.append(event) } }
}

@MainActor
private final class Fixture {
	let clock = DebounceClock()
	let backend = SearchBackend()
	let recorder = Recorder()
	let model: SearchViewModel

	init() {
		let clock = clock
		let backend = backend
		model = SearchViewModel(
			search: { await backend.search($0, $1) },
			sleep: { try await clock.sleep(for: $0) },
			recordEvent: recorder.record
		)
	}

	/// Types a query, lets the delay elapse and waits for the request it triggers.
	func submit(_ text: String) async throws {
		let before = await clock.durations.count
		let callsBefore = await backend.calls.count
		model.query = text
		await waitForSleeps(before + 1)
		await clock.releaseAll()
		await waitForCalls(callsBefore + 1)
	}

	func waitForSleeps(_ count: Int, file: StaticString = #filePath, line: UInt = #line) async {
		for attempt in 0..<3000 {
			if await clock.durations.count >= count { return }
			if attempt < 100 { await Task.yield() } else { try? await Task.sleep(for: .milliseconds(1)) }
		}
		XCTFail("Timed out waiting for \(count) sleeps.", file: file, line: line)
	}

	func waitForCalls(_ count: Int, file: StaticString = #filePath, line: UInt = #line) async {
		for attempt in 0..<3000 {
			if await backend.calls.count >= count { return }
			if attempt < 100 { await Task.yield() } else { try? await Task.sleep(for: .milliseconds(1)) }
		}
		XCTFail("Timed out waiting for \(count) calls.", file: file, line: line)
	}
}
