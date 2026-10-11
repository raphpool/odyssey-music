import Foundation
import XCTest

@testable import Track1

@MainActor
final class TodayViewModelTests: XCTestCase {
	private static let fileName = "daily-recommendation.v1.json"
	private static let localID = UUID(uuidString: "5B1D3F0A-0000-4000-8000-0000000000AA")!
	private static let revisionHash = "sha256:" + String(repeating: "0123456789abcdef", count: 4)

	// XCTest builds one instance per test method, so these start fresh without a main-actor `setUp`, whose
	// isolation differs between SDKs.
	private nonisolated let directoryURL = FileManager.default.temporaryDirectory.appending(
		path: UUID().uuidString,
		directoryHint: .isDirectory
	)
	private var events: [AnalyticsEvent] = []
	private var nextID = 0

	override func tearDownWithError() throws {
		try? FileManager.default.removeItem(at: directoryURL)
	}

	// MARK: Same date, same revision

	func testSameDateAndRevisionGiveTheSameRecommendationOnRecreatedInstancesWithOneCatalogRead() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let first = makeModel(probe: probe, store: makeStore())
		await first.load(for: try profile(revision: 1))
		let created = try recommendation(of: first)

		let second = makeModel(probe: probe, store: makeStore())
		await second.load(for: try profile(revision: 1))

