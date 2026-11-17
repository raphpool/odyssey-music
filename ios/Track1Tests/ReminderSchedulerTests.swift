import Foundation
import Track1Core
import XCTest

@testable import Track1

/// The scheduler is tested against a fake of the `ReminderCenter` boundary; `SystemReminderCenter` needs a
/// device and is not covered here.
final class ReminderSchedulerTests: XCTestCase {
	private let sevenDays = [
		"2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24",
	]

	// MARK: Schedule

	func testReplaceSchedulesOneNotificationPerReminderWithItsTitleAndBody() async throws {
		let center = FakeReminderCenter(status: .authorized)
		let scheduler = try makeScheduler(center)
		let plan = try sevenDays.map { try reminder($0) }

		await scheduler.replace(with: plan)

		let added = await center.added
		XCTAssertEqual(added.count, 7)
		XCTAssertEqual(added.map(\.identifier), sevenDays.map { "daily-\($0)" })
		XCTAssertEqual(added.map(\.title), sevenDays.map { "Title \($0)" })
		XCTAssertEqual(added.map(\.body), sevenDays.map { "Body \($0)" })
		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, sevenDays.map { "daily-\($0)" })
	}

	func testSecondReplaceKeepsOnlyTheIdentifiersOfTheSecondPlan() async throws {
		let center = FakeReminderCenter(status: .authorized)
		let scheduler = try makeScheduler(center)
		let secondDays = ["2026-11-24", "2026-11-25", "2026-11-26"]
		let first = try sevenDays.map { try reminder($0) }
		let second = try secondDays.map { try reminder($0) }

		await scheduler.replace(with: first)
		await scheduler.replace(with: second)

		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, secondDays.map { "daily-\($0)" })
	}

	func testReplaceKeepsPendingNotificationsOfAnotherPrefix() async throws {
		let center = FakeReminderCenter(
			status: .authorized, pending: ["other-1", "daily-2026-11-17", "weekly-2026-11-18", "dailyish"])
		let scheduler = try makeScheduler(center)
		let plan = [try reminder("2026-11-18")]

		await scheduler.replace(with: plan)

		let removals = await center.removals
		XCTAssertEqual(removals, [["daily-2026-11-17"]])
		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, ["other-1", "weekly-2026-11-18", "dailyish", "daily-2026-11-18"])
	}

	func testEmptyPlanStillClearsTheDailyNotifications() async throws {
		let center = FakeReminderCenter(status: .authorized, pending: ["daily-2026-11-18", "other-1"])
		let scheduler = try makeScheduler(center)

		await scheduler.replace(with: [])

		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, ["other-1"])
	}

	// MARK: Authorization

	func testReplaceDoesNothingWithoutAuthorization() async throws {
		let plan = [try reminder("2026-11-18")]
		for status in [ReminderAuthorization.denied, .notDetermined] {
			let center = FakeReminderCenter(status: status, pending: ["daily-2026-11-17", "other-1"])
			let scheduler = try makeScheduler(center)

			await scheduler.replace(with: plan)

			let added = await center.added
			let removals = await center.removals
			let pending = await center.pendingIdentifiers()
			XCTAssertEqual(added, [], "\(status)")
			XCTAssertEqual(removals, [], "\(status)")
			XCTAssertEqual(pending, ["daily-2026-11-17", "other-1"], "\(status)")
		}
	}

	// MARK: Dates

	func testComposedDateIsTheLastDayOfTheYearAtNine() async throws {
		let center = FakeReminderCenter(status: .authorized)
		let scheduler = try makeScheduler(center)
		let plan = [try reminder("2026-12-31", hour: 9)]

		await scheduler.replace(with: plan)

		let all = await center.added
		let added = try XCTUnwrap(all.first)
		XCTAssertEqual(added.identifier, "daily-2026-12-31")
		XCTAssertEqual(added.date.year, 2026)
		XCTAssertEqual(added.date.month, 12)
		XCTAssertEqual(added.date.day, 31)
		XCTAssertEqual(added.date.hour, 9)
		XCTAssertEqual(added.date.minute, 0)
		XCTAssertEqual(added.date.calendar, calendar)
		let fireDate = try XCTUnwrap(calendar.date(from: added.date))
		let expected = try date("2026-12-31T09:00:00Z")
		XCTAssertEqual(fireDate, expected)
	}

	func testComposedDateUsesTheHourOfTheReminder() async throws {
		let center = FakeReminderCenter(status: .authorized)
		let scheduler = try makeScheduler(center)
		let plan = [try reminder("2026-11-18", hour: 18)]

		await scheduler.replace(with: plan)

		let all = await center.added
		let added = try XCTUnwrap(all.first)
		XCTAssertEqual(added.date.hour, 18)
		XCTAssertEqual(added.date.minute, 0)
	}

	func testReminderAlreadyPastIsNotAdded() async throws {
		let center = FakeReminderCenter(status: .authorized)
		// 12:00 on the 18th: the 09:00 reminder of that day is behind, the next one is not.
		let scheduler = try makeScheduler(center, now: "2026-11-18T12:00:00Z")
		let plan = [try reminder("2026-11-18"), try reminder("2026-11-19")]

		await scheduler.replace(with: plan)

		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, ["daily-2026-11-19"])
	}

	func testReminderWithoutARealDateIsNotAdded() async throws {
		let center = FakeReminderCenter(status: .authorized)
		let scheduler = try makeScheduler(center)
		let plan = [
			try reminder("2026-02-30"), try reminder("tomorrow"), try reminder("2026-11-18", hour: 25),
			try reminder("2026-1-+01"), try reminder("2026-11-19"),
		]

		await scheduler.replace(with: plan)

		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, ["daily-2026-11-19"])
	}

	// MARK: Helpers

	private var calendar: Calendar {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = .gmt
		return calendar
	}

	private func date(_ iso8601: String) throws -> Date {
		try XCTUnwrap(ISO8601DateFormatter().date(from: iso8601))
	}

	/// "Now" is 2026-11-17 12:00 UTC unless a test moves it, so every date of the plans is in the future.
	private func makeScheduler(_ center: FakeReminderCenter, now: String? = nil) throws -> ReminderScheduler {
		let fixed = try date(now ?? "2026-11-17T12:00:00Z")
		return ReminderScheduler(center: center, calendar: calendar, now: { fixed })
	}

	private func reminder(_ localDate: String, hour: Int = 9) throws -> PlannedReminder {
		let recommendation = DailyRecommendation(
			recommendationID: UUID(), localDate: localDate, profileRevision: 1,
			nodeID: try XCTUnwrap(NodeIdentity(rawValue: "project:some-album")), nodeType: .project, name: "Name",
			teaser: nil, reasons: [], viewRecorded: false)
		return PlannedReminder(
			localDate: localDate, hour: hour, title: "Title \(localDate)", body: "Body \(localDate)",
			recommendation: recommendation)
	}
}

