import SwiftUI
import UserNotifications

@main
struct Track1App: App {
	@State private var container: AppContainer
	/// `UNUserNotificationCenter` holds its delegate weakly: the app is what keeps it alive.
	private let notificationDelegate: ReminderNotificationDelegate

	init() {
		let container = AppContainer()
		let delegate = ReminderNotificationDelegate(router: container.router)
		// During the launch: a reminder tapped while the app was not running is delivered once there is a delegate.
		UNUserNotificationCenter.current().delegate = delegate
		_container = State(initialValue: container)
		notificationDelegate = delegate
	}

	var body: some Scene {
		WindowGroup {
			RootView(container: container)
				.tint(Track1Tokens.colorTextAction)
				.environment(\.reminderSync, container.reminders)
		}
	}
}

/// Opens the app on Today when a daily reminder is tapped; shows nothing while the app is in the foreground.
@MainActor
final class ReminderNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
	/// The person is already in the app: no banner and no sound for the reminder of the day.
	static let foregroundPresentation: UNNotificationPresentationOptions = []

	private let router: AppRouter

	init(router: AppRouter) {
		self.router = router
	}

	/// Without a profile the onboarding stands in for the tabs, so the tap then only opens the app.
	func open(identifier: String) {
		guard ReminderRouting.opensToday(identifier: identifier) else { return }
		router.showToday()
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter, willPresent notification: UNNotification
	) async -> UNNotificationPresentationOptions {
		Self.foregroundPresentation
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
	) async {
		open(identifier: response.notification.request.identifier)
	}
}