		XCTAssertEqual(try recommendation(of: second).recommendationID, created.recommendationID)
		XCTAssertEqual(try recommendation(of: second), created)
		let reads = await probe.calls
		XCTAssertEqual(reads, 1)
	}

	func testTheSameInstanceLoadedTwiceKeepsTheRecommendationAndOneEntry() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let store = makeStore()
		let model = makeModel(probe: probe, store: store)
		await model.load(for: try profile(revision: 1))
		let created = try recommendation(of: model)
		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(try recommendation(of: model), created)
		let history = await store.history()
		XCTAssertEqual(history, [created])
	}

	// MARK: Catalog failure

	func testCatalogFailureIsUnavailableWithoutAPersistedEntry() async throws {
		let probe = CatalogProbe(result: .failure(.network))
		let store = makeStore()
		let model = makeModel(probe: probe, store: store)
		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(model.state, .unavailable)
		let history = await store.history()
		XCTAssertEqual(history, [])
	}

	func testNotModifiedWithoutABodyIsUnavailable() async throws {
		let model = makeModel(probe: CatalogProbe(result: .notModified(etag: "x")), store: makeStore())
		await model.load(for: try profile(revision: 1))
		XCTAssertEqual(model.state, .unavailable)
	}

	func testPersistedRecommendationSurvivesACatalogOutageWithoutReadingTheCatalog() async throws {
		let seeded = makeModel(
			probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: makeStore())
		await seeded.load(for: try profile(revision: 1))
		let created = try recommendation(of: seeded)

		let offline = CatalogProbe(result: .failure(.network))
		let model = makeModel(probe: offline, store: makeStore())
		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(model.state, .recommendation(created))
		let reads = await offline.calls
		XCTAssertEqual(reads, 0)
	}

	// MARK: Revision change

	func testChangedRevisionTheSameDayCreatesANewIDAndKeepsOneEntryForTheDate() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let store = makeStore()
		let model = makeModel(probe: probe, store: store)
		await model.load(for: try profile(revision: 1))
		let first = try recommendation(of: model)

		await model.load(for: try profile(revision: 2))
		let second = try recommendation(of: model)

		XCTAssertNotEqual(second.recommendationID, first.recommendationID)
		XCTAssertEqual(second.profileRevision, 2)
		let history = await store.history()
		XCTAssertEqual(history, [second])
		XCTAssertEqual(history.filter { $0.localDate == Self.parisDate }.count, 1)
	}

	func testRevisionChangeKeepsOtherDaysAndMovesTheDayToTheEnd() async throws {
		let store = makeStore()
		let earlier = try storedRecommendation(date: "2026-10-09", node: "artist:alpha", revision: 1)
		let sameDay = try storedRecommendation(date: Self.parisDate, node: "artist:beta", revision: 1)
		_ = await store.save([sameDay, earlier])
		let model = makeModel(
			probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: store)

		await model.load(for: try profile(revision: 2))

		let history = await store.history()
		XCTAssertEqual(history.map(\.localDate), ["2026-10-09", Self.parisDate])
		XCTAssertEqual(history.first, earlier)
		XCTAssertEqual(history.last, try recommendation(of: model))
	}

	// MARK: Empty catalog and write failure

	func testNoCandidateIsEmptyCatalogAndWritesNothing() async throws {
		let bare = try catalog(nodes: [("genre:rock", "Rock")], edges: [])
		let store = makeStore()
		let model = makeModel(probe: CatalogProbe(result: .success(bare, etag: nil)), store: store)
		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(model.state, .emptyCatalog)
		let history = await store.history()
		XCTAssertEqual(history, [])
	}

	func testFailedWriteIsUnavailableAndExposesNothing() async throws {
		let store = DailyRecommendationStore(
			localStore: LocalStore(directoryURL: directoryURL, failNextWriteNamed: Self.fileName))
		let model = makeModel(
			probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: store)
		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(model.state, .unavailable)
		let history = await store.history()
		XCTAssertEqual(history, [])
	}

	func testFailedWriteAfterARevisionChangeNoLongerExposesThePreviousRecommendation() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let seed = makeModel(probe: probe, store: makeStore())
		await seed.load(for: try profile(revision: 1))
		let previous = try recommendation(of: seed)

		let failing = DailyRecommendationStore(
			localStore: LocalStore(directoryURL: directoryURL, failNextWriteNamed: Self.fileName))
		let model = makeModel(probe: probe, store: failing)
		await model.load(for: try profile(revision: 2))

		XCTAssertEqual(model.state, .unavailable)
		let history = await failing.history()
		XCTAssertEqual(history, [previous])
	}

	func testAProfileWhoseRevisionCannotBeStoredIsUnavailable() async throws {
		let model = makeModel(
			probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: makeStore())
		await model.load(for: try profile(revision: 0))
		XCTAssertEqual(model.state, .unavailable)
	}

	// MARK: Events

	func testImpressionIsRecordedOnceAcrossCallsAndAfterARestart() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let model = makeModel(probe: probe, store: makeStore())
		await model.load(for: try profile(revision: 1))
		await model.recordImpressionIfNeeded()
		await model.recordImpressionIfNeeded()

		XCTAssertEqual(events.map(\.name), [.dailyRecommendationViewed])
		let viewed = try recommendation(of: model)
		XCTAssertTrue(viewed.viewRecorded)

		let restarted = makeModel(probe: probe, store: makeStore())
		await restarted.load(for: try profile(revision: 1))
		await restarted.recordImpressionIfNeeded()

		XCTAssertEqual(events.map(\.name), [.dailyRecommendationViewed])
		XCTAssertEqual(try recommendation(of: restarted), viewed)
		let history = await makeStore().history()
		XCTAssertEqual(history, [viewed])
	}

	func testImpressionMarkerIsPersistedEvenWithoutAnAnalyticsRecorder() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let silent = TodayViewModel(
			readCatalog: { await probe.read() }, store: makeStore(), now: { Self.clock },
			timeZone: { Self.paris }, makeID: makeID, recordEvent: nil)
		await silent.load(for: try profile(revision: 1))
		await silent.recordImpressionIfNeeded()

		let restarted = makeModel(probe: probe, store: makeStore())
		await restarted.load(for: try profile(revision: 1))
		await restarted.recordImpressionIfNeeded()

		XCTAssertEqual(events, [])
		XCTAssertTrue(try recommendation(of: restarted).viewRecorded)
	}

	func testAFailedMarkerWriteDoesNotLetTheSameSessionEmitTheEventAgain() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let seed = makeModel(probe: probe, store: makeStore())
		await seed.load(for: try profile(revision: 1))

		// This store's first write is the marker, because `load` finds the persisted entry and writes nothing.
		let failing = DailyRecommendationStore(
			localStore: LocalStore(directoryURL: directoryURL, failNextWriteNamed: Self.fileName))
		let model = makeModel(probe: probe, store: failing)
		await model.load(for: try profile(revision: 1))
		await model.recordImpressionIfNeeded()
		await model.load(for: try profile(revision: 1))
		await model.recordImpressionIfNeeded()

		XCTAssertEqual(events.map(\.name), [.dailyRecommendationViewed])
	}

	func testImpressionWithoutARecommendationDoesNothing() async {
		let model = makeModel(probe: CatalogProbe(result: .failure(.network)), store: makeStore())
		await model.recordImpressionIfNeeded()
		XCTAssertEqual(events, [])
		XCTAssertEqual(model.state, .loading)
	}

	func testDiscoverEmitsOneOpenedEventPerCallAndReturnsTheNodeAndHomeContext() async throws {
		let model = makeModel(
			probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: makeStore())
		await model.load(for: try profile(revision: 1))
		let current = try recommendation(of: model)

		let first = await model.discover()
		let second = await model.discover()

		XCTAssertEqual(first?.identity, current.nodeID)
		XCTAssertEqual(first?.context, NavigationContext(source: .home, recommendationID: current.recommendationID))
		XCTAssertEqual(second?.identity, current.nodeID)
		XCTAssertEqual(events.map(\.name), [.dailyRecommendationOpened, .dailyRecommendationOpened])
	}

	func testDiscoverWithoutARecommendationReturnsNilAndEmitsNothing() async throws {
		let model = makeModel(probe: CatalogProbe(result: .failure(.network)), store: makeStore())
		await model.load(for: try profile(revision: 1))
		let result = await model.discover()
		XCTAssertNil(result)
		XCTAssertEqual(events, [])
	}

	func testEventsCarryLowercaseIDsTheLocalDateAndTheHomeSourceAndAreAccepted() async throws {
		let model = makeModel(
			probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: makeStore())
		await model.load(for: try profile(revision: 1))
		await model.recordImpressionIfNeeded()
		_ = await model.discover()
		let current = try recommendation(of: model)

		XCTAssertEqual(events.map(\.name), [.dailyRecommendationViewed, .dailyRecommendationOpened])
		for event in events {
			XCTAssertEqual(event.source, .home)
			XCTAssertEqual(event.occurredAt, Self.clock)
			XCTAssertEqual(
				event.properties,
				[
					"recommendation_id": .string(current.recommendationID.uuidString.lowercased()),
					"local_date": .string(Self.parisDate),
					"node_id": .string(current.nodeID.rawValue),
					"node_type": .string(current.nodeType.rawValue),
				])
			XCTAssertTrue(AnalyticsValidation.accepts(event))
		}
		let recommendationID = try XCTUnwrap(events.first?.properties["recommendation_id"])
		guard case .string(let text) = recommendationID else { return XCTFail("Expected a string.") }
		XCTAssertEqual(text, text.lowercased())
		XCTAssertNotEqual(text, current.recommendationID.uuidString)
	}

	// MARK: Local date

	func testTheLocalDateFollowsTheInjectedTimeZone() async throws {
		// 2026-10-10T23:30Z is already 2026-10-11 in Paris (UTC+2) and still 2026-10-10 in UTC.
		XCTAssertEqual(Self.clock, ISO8601DateFormatter().date(from: "2026-10-10T23:30:00Z"))
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let paris = makeModel(probe: probe, store: makeStore())
		await paris.load(for: try profile(revision: 1))
		XCTAssertEqual(try recommendation(of: paris).localDate, "2026-10-11")

		let utc = TodayViewModel(
			readCatalog: { await probe.read() },
			store: DailyRecommendationStore(
				localStore: LocalStore(directoryURL: directoryURL.appending(path: "utc"))),
			now: { Self.clock }, timeZone: { TimeZone(identifier: "UTC")! }, makeID: makeID)
		await utc.load(for: try profile(revision: 1))
		XCTAssertEqual(try recommendation(of: utc).localDate, "2026-10-10")
	}

	// MARK: Concurrency

	func testAMarkViewedLandingDuringTheCatalogReadIsNotOverwrittenByTheSave() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let store = makeStore()
		let yesterday = try storedRecommendation(date: "2026-10-10", node: "artist:alpha", revision: 1)
		_ = await store.save([yesterday])
		// Fires while `load` holds its first snapshot of the history, before it saves.
		await probe.onRead { _ = await store.markViewed(yesterday.recommendationID) }
		let model = makeModel(probe: probe, store: store)

		await model.load(for: try profile(revision: 1))

		let history = await store.history()
		XCTAssertEqual(history.count, 2)
		XCTAssertEqual(history.first?.recommendationID, yesterday.recommendationID)
		XCTAssertEqual(history.first?.viewRecorded, true)
		XCTAssertEqual(history.last, try recommendation(of: model))
	}

	func testTwoParallelLoadsForTheSameProfileReadTheCatalogOnceAndAgree() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let store = makeStore()
		let model = makeModel(probe: probe, store: store)
		let taste = try profile(revision: 1)

		async let first: Void = model.load(for: taste)
		async let second: Void = model.load(for: taste)
		_ = await (first, second)

		let reads = await probe.calls
		XCTAssertEqual(reads, 1)
		let history = await store.history()
		XCTAssertEqual(history, [try recommendation(of: model)])
	}

	func testALoadSupersededByNewTastesPublishesAndSavesNothing() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let store = makeStore()
		let model = makeModel(probe: probe, store: store)
		await probe.blockNextRead()

		let oldTastes = try profile(revision: 1)
		let newTastes = try profile(revision: 2)
		let stale = Task { await model.load(for: oldTastes) }
		try await waitForCatalogReads(probe, count: 1)
		let current = Task { await model.load(for: newTastes) }
		// Let the second request register before the first one resumes.
		try await Task.sleep(for: .milliseconds(50))
		await probe.releaseBlockedRead()
		await stale.value
		await current.value

		let published = try recommendation(of: model)
		XCTAssertEqual(published.profileRevision, 2)
		let history = await store.history()
		XCTAssertEqual(history, [published])
		let reads = await probe.calls
		XCTAssertEqual(reads, 2)
	}

	func testAnImpressionRequestedDuringALoadWaitsForItAndMarksWhatIsExposed() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let store = makeStore()
		let model = makeModel(probe: probe, store: store)
		await model.load(for: try profile(revision: 1))
		let previous = try recommendation(of: model)

		await probe.blockNextRead()
		let newTastes = try profile(revision: 2)
		let reload = Task { await model.load(for: newTastes) }
		try await waitForCatalogReads(probe, count: 2)
		let impression = Task { await model.recordImpressionIfNeeded() }
		try await Task.sleep(for: .milliseconds(50))
		await probe.releaseBlockedRead()
		await reload.value
		await impression.value

		let exposed = try recommendation(of: model)
		XCTAssertNotEqual(exposed.recommendationID, previous.recommendationID)
		XCTAssertTrue(exposed.viewRecorded)
		let history = await store.history()
		XCTAssertEqual(history, [exposed])
		XCTAssertEqual(events.count, 1)
		XCTAssertEqual(
			events.first?.properties["recommendation_id"],
			.string(exposed.recommendationID.uuidString.lowercased()))
	}

	func testTwoParallelImpressionsEmitOneEvent() async throws {
		let model = makeModel(
			probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: makeStore())
		await model.load(for: try profile(revision: 1))

		async let first: Void = model.recordImpressionIfNeeded()
		async let second: Void = model.recordImpressionIfNeeded()
		_ = await (first, second)

		XCTAssertEqual(events.map(\.name), [.dailyRecommendationViewed])
	}

	// MARK: Helpers

	private static let clock = Date(timeIntervalSince1970: 1_791_675_000)  // 2026-10-10T23:30:00Z
	private static let paris = TimeZone(identifier: "Europe/Paris")!
	private static let parisDate = "2026-10-11"

	private func makeStore() -> DailyRecommendationStore {
		DailyRecommendationStore(localStore: LocalStore(directoryURL: directoryURL))
	}

	private func makeID() -> UUID {
		nextID += 1
		return UUID(uuidString: String(format: "AAAAAAAA-0000-4000-8000-%012X", nextID))!
	}

	private func makeModel(probe: CatalogProbe, store: DailyRecommendationStore) -> TodayViewModel {
		TodayViewModel(
			readCatalog: { await probe.read() },
			store: store,
			now: { Self.clock },
			timeZone: { Self.paris },
			makeID: { [unowned self] in makeID() },
			recordEvent: { [unowned self] in events.append($0) })
	}

	private func recommendation(of model: TodayViewModel) throws -> DailyRecommendation {
		guard case .recommendation(let recommendation) = model.state else {
			XCTFail("Expected a recommendation, got \(model.state).")
			throw UnexpectedState()
		}
		return recommendation
	}

	private func profile(revision: Int) throws -> Profile {
		let genre = try XCTUnwrap(NodeIdentity(rawValue: "genre:rock"))
		let json: [String: Any] = [
			"version": 1, "local_id": Self.localID.uuidString, "genre_ids": [genre.rawValue],
			"revision": revision, "onboarding_completed": true,
			"flow_id": "5B1D3F0A-0000-4000-8000-0000000000BB",
		]
		return try JSONDecoder().decode(Profile.self, from: JSONSerialization.data(withJSONObject: json))
	}

	private func storedRecommendation(date: String, node: String, revision: Int) throws -> DailyRecommendation {
		let identity = try XCTUnwrap(NodeIdentity(rawValue: node))
		return DailyRecommendation(
			recommendationID: makeID(), localDate: date, profileRevision: revision, nodeID: identity,
			nodeType: identity.type, name: node, teaser: nil, reasons: [], viewRecorded: false)
	}

	/// Three recommendable works linked to the single genre of `profile(revision:)`.
	private func catalog(
		nodes: [(String, String)] = [
			("genre:rock", "Rock"), ("artist:alpha", "Alpha"), ("project:beta", "Beta"), ("track:gamma", "Gamma"),
		],
		edges: [(String, String, String)]? = nil
	) throws -> Catalog {
		let edges =
			edges ?? [
				("artist:alpha", "genre:rock", "genres"), ("project:beta", "genre:rock", "genres"),
				("track:gamma", "genre:rock", "genres"),
			]
		let payload: [String: Any] = [
			"version": "v1", "revision": Self.revisionHash,
			"taxonomy": ["mode": "degraded", "available": true],
			"nodes": nodes.map { id, name in
				["identity": id, "type": String(id.prefix { $0 != ":" }), "name": name, "teaser": NSNull()]
			},
			"edges": edges.map { ["source": $0.0, "target": $0.1, "type": $0.2] },
		]
		return try JSONDecoder().decode(
			Catalog.self, from: JSONSerialization.data(withJSONObject: payload))
	}

	private func waitForCatalogReads(_ probe: CatalogProbe, count: Int) async throws {
		for _ in 0..<500 {
			if await probe.calls >= count { return }
			try await Task.sleep(for: .milliseconds(10))
		}
		XCTFail("The catalog was read fewer than \(count) times.")
	}
}

private struct UnexpectedState: Error {}

/// The external boundary: a catalog reader that counts its calls and can pause or react to a read.
private actor CatalogProbe {
	private(set) var calls = 0
	private let result: APIResult<Catalog>
	private var hook: (@Sendable () async -> Void)?
	private var shouldBlockNext = false
	private var blocked: CheckedContinuation<Void, Never>?

	init(result: APIResult<Catalog>) {
		self.result = result
	}

	func onRead(_ hook: @escaping @Sendable () async -> Void) {
		self.hook = hook
	}

	func blockNextRead() {
		shouldBlockNext = true
	}

	func releaseBlockedRead() {
		blocked?.resume()
		blocked = nil
	}

	func read() async -> APIResult<Catalog> {
		calls += 1
		if shouldBlockNext {
			shouldBlockNext = false
			await withCheckedContinuation { blocked = $0 }
		}
		if let hook { await hook() }
		return result
	}
}
