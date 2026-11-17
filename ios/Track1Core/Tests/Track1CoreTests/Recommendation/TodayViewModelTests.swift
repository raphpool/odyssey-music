import Foundation
import XCTest

@testable import Track1Core

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

	func testTheSameInstanceLoadedTwiceKeepsTheRecommendationAndOneEntryPerDate() async throws {
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let store = makeStore()
		let model = makeModel(probe: probe, store: store)
		await model.load(for: try profile(revision: 1))
		let created = try recommendation(of: model)
		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(try recommendation(of: model), created)
		let history = await store.history()
		XCTAssertEqual(history.filter { $0.localDate == Self.parisDate }, [created])
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates)
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

	// MARK: Profile genre names (TRA-698)

	func testTheStoredGenreNamesFollowTheTickOrderOfTheProfileSelection() async throws {
		let probe = CatalogProbe(result: .success(try editorialCatalog(), etag: nil))
		let model = makeModel(probe: probe, store: makeStore())
		await model.load(for: try profile(revision: 1, selection: Self.selection))

		XCTAssertEqual(try recommendation(of: model).profileGenreNames, ["IDM", "Ambient", "Glitch"])
	}

	func testTheGenreNamesAreWrittenToTheHistory() async throws {
		let store = makeStore()
		let model = makeModel(
			probe: CatalogProbe(result: .success(try editorialCatalog(), etag: nil)), store: store)
		await model.load(for: try profile(revision: 1, selection: Self.selection))

		let history = await store.history()
		// The day and its seven planned days: a planned entry is served later without the catalog too.
		XCTAssertEqual(history.map(\.profileGenreNames), Array(repeating: ["IDM", "Ambient", "Glitch"], count: 8))
	}

	func testADegradedTaxonomyStoresNoGenreName() async throws {
		let model = makeModel(
			probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: makeStore())
		await model.load(for: try profile(revision: 1, selection: Self.selection))

		XCTAssertEqual(try recommendation(of: model).profileGenreNames, [])
	}

	func testAProfileWithoutASelectionStoresNoGenreNameEvenWithAnEditorialTaxonomy() async throws {
		let model = makeModel(
			probe: CatalogProbe(result: .success(try editorialCatalog(), etag: nil)), store: makeStore())
		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(try recommendation(of: model).profileGenreNames, [])
	}

	func testThePersistedGenreNamesReturnWithoutReadingTheCatalog() async throws {
		let seeded = makeModel(
			probe: CatalogProbe(result: .success(try editorialCatalog(), etag: nil)), store: makeStore())
		await seeded.load(for: try profile(revision: 1, selection: Self.selection))
		let created = try recommendation(of: seeded)
		XCTAssertEqual(created.profileGenreNames, ["IDM", "Ambient", "Glitch"])

		let offline = CatalogProbe(result: .failure(.network))
		let model = makeModel(probe: offline, store: makeStore())
		await model.load(for: try profile(revision: 1, selection: Self.selection))

		XCTAssertEqual(try recommendation(of: model).profileGenreNames, ["IDM", "Ambient", "Glitch"])
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
		XCTAssertEqual(history.filter { $0.localDate == Self.parisDate }, [second])
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates)
		XCTAssertTrue(history.allSatisfy { $0.profileRevision == 2 })
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
		XCTAssertEqual(history.map(\.localDate), ["2026-10-09", Self.parisDate] + Self.plannedDates)
		XCTAssertEqual(history.first, earlier)
		XCTAssertEqual(history.first { $0.localDate == Self.parisDate }, try recommendation(of: model))
	}

	// MARK: Planned days (TRA-743)

	func testALoadSavesTheDayAndSevenPlannedDaysAndExposesThem() async throws {
		let store = makeStore()
		let model = makeModel(probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: store)
		XCTAssertEqual(model.upcoming, [])
		await model.load(for: try profile(revision: 1))

		let history = await store.history()
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates)
		XCTAssertEqual(model.upcoming.count, 7)
		XCTAssertEqual(model.upcoming.map(\.localDate), Self.plannedDates)
		XCTAssertEqual(model.upcoming.map(\.recommendation), Array(history.dropFirst()))
		XCTAssertTrue(history.allSatisfy { !$0.viewRecorded })
	}

	func testAFailedLoadLeavesNoPlanAndWritesNothing() async throws {
		let store = makeStore()
		let model = makeModel(probe: CatalogProbe(result: .failure(.network)), store: store)
		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(model.upcoming, [])
		let history = await store.history()
		XCTAssertEqual(history, [])
	}

	func testAFailedSaveClearsThePlanOfAnEarlierLoadAndKeepsTheStoredEntries() async throws {
		let store = makeStore()
		let model = makeModel(probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: store)
		await model.load(for: try profile(revision: 1))
		let planned = await store.history()
		XCTAssertEqual(model.upcoming.count, 7)

		// A revision of 0 cannot be stored, so this load picks, fails to save and must not expose a plan.
		await model.load(for: try profile(revision: 0))

		XCTAssertEqual(model.state, .unavailable)
		XCTAssertEqual(model.upcoming, [])
		let history = await store.history()
		XCTAssertEqual(history, planned)
	}

	func testTheNextDayServesTheWorkPlannedTheDayBeforeEvenWithAnotherCatalog() async throws {
		let store = makeStore()
		let today = makeModel(probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: store)
		await today.load(for: try profile(revision: 1))
		let planned = try XCTUnwrap(today.upcoming.first)

		let other = try catalog(
			nodes: [("genre:rock", "Rock"), ("project:zeta", "Zeta"), ("track:eta", "Eta")],
			edges: [("project:zeta", "genre:rock", "genres"), ("track:eta", "genre:rock", "genres")])
		let probe = CatalogProbe(result: .success(other, etag: nil))
		let tomorrow = makeModel(probe: probe, store: store, now: Self.clock.addingTimeInterval(86_400))
		await tomorrow.load(for: try profile(revision: 1))

		XCTAssertEqual(planned.localDate, "2026-10-12")
		XCTAssertEqual(tomorrow.state, .recommendation(planned.recommendation))
		let reads = await probe.calls
		XCTAssertEqual(reads, 0)
		XCTAssertEqual(tomorrow.upcoming, [])
	}

	func testAChangedRevisionDoesNotServeThePlannedEntryAndReplacesThePlan() async throws {
		let store = makeStore()
		let today = makeModel(probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: store)
		await today.load(for: try profile(revision: 1))
		let oldPlan = today.upcoming.map(\.recommendation.recommendationID)

		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let tomorrow = makeModel(probe: probe, store: store, now: Self.clock.addingTimeInterval(86_400))
		await tomorrow.load(for: try profile(revision: 2))

		let served = try recommendation(of: tomorrow)
		XCTAssertEqual(served.localDate, "2026-10-12")
		XCTAssertEqual(served.profileRevision, 2)
		XCTAssertFalse(oldPlan.contains(served.recommendationID))
		let reads = await probe.calls
		XCTAssertEqual(reads, 1)

		let history = await store.history()
		let planned = Array(Self.plannedDates.dropFirst()) + ["2026-10-19"]
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate, "2026-10-12"] + planned)
		XCTAssertEqual(history.first?.profileRevision, 1)
		XCTAssertTrue(history.dropFirst().allSatisfy { $0.profileRevision == 2 })
		XCTAssertEqual(tomorrow.upcoming.map(\.recommendation), Array(history.suffix(7)))
		XCTAssertTrue(Set(history.map(\.recommendationID)).isDisjoint(with: oldPlan))
	}

	/// With four works, the plan on disk marks three of them as seen. If those future entries counted for the
	/// pick of today, the only unseen work would be chosen instead of the one a history without a plan gives.
	func testTodaysWorkIsTheSameWithAPlanOnDiskAsWithout() async throws {
		let works = ["project:beta", "track:gamma", "project:delta", "track:epsilon"]
		let withFourWorks = try catalog(
			nodes: [("genre:rock", "Rock")] + works.map { ($0, $0) },
			edges: works.map { ($0, "genre:rock", "genres") })
		let taste = try profile(revision: 1)
		let candidates = Affinity.rank(catalog: withFourWorks, genreIDs: taste.genreIDs)
		let expected = try XCTUnwrap(
			DailySelection.pick(
				candidates: candidates, history: [], localID: Self.localID, localDate: Self.parisDate)
		).identity
		let unseen = try XCTUnwrap(candidates.first { $0.identity != expected })
		let plan = try candidates.filter { $0.identity != unseen.identity }.enumerated().map { index, candidate in
			try storedRecommendation(
				date: Self.plannedDates[index], node: candidate.identity.rawValue, revision: 1)
		}
		XCTAssertEqual(candidates.count, 4)
		let store = makeStore()
		_ = await store.save(plan)

		let model = makeModel(probe: CatalogProbe(result: .success(withFourWorks, etag: nil)), store: store)
		await model.load(for: taste)

		XCTAssertEqual(try recommendation(of: model).nodeID, expected)
		let history = await store.history()
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates)
	}

	/// Nine works are more than the eight days of the day and its plan, so no day has to repeat a work. The
	/// stored plan here names today's work on the third day, as a clock that moved back can leave it.
	func testAStoredPlanEntryNamingTodaysWorkIsPickedAgain() async throws {
		let works = (1...9).map { "project:work\($0)" }
		let nineWorks = try catalog(
			nodes: [("genre:rock", "Rock")] + works.map { ($0, $0) },
			edges: works.map { ($0, "genre:rock", "genres") })
		let taste = try profile(revision: 1)
		let candidates = Affinity.rank(catalog: nineWorks, genreIDs: taste.genreIDs)
		let expected = try XCTUnwrap(
			DailySelection.pick(
				candidates: candidates, history: [], localID: Self.localID, localDate: Self.parisDate)
		).identity
		let store = makeStore()
		let naming = try storedRecommendation(
			date: Self.plannedDates[2], node: expected.rawValue, revision: 1)
		_ = await store.save([naming])

		let model = makeModel(probe: CatalogProbe(result: .success(nineWorks, etag: nil)), store: store)
		await model.load(for: taste)

		XCTAssertEqual(candidates.count, 9)
		XCTAssertEqual(try recommendation(of: model).nodeID, expected)
		let history = await store.history()
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates)
		XCTAssertEqual(Set(history.map(\.nodeID)).count, 8)
	}

	func testAFullHistoryKeepsTodayAndTheSevenNextDays() async throws {
		let store = makeStore()
		let pastDates = Self.fortyPastDates
		let past = try pastDates.map { try storedRecommendation(date: $0, node: "project:beta", revision: 1) }
		_ = await store.save(past)
		let model = makeModel(probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: store)

		await model.load(for: try profile(revision: 1))

		let history = await store.history()
		XCTAssertEqual(pastDates.count, 40)
		XCTAssertEqual(history.count, 40)
		XCTAssertEqual(history.suffix(8).map(\.localDate), [Self.parisDate] + Self.plannedDates)
		let kept = Array(pastDates.dropFirst(8))
		XCTAssertEqual(history.map(\.localDate), kept + [Self.parisDate] + Self.plannedDates)
		XCTAssertEqual(history.map(\.localDate), history.map(\.localDate).sorted())
		XCTAssertEqual(model.upcoming.count, 7)
	}

	// MARK: Extending the plan on the cached path (TRA-783)

	/// The day after the first load: `load` serves the planned entry without a read, so the plan still ends on
	/// 2026-10-18 and today + 7 is 2026-10-19. Nine works are as many as the nine dates, so no work repeats and
	/// every planned entry is kept as it is (one that names the work of the day would be picked again).
	func testExtendPlanAddsTheMissingDayAndKeepsThePlannedOnes() async throws {
		let works = (1...9).map { "project:work\($0)" }
		let nineWorks = try catalog(
			nodes: [("genre:rock", "Rock")] + works.map { ($0, $0) },
			edges: works.map { ($0, "genre:rock", "genres") })
		let taste = try profile(revision: 1)
		let store = makeStore()
		let first = makeModel(probe: CatalogProbe(result: .success(nineWorks, etag: nil)), store: store)
		await first.load(for: taste)
		let firstHistory = await store.history()

		let probe = CatalogProbe(result: .success(nineWorks, etag: nil))
		let tomorrow = makeModel(probe: probe, store: store, now: Self.clock.addingTimeInterval(86_400))
		await tomorrow.load(for: taste)
		let served = try recommendation(of: tomorrow)
		let readsAfterLoad = await probe.calls
		XCTAssertEqual(readsAfterLoad, 0)
		XCTAssertEqual(tomorrow.upcoming, [])

		await tomorrow.extendPlanIfNeeded(for: taste)

		let readsAfterExtend = await probe.calls
		XCTAssertEqual(readsAfterExtend, 1)
		XCTAssertEqual(tomorrow.state, .recommendation(served))
		let history = await store.history()
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates + ["2026-10-19"])
		XCTAssertEqual(Array(history.prefix(8)), firstHistory)
		XCTAssertEqual(Set(history.map(\.nodeID)).count, 9)
		XCTAssertEqual(tomorrow.upcoming.map(\.localDate), Array(Self.plannedDates.dropFirst()) + ["2026-10-19"])
		XCTAssertEqual(tomorrow.upcoming.map(\.recommendation), Array(history.suffix(7)))
	}

	/// An app update: today's entry is on disk, no plan is, and `load` plans nothing.
	func testExtendPlanPlansTheSevenNextDaysWhenOnlyTodaysEntryIsOnDisk() async throws {
		let taste = try profile(revision: 1)
		let store = makeStore()
		let stored = try storedRecommendation(date: Self.parisDate, node: "project:beta", revision: 1)
		_ = await store.save([stored])
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let model = makeModel(probe: probe, store: store)
		await model.load(for: taste)
		XCTAssertEqual(model.state, .recommendation(stored))
		XCTAssertEqual(model.upcoming, [])

		await model.extendPlanIfNeeded(for: taste)

		let reads = await probe.calls
		XCTAssertEqual(reads, 1)
		XCTAssertEqual(model.state, .recommendation(stored))
		let history = await store.history()
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates)
		XCTAssertEqual(history.first, stored)
		XCTAssertEqual(model.upcoming.map(\.localDate), Self.plannedDates)
		XCTAssertEqual(model.upcoming.map(\.recommendation), Array(history.dropFirst()))
	}

	func testExtendPlanReadsNothingWhenThePlanAlreadyReachesTheHorizon() async throws {
		let taste = try profile(revision: 1)
		let store = makeStore()
		let first = makeModel(probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: store)
		await first.load(for: taste)
		let planned = await store.history()

		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let model = makeModel(probe: probe, store: store)
		await model.load(for: taste)
		await model.extendPlanIfNeeded(for: taste)

		let reads = await probe.calls
		XCTAssertEqual(reads, 0)
		let history = await store.history()
		XCTAssertEqual(history, planned)
		XCTAssertEqual(model.upcoming, [])
	}

	func testExtendPlanWithACatalogThatCannotBeUsedHasNoEffect() async throws {
		let taste = try profile(revision: 1)
		let bare = try catalog(nodes: [("genre:rock", "Rock")], edges: [])
		let unusable: [APIResult<Catalog>] = [
			.failure(.network), .notModified(etag: "x"), .success(bare, etag: nil),
		]
		for result in unusable {
			let store = makeStore()
			let stored = try storedRecommendation(date: Self.parisDate, node: "project:beta", revision: 1)
			_ = await store.save([stored])
			let probe = CatalogProbe(result: result)
			let model = makeModel(probe: probe, store: store)
			await model.load(for: taste)

			await model.extendPlanIfNeeded(for: taste)

			let reads = await probe.calls
			XCTAssertEqual(reads, 1)
			XCTAssertEqual(model.state, .recommendation(stored))
			XCTAssertEqual(model.upcoming, [])
			let history = await store.history()
			XCTAssertEqual(history, [stored])
		}
	}

	/// An entry of another revision on the horizon date is not a plan of these tastes: it is picked again.
	func testExtendPlanReplacesAnEntryOfAnotherRevisionOnTheHorizonDate() async throws {
		let taste = try profile(revision: 1)
		let store = makeStore()
		let stored = try storedRecommendation(date: Self.parisDate, node: "project:beta", revision: 1)
		let stale = try storedRecommendation(date: "2026-10-18", node: "track:gamma", revision: 2)
		_ = await store.save([stored, stale])
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let model = makeModel(probe: probe, store: store)
		await model.load(for: taste)

		await model.extendPlanIfNeeded(for: taste)

		let reads = await probe.calls
		XCTAssertEqual(reads, 1)
		let history = await store.history()
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates)
		XCTAssertTrue(history.allSatisfy { $0.profileRevision == 1 })
		XCTAssertFalse(history.map(\.recommendationID).contains(stale.recommendationID))
	}

	func testExtendPlanKeepsTheViewMarkerOfTodaysEntry() async throws {
		let taste = try profile(revision: 1)
		let store = makeStore()
		let stored = try storedRecommendation(date: Self.parisDate, node: "project:beta", revision: 1)
		_ = await store.save([stored])
		let model = makeModel(probe: CatalogProbe(result: .success(try catalog(), etag: nil)), store: store)
		await model.load(for: taste)
		await model.recordImpressionIfNeeded()

		await model.extendPlanIfNeeded(for: taste)

		let history = await store.history()
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates)
		XCTAssertEqual(history.first?.recommendationID, stored.recommendationID)
		XCTAssertEqual(history.first?.viewRecorded, true)
		XCTAssertTrue(history.dropFirst().allSatisfy { !$0.viewRecorded })
	}

	func testExtendPlanDoesNothingWithoutAShownRecommendation() async throws {
		let taste = try profile(revision: 1)
		let store = makeStore()
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let neverLoaded = makeModel(probe: probe, store: store)
		await neverLoaded.extendPlanIfNeeded(for: taste)

		let failing = CatalogProbe(result: .failure(.network))
		let unavailable = makeModel(probe: failing, store: store)
		await unavailable.load(for: taste)
		await unavailable.extendPlanIfNeeded(for: taste)

		XCTAssertEqual(unavailable.state, .unavailable)
		let neverLoadedReads = await probe.calls
		let unavailableReads = await failing.calls
		XCTAssertEqual(neverLoadedReads, 0)
		XCTAssertEqual(unavailableReads, 1)
		let history = await store.history()
		XCTAssertEqual(history, [])
	}

	func testExtendPlanIgnoresTastesOtherThanTheLastLoadedOnes() async throws {
		let store = makeStore()
		let stored = try storedRecommendation(date: Self.parisDate, node: "project:beta", revision: 1)
		_ = await store.save([stored])
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let model = makeModel(probe: probe, store: store)
		await model.load(for: try profile(revision: 1))

		await model.extendPlanIfNeeded(for: try profile(revision: 2))

		let reads = await probe.calls
		XCTAssertEqual(reads, 0)
		let history = await store.history()
		XCTAssertEqual(history, [stored])
		XCTAssertEqual(model.upcoming, [])
	}

	// MARK: Works only, no artist (TRA-713)

	func testAStoredArtistForTodayIsReplacedByAProjectOrATrackAndLeavesTheHistory() async throws {
		let store = makeStore()
		let storedArtist = try storedRecommendation(date: Self.parisDate, node: "artist:alpha", revision: 1)
		_ = await store.save([storedArtist])
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let model = makeModel(probe: probe, store: store)

		await model.load(for: try profile(revision: 1))

		let replacement = try recommendation(of: model)
		XCTAssertTrue([NodeType.project, .track].contains(replacement.nodeType))
		XCTAssertNotEqual(replacement.recommendationID, storedArtist.recommendationID)
		let history = await store.history()
		XCTAssertEqual(history.filter { $0.localDate == Self.parisDate }, [replacement])
		XCTAssertFalse(history.contains { $0.nodeType == .artist })
		let reads = await probe.calls
		XCTAssertEqual(reads, 1)
	}

	func testAStoredProjectForTodayIsServedAsIsWithoutANewPick() async throws {
		let store = makeStore()
		let storedProject = try storedRecommendation(date: Self.parisDate, node: "project:beta", revision: 1)
		_ = await store.save([storedProject])
		let probe = CatalogProbe(result: .success(try catalog(), etag: nil))
		let model = makeModel(probe: probe, store: store)

		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(model.state, .recommendation(storedProject))
		let history = await store.history()
		XCTAssertEqual(history, [storedProject])
		XCTAssertEqual(model.upcoming, [])
		let reads = await probe.calls
		XCTAssertEqual(reads, 0)
	}

	func testACatalogLinkingTheGenreOnlyToArtistsIsEmptyCatalogAndWritesNothing() async throws {
		let artistsOnly = try catalog(
			nodes: [("genre:rock", "Rock"), ("artist:alpha", "Alpha"), ("artist:delta", "Delta")],
			edges: [("artist:alpha", "genre:rock", "genres"), ("genre:rock", "artist:delta", "key_artists")])
		let store = makeStore()
		let model = makeModel(probe: CatalogProbe(result: .success(artistsOnly, etag: nil)), store: store)

		await model.load(for: try profile(revision: 1))

		XCTAssertEqual(model.state, .emptyCatalog)
		let history = await store.history()
		XCTAssertEqual(history, [])
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
		XCTAssertEqual(history.first, previous)
		XCTAssertEqual(history.map(\.localDate), [Self.parisDate] + Self.plannedDates)
		XCTAssertTrue(history.allSatisfy { $0.profileRevision == 1 })
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
		XCTAssertEqual(history.first, viewed)
		XCTAssertEqual(history.dropFirst().filter(\.viewRecorded), [])
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

	// MARK: Helpers

	private static let clock = Date(timeIntervalSince1970: 1_791_675_000)  // 2026-10-10T23:30:00Z
	private static let paris = TimeZone(identifier: "Europe/Paris")!
	private static let parisDate = "2026-10-11"
	private static let plannedDates = [
		"2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18",
	]
	/// The forty days before `parisDate`, September 1st to October 10th.
	private static let fortyPastDates =
		(1...30).map { String(format: "2026-09-%02d", $0) } + (1...10).map { String(format: "2026-10-%02d", $0) }

	private func makeStore() -> DailyRecommendationStore {
		DailyRecommendationStore(localStore: LocalStore(directoryURL: directoryURL))
	}

	private func makeID() -> UUID {
		nextID += 1
		return UUID(uuidString: String(format: "AAAAAAAA-0000-4000-8000-%012X", nextID))!
	}

	private func makeModel(
		probe: CatalogProbe, store: DailyRecommendationStore, now: Date? = nil
	) -> TodayViewModel {
		let instant = now ?? Self.clock
		return TodayViewModel(
			readCatalog: { await probe.read() },
			store: store,
			now: { instant },
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

	private func profile(revision: Int, selection: [String: [String]]? = nil) throws -> Profile {
		let genre = try XCTUnwrap(NodeIdentity(rawValue: "genre:rock"))
		var json: [String: Any] = [
			"version": Profile.version, "local_id": Self.localID.uuidString, "genre_ids": [genre.rawValue],
			"revision": revision, "onboarding_completed": true,
			"flow_id": "5B1D3F0A-0000-4000-8000-0000000000BB", "created_at": 0,
		]
		json["selection"] = selection
		return try JSONDecoder().decode(Profile.self, from: JSONSerialization.data(withJSONObject: json))
	}

	/// Ticked in this order: Q4 is the fourth name, past the cap of three.
	private static let selection = ["families": ["electronic"], "genres": ["Q2", "Q1", "Q3", "Q4"]]

	/// The same works as `catalog()`, with an editorial taxonomy whose four genres are all visible.
	private func editorialCatalog() throws -> Catalog {
		try EditorialFixture.catalog(
			nodes: [
				("genre:rock", "Rock"), ("genre:ambient", "Ambient"), ("genre:idm", "IDM"),
				("genre:glitch", "Glitch"), ("genre:dub", "Dub"), ("artist:alpha", "Alpha"),
				("project:beta", "Beta"), ("track:gamma", "Gamma"),
			],
			edges: [
				("artist:alpha", "genre:rock", "genres"), ("project:beta", "genre:rock", "genres"),
				("track:gamma", "genre:rock", "genres"),
			],
			families: [(key: "electronic", label: "Electronic", order: 1)],
			genres: [
				(id: "Q1", name: "Ambient", family: "electronic", slugs: ["genre:ambient"]),
				(id: "Q2", name: "IDM", family: "electronic", slugs: ["genre:idm"]),
				(id: "Q3", name: "Glitch", family: "electronic", slugs: ["genre:glitch"]),
				(id: "Q4", name: "Dub", family: "electronic", slugs: ["genre:dub"]),
			])
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
}

private struct UnexpectedState: Error {}

/// The external boundary: a catalog reader that counts its calls.
private actor CatalogProbe {
	private(set) var calls = 0
	private let result: APIResult<Catalog>

	init(result: APIResult<Catalog>) {
		self.result = result
	}

	func read() async -> APIResult<Catalog> {
		calls += 1
		return result
	}
}
