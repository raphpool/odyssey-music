import Foundation
import XCTest

@testable import Track1Core

/// Overlapping calls on `TodayViewModel` (TRA-379). The catalog is the only fake: a reader that suspends until
/// the test releases it, so every interleaving is driven by the test and no test waits for a duration.
@MainActor
final class TodayViewModelConcurrencyTests: XCTestCase {
	private static let fileName = "daily-recommendation.v1.json"
	private static let localID = UUID(uuidString: "5B1D3F0A-0000-4000-8000-0000000000AA")!
	private static let revisionHash = "sha256:" + String(repeating: "0123456789abcdef", count: 4)
	private static let clock = Date(timeIntervalSince1970: 1_791_675_000)  // 2026-10-10T23:30:00Z
	private static let paris = TimeZone(identifier: "Europe/Paris")!
	private static let parisDate = "2026-10-11"

	// One instance per test method, so these start fresh (same approach as `TodayViewModelTests`).
	private nonisolated let directoryURL = FileManager.default.temporaryDirectory.appending(
		path: UUID().uuidString,
		directoryHint: .isDirectory
	)
	private var events: [AnalyticsEvent] = []
	private var nextID = 0

	override func tearDownWithError() throws {
		try? FileManager.default.removeItem(at: directoryURL)
	}

	func testAMarkViewedLandingDuringTheCatalogReadIsNotOverwrittenByTheSave() async throws {
		let catalog = ControlledCatalog(try catalog())
		let store = makeStore()
		let yesterday = try storedRecommendation(date: "2026-10-10", node: "artist:alpha", revision: 1)
		_ = await store.save([yesterday])
		let model = makeModel(catalog, store: store)
		await catalog.hold()

		let taste = try profile(revision: 1)
		let loading = Task { await model.load(for: taste) }
		await catalog.waitForReads(1)
		_ = await store.markViewed(yesterday.recommendationID)
		await catalog.releaseAll()
		await loading.value

		let history = await store.history()
		// The viewed entry, today and the seven planned days (TRA-743).
		XCTAssertEqual(history.count, 9)
		XCTAssertEqual(history.first?.recommendationID, yesterday.recommendationID)
		XCTAssertEqual(history.first?.viewRecorded, true)
		XCTAssertEqual(history.first { $0.localDate == Self.parisDate }, try recommendation(of: model))
	}

	func testTwoParallelLoadsForTheSameProfileReadTheCatalogOnceAndAgree() async throws {
		let catalog = ControlledCatalog(try catalog())
		let store = makeStore()
		let model = makeModel(catalog, store: store)
		let taste = try profile(revision: 1)
		await catalog.hold()

		let first = Task { await model.load(for: taste) }
		await catalog.waitForReads(1)
		let second = Task { await model.load(for: taste) }
		await queuedTasksReachTheirFirstSuspension()
		await catalog.releaseAll()
		await first.value
		await second.value

		let reads = await catalog.reads
		XCTAssertEqual(reads, 1)
		let history = await store.history()
		// One load saved one plan: today and the seven planned days.
		XCTAssertEqual(history.count, 8)
		XCTAssertEqual(history.filter { $0.localDate == Self.parisDate }, [try recommendation(of: model)])
	}

	func testALoadSupersededByNewTastesPublishesAndSavesNothing() async throws {
		let catalog = ControlledCatalog(try catalog())
		let store = makeStore()
		let model = makeModel(catalog, store: store)
		await catalog.hold()

		let oldTaste = try profile(revision: 1)
		let newTaste = try profile(revision: 2)

		let stale = Task { await model.load(for: oldTaste) }
		await catalog.waitForReads(1)
		let current = Task { await model.load(for: newTaste) }
		await queuedTasksReachTheirFirstSuspension()
		await catalog.releaseNext()
		await stale.value

		// The newer load is now holding the section on its own catalog read, so nothing else can have run:
		// whatever is visible here comes from the superseded load.
		await catalog.waitForReads(2)
		XCTAssertEqual(model.state, .loading)
		let beforeCurrent = await store.history()
		XCTAssertEqual(beforeCurrent, [])

		await catalog.releaseAll()
		await current.value
		let published = try recommendation(of: model)
		XCTAssertEqual(published.profileRevision, 2)
		let history = await store.history()
		XCTAssertEqual(history.count, 8)
		XCTAssertEqual(history.filter { $0.localDate == Self.parisDate }, [published])
		XCTAssertTrue(history.allSatisfy { $0.profileRevision == 2 })
	}

