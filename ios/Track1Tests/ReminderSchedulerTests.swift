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
	private var pending: [String]
	private(set) var added: [Added] = []
	private(set) var removals: [[String]] = []

	init(status: ReminderAuthorization, pending: [String] = []) {
		self.status = status
		self.pending = pending
	}

	func authorization() async -> ReminderAuthorization { status }

	func requestAuthorization() async -> Bool { status == .authorized }

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
