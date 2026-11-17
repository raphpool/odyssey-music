import Foundation
import Track1Core
import UserNotifications

/// What the person let the app do with notifications, reduced to what the scheduler needs to know.
enum ReminderAuthorization: Equatable, Sendable {
	case notDetermined
	case denied
	case authorized
}

/// The part of `UNUserNotificationCenter` the scheduler uses (TRA-744, plan D4). The scheduler is tested
/// against a fake of this protocol: the system center cannot run in a unit test, and it is the external
/// boundary, not the scheduler, that is replaced.
protocol ReminderCenter: Sendable {
	func authorization() async -> ReminderAuthorization
	func requestAuthorization() async -> Bool
	func pendingIdentifiers() async -> [String]
	func remove(identifiers: [String]) async
	/// `date` carries the calendar it was validated in, so its fields are read in that calendar and time zone
	/// when it fires, not in the device's.
	func add(identifier: String, title: String, body: String, date: DateComponents) async
}

/// Local notifications only: no push capability, no token, nothing leaves the device.
struct SystemReminderCenter: ReminderCenter {
	func authorization() async -> ReminderAuthorization {
		let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
		switch status {
		case .authorized, .provisional, .ephemeral: return .authorized
		case .notDetermined: return .notDetermined
		case .denied: return .denied
		// A status added by a later system is treated as a refusal: nothing is scheduled without a known yes.
		@unknown default: return .denied
		}
	}

	func requestAuthorization() async -> Bool {
		// The system prompt can fail without the person having refused; either way nothing is authorized.
		(try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
	}

	func pendingIdentifiers() async -> [String] {
		await UNUserNotificationCenter.current().pendingNotificationRequests().map(\.identifier)
	}

	func remove(identifiers: [String]) async {
		UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiers)
	}

	func add(identifier: String, title: String, body: String, date: DateComponents) async {
		let content = UNMutableNotificationContent()
		content.title = title
		content.body = body
		content.sound = .default
		let trigger = UNCalendarNotificationTrigger(dateMatching: date, repeats: false)
		let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
		// A refused request costs that one day's reminder; the next `replace` plans it again.
		try? await UNUserNotificationCenter.current().add(request)
	}
}

/// Turns the plan of the next days into one pending local notification per day. Its notifications are the
/// ones whose identifier starts with `daily-`; any other pending notification is not its to remove.
struct ReminderScheduler: Sendable {
	static let identifierPrefix = "daily-"

	private let center: any ReminderCenter
	private let calendar: Calendar
	private let now: @Sendable () -> Date

	/// `calendar` is the Gregorian one `localDate` is written in, in the time zone the reminders are read in.
	/// `now` is the clock the past-date check reads; tests pass a fixed one.
	init(center: any ReminderCenter, calendar: Calendar, now: @escaping @Sendable () -> Date = { Date() }) {
		self.center = center
		self.calendar = calendar
		self.now = now
	}

	/// Replaces the daily notifications with those of `reminders`. Without authorization it does nothing at
	/// all, not even a removal: the person may grant it later, and the notifications already pending stay as
	/// they are. A reminder whose date is already past, or whose `localDate` is not a real `yyyy-MM-dd` date,
	/// is not added.
	func replace(with reminders: [PlannedReminder]) async {
		guard await center.authorization() == .authorized else { return }
		let stale = await center.pendingIdentifiers().filter { $0.hasPrefix(Self.identifierPrefix) }
		if !stale.isEmpty { await center.remove(identifiers: stale) }
		let current = now()
		for reminder in reminders {
			guard let date = dateComponents(for: reminder), let fireDate = calendar.date(from: date),
				fireDate > current
			else { continue }
			await center.add(
				identifier: Self.identifierPrefix + reminder.localDate, title: reminder.title, body: reminder.body,
				date: date)
		}
	}

	/// Year, month and day of `localDate`, then `reminder.hour` and minute 0. The round trip through the
	/// calendar rejects `2026-02-30` and an hour of 25, which the calendar would otherwise roll over to
	/// another day.
	private func dateComponents(for reminder: PlannedReminder) -> DateComponents? {
		// Digits only, 4-2-2: `Int` alone would accept "2026-1-+01" and the identifier would not be canonical.
		let parts = reminder.localDate.split(separator: "-", omittingEmptySubsequences: false)
		guard parts.map(\.utf8.count) == [4, 2, 2],
			parts.allSatisfy({ part in part.utf8.allSatisfy { (48...57).contains($0) } }),
			let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2])
		else { return nil }
		// The calendar travels with the fields: a trigger reads a bare year in the device's calendar, where
		// 2026 can be another year (Buddhist, Japanese) than the Gregorian one `localDate` is written in.
		var components = DateComponents(year: year, month: month, day: day, hour: reminder.hour, minute: 0)
		components.calendar = calendar
		guard let date = calendar.date(from: components) else { return nil }
		let back = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
		// Field by field: the components the calendar returns may carry a calendar or a zone that ours do not.
		let same =
			back.year == year && back.month == month && back.day == day && back.hour == reminder.hour
			&& back.minute == 0
		return same ? components : nil
	}
}