	/// TRA-783: a plan extension for old tastes, superseded while it reads the catalog, writes and exposes nothing.
	func testAnExtensionSupersededByNewTastesSavesAndPublishesNothing() async throws {
		let catalog = ControlledCatalog(try catalog())
		let store = makeStore()
		let stored = try storedRecommendation(date: Self.parisDate, node: "project:beta", revision: 1)
		_ = await store.save([stored])
		let model = makeModel(catalog, store: store)
		let oldTaste = try profile(revision: 1)
		let newTaste = try profile(revision: 2)
		await model.load(for: oldTaste)
		XCTAssertEqual(model.state, .recommendation(stored))
		await catalog.hold()

		let stale = Task { await model.extendPlanIfNeeded(for: oldTaste) }
		await catalog.waitForReads(1)
		let current = Task { await model.load(for: newTaste) }
		await queuedTasksReachTheirFirstSuspension()
		await catalog.releaseNext()
		await stale.value

		// The newer load now holds the section on its own catalog read: what is visible comes from the extension.
		await catalog.waitForReads(2)
		XCTAssertEqual(model.state, .recommendation(stored))
		XCTAssertEqual(model.upcoming, [])
		let beforeCurrent = await store.history()
		XCTAssertEqual(beforeCurrent, [stored])

		await catalog.releaseAll()
		await current.value
	}

	func testAnImpressionRequestedDuringALoadWaitsForItAndMarksWhatIsExposed() async throws {
		let catalog = ControlledCatalog(try catalog())
		let store = makeStore()
		let model = makeModel(catalog, store: store)
		await model.load(for: try profile(revision: 1))
		let previous = try recommendation(of: model)
		await catalog.hold()

		let newTaste = try profile(revision: 2)
		let reload = Task { await model.load(for: newTaste) }
		await catalog.waitForReads(2)
		let impression = Task { await model.recordImpressionIfNeeded() }
		await queuedTasksReachTheirFirstSuspension()
		await catalog.releaseAll()
		await reload.value
		await impression.value

		let exposed = try recommendation(of: model)
		XCTAssertNotEqual(exposed.recommendationID, previous.recommendationID)
		XCTAssertTrue(exposed.viewRecorded)
		let history = await store.history()
		XCTAssertEqual(history.count, 8)
		XCTAssertEqual(history.filter { $0.localDate == Self.parisDate }, [exposed])
		XCTAssertEqual(history.filter(\.viewRecorded), [exposed])
		XCTAssertEqual(events.count, 1)
		XCTAssertEqual(
			events.first?.properties["recommendation_id"],
			.string(exposed.recommendationID.uuidString.lowercased()))
	}

	func testTwoParallelImpressionsEmitOneEvent() async throws {
		let model = makeModel(ControlledCatalog(try catalog()), store: makeStore())
		await model.load(for: try profile(revision: 1))

		async let first: Void = model.recordImpressionIfNeeded()
		async let second: Void = model.recordImpressionIfNeeded()
		_ = await (first, second)

		XCTAssertEqual(events.map(\.name), [.dailyRecommendationViewed])
	}

	func testAFailedMarkerWriteDoesNotLetTheSameSessionEmitTheEventAgain() async throws {
		let catalog = ControlledCatalog(try catalog())
		let seed = makeModel(catalog, store: makeStore())
		await seed.load(for: try profile(revision: 1))

		// This store's first write is the marker, because `load` finds the persisted entry and writes nothing.
		let failing = DailyRecommendationStore(
			localStore: LocalStore(directoryURL: directoryURL, failNextWriteNamed: Self.fileName))
		let model = makeModel(catalog, store: failing)
		await model.load(for: try profile(revision: 1))
		await model.recordImpressionIfNeeded()
		await model.load(for: try profile(revision: 1))
		await model.recordImpressionIfNeeded()

		XCTAssertEqual(events.map(\.name), [.dailyRecommendationViewed])
	}