/// What Today does with the reminders once a load has ended (TRA-747): the real model, store and scheduler.
@MainActor
final class ReminderSyncTests: XCTestCase {
	/// 2026-11-17 12:00 UTC: the plan is the seven days from the 18th, all of them in the future.
	private nonisolated static let fixed = Date(timeIntervalSince1970: 1_794_916_800)
	private static let days = [
		"2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24",
	]
	private static let identifiers = days.map { "daily-\($0)" }

	// XCTest builds one instance per test method, so the directory is fresh without a `setUp`.
	private nonisolated let directoryURL = FileManager.default.temporaryDirectory.appending(
		path: UUID().uuidString, directoryHint: .isDirectory)

	override func tearDownWithError() throws {
		try? FileManager.default.removeItem(at: directoryURL)
	}

	func testAfterALoadThePendingNotificationsAreExactlyThoseOfTheModel() async throws {
		let center = FakeReminderCenter(status: .authorized, pending: ["other-1"])
		let sync = makeSync(center)
		let model = try makeModel(store: makeStore())
		let taste = try profile(revision: 1, genre: "rock")

		await model.load(for: taste)
		await sync.sync(model, for: taste)

		XCTAssertEqual(model.upcoming.map(\.localDate), Self.days)
		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, ["other-1"] + Self.identifiers)
		let added = await center.added
		XCTAssertEqual(added.map(\.body), model.upcoming.map(\.body))
	}

	func testWithoutAuthorizationNothingIsScheduledAndNothingIsAsked() async throws {
		for status in [ReminderAuthorization.denied, .notDetermined] {
			let center = FakeReminderCenter(status: status, pending: ["daily-2026-11-17"])
			let model = try makeModel(store: makeStore())
			let taste = try profile(revision: 1, genre: "rock")

			await model.load(for: taste)
			await makeSync(center).sync(model, for: taste)

			XCTAssertEqual(model.upcoming.count, 7, "\(status)")
			let pending = await center.pendingIdentifiers()
			let requests = await center.authorizationRequests
			XCTAssertEqual(pending, ["daily-2026-11-17"], "\(status)")
			XCTAssertEqual(requests, 0, "\(status)")
		}
	}

	func testNewGenresReplaceTheOldReminders() async throws {
		let center = FakeReminderCenter(status: .authorized)
		let sync = makeSync(center)
		let model = try makeModel(store: makeStore())
		let rock = try profile(revision: 1, genre: "rock")
		await model.load(for: rock)
		await sync.sync(model, for: rock)
		let rockBodies = model.upcoming.map(\.body)

		let jazz = try profile(revision: 2, genre: "jazz")
		await model.load(for: jazz)
		await sync.sync(model, for: jazz)

		XCTAssertNotEqual(model.upcoming.map(\.body), rockBodies)
		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, Self.identifiers)
		// What is pending under an identifier is the last notification added under it.
		let added = await center.added
		let current = Dictionary(added.map { ($0.identifier, $0.body) }, uniquingKeysWith: { _, last in last })
		XCTAssertEqual(pending.compactMap { current[$0] }, model.upcoming.map(\.body))
	}

	func testALoadWithoutARecommendationLeavesTheReminders() async throws {
		let center = FakeReminderCenter(status: .authorized, pending: ["daily-2026-11-18"])
		let model = try makeModel(store: makeStore(), readable: false)
		let taste = try profile(revision: 1, genre: "rock")

		await model.load(for: taste)
		await makeSync(center).sync(model, for: taste)

		XCTAssertEqual(model.state, .unavailable)
		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, ["daily-2026-11-18"])
	}

	/// A later launch serves the entry of the day from disk and plans nothing: `upcoming` is empty, and an empty
	/// plan must not cancel the reminders of the days to come.
	func testAnEmptyPlanFromALoadServedFromDiskDoesNotClearTheReminders() async throws {
		let store = makeStore()
		let taste = try profile(revision: 1, genre: "rock")
		try await makeModel(store: store).load(for: taste)
		let center = FakeReminderCenter(status: .authorized, pending: Self.identifiers)
		let model = try makeModel(store: store)

		await model.load(for: taste)
		await makeSync(center).sync(model, for: taste)

		XCTAssertEqual(model.upcoming, [])
		let removals = await center.removals
		XCTAssertEqual(removals, [])
	}

	/// An app update: today's entry is on disk and no plan is. The plan is completed, then scheduled whole.
	func testALoadServedFromDiskCompletesThePlanThenSchedulesIt() async throws {
		let store = makeStore()
		let taste = try profile(revision: 1, genre: "rock")
		try await makeModel(store: store).load(for: taste)
		let history = await store.history()
		let today = try XCTUnwrap(history.first { $0.localDate == "2026-11-17" })
		_ = await store.save([today])
		let center = FakeReminderCenter(status: .authorized, pending: ["daily-2026-11-18"])
		let model = try makeModel(store: store)

		await model.load(for: taste)
		await makeSync(center).sync(model, for: taste)

		XCTAssertEqual(model.upcoming.map(\.localDate), Self.days)
		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, Self.identifiers)
	}

	/// Two syncs that overlap must not interleave their `replace`: the second waits for the first.
	func testASecondSyncWaitsForTheFirstReplaceToEnd() async throws {
		let center = FakeReminderCenter(status: .authorized, holdsFirstAuthorization: true)
		let sync = makeSync(center)
		let model = try makeModel(store: makeStore())
		let rock = try profile(revision: 1, genre: "rock")
		await model.load(for: rock)
		let first = Task { await sync.sync(model, for: rock) }
		var polls = 0
		while await center.authorizationReads == 0, polls < 500 {
			polls += 1
			try await Task.sleep(nanoseconds: 10_000_000)
		}

		let jazz = try profile(revision: 2, genre: "jazz")
		await model.load(for: jazz)
		let second = Task { await sync.sync(model, for: jazz) }
		// The first `replace` is held at its authorization check; the second must not have reached it.
		try await Task.sleep(nanoseconds: 100_000_000)
		let reads = await center.authorizationReads
		XCTAssertEqual(reads, 1)

		await center.release()
		await first.value
		await second.value

		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, Self.identifiers)
		let added = await center.added
		XCTAssertEqual(added.suffix(7).map(\.body), model.upcoming.map(\.body))
	}

	// MARK: Helpers

	private func makeSync(_ center: FakeReminderCenter) -> ReminderSync {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = .gmt
		return ReminderSync(
			scheduler: ReminderScheduler(center: center, calendar: calendar, now: { Self.fixed }))
	}

	/// Each store has a directory of its own; a test that needs the same disk twice passes the same store.
	private func makeStore() -> DailyRecommendationStore {
		DailyRecommendationStore(
			localStore: LocalStore(directoryURL: directoryURL.appending(path: UUID().uuidString)))
	}

	/// `readable` false is a catalog that cannot be read.
	private func makeModel(store: DailyRecommendationStore, readable: Bool = true) throws -> TodayViewModel {
		let result: APIResult<Catalog>
		if readable {
			result = .success(try catalog(), etag: nil)
		} else {
			result = .failure(.network)
		}
		return TodayViewModel(readCatalog: { result }, store: store, now: { Self.fixed }, timeZone: { .gmt })
	}

	private func profile(revision: Int, genre: String) throws -> Profile {
		let json: [String: Any] = [
			"version": Profile.version, "local_id": "5B1D3F0A-0000-4000-8000-0000000000AA",
			"genre_ids": ["genre:\(genre)"], "revision": revision, "onboarding_completed": true,
			"flow_id": "5B1D3F0A-0000-4000-8000-0000000000BB", "created_at": 0,
		]
		return try JSONDecoder().decode(Profile.self, from: JSONSerialization.data(withJSONObject: json))
	}

	/// Two genres, each with an album and a track: other tastes give other works.
	private func catalog() throws -> Catalog {
		let works = [
			("project:beta", "genre:rock"), ("track:gamma", "genre:rock"),
			("project:epsilon", "genre:jazz"), ("track:zeta", "genre:jazz"),
		]
		let genres = [("genre:rock", "Rock"), ("genre:jazz", "Jazz")]
		let titles = [
			("project:beta", "Beta"), ("track:gamma", "Gamma"), ("project:epsilon", "Epsilon"), ("track:zeta", "Zeta"),
		]
		let nodes = genres + titles
		let payload: [String: Any] = [
			"version": "v1", "revision": "sha256:" + String(repeating: "0123456789abcdef", count: 4),
			"taxonomy": ["mode": "degraded", "available": true],
			"nodes": nodes.map { id, name in
				["identity": id, "type": String(id.prefix { $0 != ":" }), "name": name, "teaser": NSNull()]
			},
			"edges": works.map { ["source": $0.0, "target": $0.1, "type": "genres"] },
		]
		return try JSONDecoder().decode(Catalog.self, from: JSONSerialization.data(withJSONObject: payload))
	}
}

