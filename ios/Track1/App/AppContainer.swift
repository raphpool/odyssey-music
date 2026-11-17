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
	/// The boundary the scheduler and the opt-in screen share: the system center, or a fake under UI tests.
	let reminderCenter: any ReminderCenter
	let reminderPrompt: ReminderPromptFlag
	let onboardingCatalog: (@Sendable () async -> APIResult<Catalog>)?

	init(configurationResult: Result<AppConfiguration, AppConfigurationError> = AppConfiguration.load()) {
		self.configurationResult = configurationResult
		router = AppRouter()
		let center: any ReminderCenter
		#if targetEnvironment(simulator)
			let processInfo = ProcessInfo.processInfo
			let fakeCenter = UITestFixtureReaders.reminderCenter(environment: processInfo.environment)
			center = fakeCenter ?? SystemReminderCenter()
			reminderPrompt = ReminderPromptFlag(
				resetBeforeUse: processInfo.arguments.contains("-track1-reset-reminder-prompt"))
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
			center = SystemReminderCenter()
			reminderPrompt = ReminderPromptFlag()
			let localStore = LocalStore()
			let resetProfile = false
			let seedCorruptProfile = false
			let resetDailyRecommendation = false
			onboardingCatalog = nil
		#endif
		reminderCenter = center
		reminders = ReminderSync(scheduler: ReminderScheduler(center: center, calendar: Self.reminderCalendar))
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
		await replace(with: plan)
	}

	/// The person has just said yes on a profile that already exists (TRA-746). Today may have been served from
	/// the cache for days, so the plan on disk would only be scheduled again at the change of day.
	///
	/// A load that serves the entry of the day, then `extendPlanIfNeeded`, go through `sync` like Today's:
	/// that covers a plan to complete or a work to pick. When the plan on disk already reaches the horizon,
	/// neither plans anything (`upcoming` stays empty: "nothing new"), yet that is the plan to schedule: it is
	/// then read back from the history, with the bodies of the current catalog. An empty plan is never sent.
	func scheduleStoredPlan(
		for profile: Profile, readCatalog: @escaping @Sendable () async -> APIResult<Catalog>,
		store: DailyRecommendationStore, now: @escaping () -> Date = { .now },
		timeZone: @escaping () -> TimeZone = { .current }
	) async {
		let model = TodayViewModel(readCatalog: readCatalog, store: store, now: now, timeZone: timeZone)
		await model.load(for: profile)
		await sync(model, for: profile)
		guard !Task.isCancelled, case .recommendation = model.state, model.upcoming.isEmpty else { return }
		let today = DailySelection.localDate(for: now(), timeZone: timeZone())
		let plan = await storedPlan(for: profile, readCatalog: readCatalog, store: store, today: today)
		guard !Task.isCancelled, !plan.isEmpty else { return }
		await replace(with: plan)
	}

	/// The days after `today` that the history holds for the tastes of `profile`, one per date, in date order.
	/// Projects and tracks only, the types `Affinity` recommends. Nothing without a catalog to write the bodies.
	private func storedPlan(
		for profile: Profile, readCatalog: @Sendable () async -> APIResult<Catalog>,
		store: DailyRecommendationStore, today: String
	) async -> [PlannedReminder] {
		let stored = await store.history().filter {
			$0.localDate > today && $0.profileRevision == profile.revision
				&& ($0.nodeType == .project || $0.nodeType == .track)
		}
		guard !stored.isEmpty, case .success(let catalog, _) = await readCatalog() else { return [] }
		// The last entry of a date wins, as the store keeps the history in the order it was written.
		let byDate = Dictionary(stored.map { ($0.localDate, $0) }, uniquingKeysWith: { _, later in later })
		return byDate.values.sorted { $0.localDate < $1.localDate }.map { entry in
			PlannedReminder(
				localDate: entry.localDate, hour: ReminderPlan.hour, title: ReminderPlan.title,
				body: ReminderPlan.body(for: entry, catalog: catalog), recommendation: entry)
		}
	}

	private func replace(with plan: [PlannedReminder]) async {
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

/// Whether the opt-in screen was already shown to this install (TRA-746). The onboarding shows it to a new
/// profile; a profile made before it existed sees it once, at a launch where the system was not asked yet.
/// The flag is raised as the screen is claimed, not once it is answered: a person who leaves the app on it is
/// not shown it at every launch.
@MainActor
struct ReminderPromptFlag {
	static let key = "track1.reminder-prompt-seen"

	private let defaults: UserDefaults

	/// `resetBeforeUse` is for the UI tests, which reproduce a profile made before the screen existed.
	init(defaults: UserDefaults = .standard, resetBeforeUse: Bool = false) {
		if resetBeforeUse { defaults.removeObject(forKey: Self.key) }
		self.defaults = defaults
	}

	var hasBeenSeen: Bool { defaults.bool(forKey: Self.key) }

	func markSeen() {
		defaults.set(true, forKey: Self.key)
	}

	/// True once, when the screen has never been shown and the system has not been asked: the flag is raised
	/// before this returns, so that the screen is claimed by one caller only. An authorization already granted
	/// or refused is never asked again, so the screen stays out of the way.
	func claimPresentation(center: any ReminderCenter) async -> Bool {
		guard !hasBeenSeen, await center.authorization() == .notDetermined else { return false }
		// Read again: another launch task may have claimed it while the center answered.
		guard !hasBeenSeen else { return false }
		markSeen()
		return true
	}
}