	func testACancelledLoadWaitingForTheSectionDoesNothingAndDoesNotBlockTheNextCalls() async throws {
		let catalog = ControlledCatalog(try catalog())
		let store = makeStore()
		let model = makeModel(catalog, store: store)
		await catalog.hold()

		let oldTaste = try profile(revision: 1)
		let newTaste = try profile(revision: 2)

		let running = Task { await model.load(for: oldTaste) }
		await catalog.waitForReads(1)
		let cancelled = Task { await model.load(for: newTaste) }
		await queuedTasksReachTheirFirstSuspension()
		cancelled.cancel()
		await catalog.releaseAll()
		await running.value
		await cancelled.value

		// The section was handed on: these would never return if the cancelled waiter had kept it.
		await model.recordImpressionIfNeeded()
		await model.load(for: newTaste)
		let reads = await catalog.reads
		XCTAssertEqual(reads, 2, "The cancelled load must not read the catalog.")
		XCTAssertEqual(try recommendation(of: model).profileRevision, 2)
	}

	// MARK: Helpers

	/// `Task.yield` hands the main actor to the tasks queued ahead of this test, which run until their first
	/// suspension (here: waiting for the section). There is nothing else to observe from outside the view
	/// model, hence a few yields rather than a duration.
	private func queuedTasksReachTheirFirstSuspension() async {
		for _ in 0..<5 { await Task.yield() }
	}

	private func makeStore() -> DailyRecommendationStore {
		DailyRecommendationStore(localStore: LocalStore(directoryURL: directoryURL))
	}

	private func makeID() -> UUID {
		nextID += 1
		return UUID(uuidString: String(format: "AAAAAAAA-0000-4000-8000-%012X", nextID))!
	}

	private func makeModel(_ catalog: ControlledCatalog, store: DailyRecommendationStore) -> TodayViewModel {
		TodayViewModel(
			readCatalog: { await catalog.read() },
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
		let json: [String: Any] = [
			"version": Profile.version, "local_id": Self.localID.uuidString, "genre_ids": ["genre:rock"],
			"revision": revision, "onboarding_completed": true,
			"flow_id": "5B1D3F0A-0000-4000-8000-0000000000BB", "created_at": 0,
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
	private func catalog() throws -> Catalog {
		let nodes = [
			("genre:rock", "Rock"), ("artist:alpha", "Alpha"), ("project:beta", "Beta"), ("track:gamma", "Gamma"),
		]
		let edges = ["artist:alpha", "project:beta", "track:gamma"]
		let payload: [String: Any] = [
			"version": "v1", "revision": Self.revisionHash,
			"taxonomy": ["mode": "degraded", "available": true],
			"nodes": nodes.map { id, name in
				["identity": id, "type": String(id.prefix { $0 != ":" }), "name": name, "teaser": NSNull()]
			},
			"edges": edges.map { ["source": $0, "target": "genre:rock", "type": "genres"] },
		]
		return try JSONDecoder().decode(
			Catalog.self, from: JSONSerialization.data(withJSONObject: payload))
	}
}

private struct UnexpectedState: Error {}

/// The external boundary: a catalog reader that counts its reads and, while held, suspends each of them
/// until the test releases it (one at a time, in arrival order, or all at once).
private actor ControlledCatalog {
	private(set) var reads = 0
	private let catalog: Catalog
	private var isHolding = false
	private var suspended: [CheckedContinuation<Void, Never>] = []
	private var readWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

	init(_ catalog: Catalog) {
		self.catalog = catalog
	}

	func hold() {
		isHolding = true
	}

	func releaseNext() {
		if !suspended.isEmpty { suspended.removeFirst().resume() }
	}

	func releaseAll() {
		isHolding = false
		let all = suspended
		suspended = []
		for continuation in all { continuation.resume() }
	}

	/// Returns once at least `count` reads have started, whether or not they are still suspended.
	func waitForReads(_ count: Int) async {
		if reads >= count { return }
		await withCheckedContinuation { readWaiters.append((count, $0)) }
	}

	func read() async -> APIResult<Catalog> {
		reads += 1
		let ready = readWaiters.filter { $0.count <= reads }
		readWaiters.removeAll { $0.count <= reads }
		for waiter in ready { waiter.continuation.resume() }
		if isHolding { await withCheckedContinuation { suspended.append($0) } }
		return .success(catalog, etag: nil)
	}
}