/// Records what the scheduler asks of the center and behaves like the system for the rest: adding an
/// identifier that is already pending replaces it.
private actor FakeReminderCenter: ReminderCenter {
	struct Added: Equatable, Sendable {
		let identifier: String
		let title: String
		let body: String
		let date: DateComponents
	}

	private let status: ReminderAuthorization
	private let holdsFirstAuthorization: Bool
	private var gate: CheckedContinuation<Void, Never>?
	private var pending: [String]
	private(set) var added: [Added] = []
	private(set) var removals: [[String]] = []
	private(set) var authorizationReads = 0
	private(set) var authorizationRequests = 0

	/// `holdsFirstAuthorization` keeps a `replace` in flight: its first `authorization()` waits for `release()`.
	init(status: ReminderAuthorization, pending: [String] = [], holdsFirstAuthorization: Bool = false) {
		self.status = status
		self.pending = pending
		self.holdsFirstAuthorization = holdsFirstAuthorization
	}

	func authorization() async -> ReminderAuthorization {
		authorizationReads += 1
		if holdsFirstAuthorization, authorizationReads == 1 {
			await withCheckedContinuation { gate = $0 }
		}
		return status
	}

	func release() {
		gate?.resume()
		gate = nil
	}

	func requestAuthorization() async -> Bool {
		authorizationRequests += 1
		return status == .authorized
	}

	func pendingIdentifiers() async -> [String] { pending }

	func remove(identifiers: [String]) async {
		removals.append(identifiers)
		pending.removeAll { identifiers.contains($0) }
	}

	func add(identifier: String, title: String, body: String, date: DateComponents) async {
		added.append(Added(identifier: identifier, title: title, body: body, date: date))
		pending.removeAll { $0 == identifier }
		pending.append(identifier)
	}
}
