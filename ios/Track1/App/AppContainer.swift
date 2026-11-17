import Foundation
import Observation
import Track1Core
import UIKit

@MainActor
@Observable
final class AppContainer {
	let configurationResult: Result<AppConfiguration, AppConfigurationError>
	let router: AppRouter
	let apiClient: APIClient?
	let readers: ContentReaders?
	let imageStore: NodeImageStore<UIImage>?
	let analytics: AnalyticsClient?
	let profileStore: ProfileStore
	let recentNodes: RecentNodesStore
	let dailyRecommendationStore: DailyRecommendationStore
	let reminders: ReminderSync
	let onboardingCatalog: (@Sendable () async -> APIResult<Catalog>)?

	init(configurationResult: Result<AppConfiguration, AppConfigurationError> = AppConfiguration.load()) {
		self.configurationResult = configurationResult
		router = AppRouter()
		reminders = ReminderSync(
			scheduler: ReminderScheduler(center: SystemReminderCenter(), calendar: Self.reminderCalendar))
		#if targetEnvironment(simulator)
			let processInfo = ProcessInfo.processInfo
			let localStore = LocalStore(
				failNextWriteNamed: processInfo.arguments.contains("-track1-fail-next-profile-write")
					? ProfileStore.profileFileName : nil
			)
			let resetProfile = processInfo.arguments.contains("-track1-reset-profile")
			let seedCorruptProfile = processInfo.arguments.contains("-track1-seed-corrupt-profile")
			let resetDailyRecommendation = processInfo.arguments.contains("-track1-reset-daily-recommendation")
			if let fixture = processInfo.environment["TRACK1_PROFILE_CATALOG_JSON"] {
				let result: APIResult<Catalog>
				do {
					result = .success(try JSONDecoder().decode(Catalog.self, from: Data(fixture.utf8)), etag: nil)
				} catch {
					result = .failure(.invalidResponse)
				}
				onboardingCatalog = { result }
			} else {
				onboardingCatalog = nil
			}
		#else
			let localStore = LocalStore()
			let resetProfile = false
			let seedCorruptProfile = false
			let resetDailyRecommendation = false
			onboardingCatalog = nil
		#endif
		profileStore = ProfileStore(
			localStore: localStore,
			resetBeforeUse: resetProfile,
			seedCorruptProfileBeforeUse: seedCorruptProfile
		)
		// 2026-10-14 (I.2): the recents live in the same directory as the profile, and the UI tests share it. Without
		// the reset a journey sees the cards of the previous one, and "no recents, no line" depends on the test order.
		recentNodes = RecentNodesStore(store: localStore, resetBeforeUse: resetProfile)
		dailyRecommendationStore = DailyRecommendationStore(
			localStore: localStore, resetBeforeUse: resetDailyRecommendation)
		switch configurationResult {
		case .success(let configuration):
			let client = APIClient(configuration: configuration)
			apiClient = client
			#if targetEnvironment(simulator)
				let contentReaders =
					UITestFixtureReaders.make(environment: ProcessInfo.processInfo.environment) ?? .live(client)
			#else
				let contentReaders = ContentReaders.live(client)
			#endif
			readers = contentReaders
			imageStore = NodeImageStore(readImage: contentReaders.image, load: { await NodeImageLoader.load(url: $0) })
			analytics = AnalyticsClient(
				configuration: AnalyticsConfiguration(
					writeKey: configuration.segmentWriteKey,
					environment: configuration.environment,
					appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
					buildNumber: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
				)
			)
		case .failure:
			apiClient = nil
			readers = nil
			imageStore = nil
			analytics = nil
		}
		Task { await analytics?.initialize() }
	}

	/// The Gregorian calendar `PlannedReminder.localDate` is written in, in the device's time zone (`load` writes
	/// the day in `TimeZone.current`). It follows the zone, so the 09:00 stays the person's local 09:00.
	private static var reminderCalendar: Calendar {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = .autoupdatingCurrent
		return calendar
	}
}

/// Keeps the daily reminders in step with the plan Today has just loaded (TRA-747).
@MainActor
final class ReminderSync {
	private let scheduler: ReminderScheduler
	/// The last `replace`. It suspends between its removal and its additions, so two started together would
	/// interleave and leave the notifications of both plans: each call starts when the previous one has ended.
	/// Unstructured, so a view task cancelled halfway (a tab change) does not leave a replacement half done.
	private var last: Task<Void, Never>?

	init(scheduler: ReminderScheduler) {
		self.scheduler = scheduler
	}

	/// To be called once `model.load` has returned. Only a load that ended on a recommendation reaches the
	/// scheduler, and never with an empty plan: that means "nothing new to schedule", not "cancel" (a `load`
	/// served from disk plans nothing, TRA-783). The plan is then completed first, and scheduled if not empty.
	func sync(_ model: TodayViewModel, for profile: Profile) async {
		guard !Task.isCancelled, case .recommendation = model.state else { return }
		if model.upcoming.isEmpty { await model.extendPlanIfNeeded(for: profile) }
		// Read after the extension: a task superseded by other tastes leaves the replacement to its successor.
		let plan = model.upcoming
		guard !Task.isCancelled, !plan.isEmpty else { return }
		let previous = last
		let scheduler = scheduler
		let next = Task {
			await previous?.value
			await scheduler.replace(with: plan)
		}
		last = next
		await next.value
	}
}
