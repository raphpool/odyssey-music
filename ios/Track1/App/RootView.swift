import SwiftUI
import Track1Core
import UIKit

struct RootView: View {
	@Bindable var container: AppContainer
	@Environment(\.scenePhase) private var scenePhase

	var body: some View {
		Group {
			switch container.configurationResult {
			case .success:
				if let analytics = container.analytics {
					if !analytics.hasLoadedConsent {
						SplashView()
					} else if analytics.consent.status == .unknown {
						PrivacyChoiceView(
							consent: analytics.consent,
							accept: { Task { await analytics.grant() } },
							decline: { Task { await analytics.deny() } }
						)
					} else {
						ApplicationTabs(
							router: container.router,
							readers: container.readers,
							imageStore: container.imageStore,
							onboardingCatalog: container.onboardingCatalog,
							genreCatalog: container.genreCatalog,
							analytics: analytics,
							profileStore: container.profileStore,
							reminderCenter: container.reminderCenter,
							reminderPrompt: container.reminderPrompt,
							recentNodes: container.recentNodes,
							dailyRecommendationStore: container.dailyRecommendationStore
						)
					}
				} else {
					InvalidConfigurationView(error: .missingEnvironment)
				}
			case .failure(let error):
				InvalidConfigurationView(error: error)
			}
		}
		.onChange(of: scenePhase, initial: true) { _, phase in
			container.analytics?.scenePhaseChanged(to: phase)
		}
	}
}

private struct ApplicationTabs: View {
	@Bindable var router: AppRouter
	let readers: ContentReaders?
	let imageStore: NodeImageStore<UIImage>?
	let onboardingCatalog: (@Sendable () async -> APIResult<Catalog>)?
	let genreCatalog: GenreCatalogStore?
	let analytics: AnalyticsClient
	let profileStore: ProfileStore
	let reminderCenter: any ReminderCenter
	let reminderPrompt: ReminderPromptFlag
	let recentNodes: RecentNodesStore
	let dailyRecommendationStore: DailyRecommendationStore
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.reminderSync) private var reminders
	@State private var profileState = ProfileRead.missing
	/// False until the profile has been read once: `.missing` before that is not a first launch, and the
	/// onboarding must not flash for a person who has a profile.
	@State private var profileLoaded = false
	/// The window's bottom safe area, handed to the tab bar (see `tabs`). Seeded from the key window so that
	/// the first frame is not drawn with 0, which the probe only corrects one turn of the main loop later.
	@State private var windowSafeAreaBottom: CGFloat = KeyWindowSafeArea.bottom
	/// The opt-in screen over the tabs, for a profile made before it existed (TRA-746).
	@State private var showsReminderPrompt = false

	/// What the app shows for the state of the profile (J.4): no profile is the full-screen onboarding, without
	/// the tabs, and the saved profile fades into them.
	private enum Gate: Equatable {
		case loading
		case onboarding
		/// The store could not be read: the profile may exist, so it is not an invitation to write a new one.
		case unavailable
		case tabs
	}

	private var gate: Gate {
		guard profileLoaded else { return .loading }
		switch profileState {
		case .missing: return .onboarding
		case .unavailable: return .unavailable
		case .profile, .corrupt, .unsupportedVersion: return .tabs
		}
	}

	var body: some View {
		ZStack {
			switch gate {
			case .loading:
				SplashView()
			case .onboarding:
				FirstLaunchOnboardingView(
					profileStore: profileStore,
					analytics: analytics,
					reminderCenter: reminderCenter,
					loadCatalog: onboardingLoader,
					finished: profileWasCreated
				)
				.transition(.opacity)
			case .unavailable:
				Track1StatusView(.todayUnavailable) { Task { await reloadProfile() } }
					.todayBackdrop()
					.transition(.opacity)
			case .tabs:
				tabsWithFeedback.transition(.opacity)
			}
		}
		// The fade from the onboarding to the tabs; immediate under Reduce Motion.
		.animation(Track1Motion.animation(.slow, reduceMotion: reduceMotion), value: gate)
		.task {
			await reloadProfile()
			warmUpGenreCatalog()
			await presentReminderPromptIfNeeded()
		}
		// Over the tabs, which stay mounted under it: the screen is the one of the onboarding, full height.
		.fullScreenCover(isPresented: $showsReminderPrompt) {
			NotificationOptInView(center: reminderCenter, onContinue: reminderPromptAnswered)
		}
	}

	/// The onboarding reads the catalog once, and what it reads feeds the Genres snapshot, so that the tab has
	/// its genres from the first launch on.
	private var onboardingLoader: (@Sendable () async -> APIResult<Catalog>)? {
		let loader = onboardingCatalog ?? readers?.catalog
		guard let loader else { return nil }
		return genreCatalog?.remembering(loader) ?? loader
	}

	/// A device that already had a profile before the snapshot existed has none on disk yet: it is made at the
	/// launch, not when the tab opens. Unstructured, so that a tab change, which cancels the view task and the
	/// request with it, does not leave the write undone.
	private func warmUpGenreCatalog() {
		guard case .profile = profileState, let genreCatalog else { return }
		Task { _ = await genreCatalog.load() }
	}

	// 2026-10-13 (TRA-383): no tint here; the Nocturne action tint set at the app root must reach the tabs.
	private var tabsWithFeedback: some View {
		tabs
			.environment(\.recentNodes, recentNodes)
			.sensoryFeedback(.selection, trigger: router.selectedTab)
	}

	/// The profile of the first launch is saved: Today loads its first recommendation (screen 1.6) under the
	/// fade.
	///
	/// 2026-11-17 (TRA-735): the history of recommendations is emptied first, and the tabs only appear once it
	/// is. Erasing a profile from the settings leaves the history on disk, and Today serves the entry of the
	/// current date as it is when its profile revision matches: the first revision of the new profile got the
	/// work picked for the previous one. A failed write does not hold the person on the onboarding, so it can
	/// still leave that entry behind, as can a stop of the app between the profile write and this one. The
	/// durable fix is to empty the history where the profile is erased, which is not in this ticket's scope.
	private func profileWasCreated(_ profile: Profile) {
		// The opt-in was the last step of the flow: it is not offered again at a later launch.
		reminderPrompt.markSeen()
		Task {
			_ = await dailyRecommendationStore.save([])
			profileState = .profile(profile)
			router.select(.today)
		}
	}

	/// Selecting a tab goes through the router, which also handles a second tap on Today (D8).
	private var tabSelection: Binding<AppTab> {
		Binding(get: { router.selectedTab }, set: { router.select($0) })
	}

	/// One `TabView` for the per-tab stacks and the selection; the bar is drawn by `Track1TabBar` (D1), not by
	/// the system, so there is a single code path from iOS 17 to 26.
	///
	/// 2026-10-24 (TRA-671, ios-check of #601, runs 40093331852 to 40104135204): the bar was first an inset of
	/// the `TabView`, then of each `NavigationStack`. Neither reaches the screens hosted inside the stack: the
	/// `.safeAreaInset` button of the Genres tab sat at the window's safe area (bottom at 840 = 874 - 34) as if
	/// the bar did not exist, `genres-edit` at {{98.3, 776}, {205.3, 52}} under `tab-bar` at {{0, 754}, {402, 120}},
	/// hit point {-1, -1}, the edit sheet never opened. So the bar is a fixed overlay of the `TabView`, and each
	/// screen reserves its height itself (`tabBarReservation`).
	private var tabs: some View {
		TabView(selection: tabSelection) {
			entry(for: .today).tag(AppTab.today)
			entry(for: .genres).tag(AppTab.genres)
		}
		// The window's bottom safe area, read from the window itself (`WindowSafeAreaReader`).
		//
		// 2026-11-21 (TRA-796, TestFlight build 1, iPhone 393 x 852, iOS 26): this was the
		// `safeAreaInsets.bottom` of a `GeometryReader` in this background, and it read 0 under a `TabView`. The
		// tab bar then added the 12 pt of a screen without a home indicator (pill at 744 to 806, 12 pt too high)
		// and the Now bar of the reader ended at 762, over the tab bar. The window does not depend on the
		// insets of the view tree, and it leaves the keyboard out, so the bar does not move while a field is
		// focused.
		.background {
			WindowSafeAreaReader { windowSafeAreaBottom = $0 }
		}
		.overlay(alignment: .bottom) { tabBar }
	}

	/// Leaves the room of the bar at the bottom of a screen, above the window's safe area: the content, and the
	/// `safeAreaInset` buttons it places itself, then end where the bar starts. Applied to the root of each tab
	/// and to every pushed page, inside the stack; one modifier so that a new destination cannot forget it.
	private var tabBarReservation: some ViewModifier {
		TabBarReservation(safeAreaBottom: windowSafeAreaBottom)
	}

	private var tabBar: some View {
		Track1TabBar(
			items: [item(.today), item(.genres)],
			selected: router.selectedTab.rawValue,
			safeAreaBottom: windowSafeAreaBottom,
			onSelect: { id in
				if let tab = AppTab(rawValue: id) { router.select(tab) }
			}
		)
		// Without this the field of the Genres tab would lift the bar with the keyboard (R5).
		.ignoresSafeArea(.keyboard, edges: .bottom)
	}

	private func item(_ tab: AppTab) -> Track1TabBar.Item {
		Track1TabBar.Item(
			id: tab.rawValue, icon: tab.icon, label: tab.title, identifier: tab.accessibilityIdentifier)
	}

	@ViewBuilder
	private func entry(for tab: AppTab) -> some View {
		NavigationStack(path: router.pathBinding(for: tab)) {
			Group {
				switch tab {
				case .today:
					TodayEntryView(
						profileState: profileState,
						today: { profile in todayView(for: profile) },
						exploreSearch: { router.select(.genres) },
						recoverProfile: { router.select(.genres) }
					)
				case .genres:
					GenresTabView(
						profileState: profileState,
						profileStore: profileStore,
						recentNodes: recentNodes,
						analytics: analytics,
						genreCatalog: genreCatalog,
						// The recommendation of the day follows the new revision: Today reads the profile it is given,
						// and its load is keyed on the revision. 2026-11-17 (TRA-737): the tab stays on screen, as the
						// genres are saved in place from it; it used to jump to Today when its edit sheet closed.
						profileWasSaved: { profile in profileState = .profile(profile) },
						profileWasCleared: { profileState = .missing }
					)
				}
			}
			.modifier(tabBarReservation)
			.navigationDestination(for: AppRoute.self) { route in
				Group {
					switch route {
					case .player(let identity, let context):
						if let readers, let imageStore {
							PlayerDestination(
								model: NodeViewModel(
									identity: identity,
									context: context,
									readNode: readers.node,
									readLinks: readers.links,
									recordEvent: { analytics.record($0) }
								),
								imageStore: imageStore,
								safeAreaBottom: windowSafeAreaBottom,
								onBack: { router.pop(in: .today) }
							)
							// The reader draws its own back button: no system bar over it.
							.toolbar(.hidden, for: .navigationBar)
						} else {
							InvalidConfigurationView(error: .missingEnvironment)
						}
					// No caller since TRA-736 (see `AppRoute.node`); the node page stays compiled until it is deleted.
					case .node(let identity, let context):
						if let readers, let imageStore {
							NodeView(
								model: NodeViewModel(
									identity: identity,
									context: context,
									readNode: readers.node,
									readLinks: readers.links,
									recordEvent: { analytics.record($0) }
								),
								imageStore: imageStore,
								topBar: .breadcrumb(router.breadcrumb(for: tab, rootTitle: tab.title)),
								// Same tab; the name is the crumb the Top bar shows for the relation.
								openRelation: { relation, relationContext in
									router.openNode(relation.slug, context: relationContext, title: relation.name, in: tab)
								},
								selectCrumb: { crumb in router.popTo(index: crumb.index, in: tab) }
							)
						} else {
							InvalidConfigurationView(error: .missingEnvironment)
						}
					}
				}
				.modifier(tabBarReservation)
			}
		}
		// On the stack, not on its root view: from a pushed page the native bar would come back otherwise (R1).
		.toolbar(.hidden, for: .tabBar)
	}

	@ViewBuilder
	private func todayView(for profile: Profile) -> some View {
		if let readers, let imageStore {
			TodayView(
				profile: profile,
				router: router,
				readers: readers,
				imageStore: imageStore,
				store: dailyRecommendationStore,
				analytics: analytics
			)
		} else {
			InvalidConfigurationView(error: .missingEnvironment)
		}
	}

	private func reloadProfile() async {
		profileState = await profileStore.read()
		profileLoaded = true
	}

	/// A profile made before the opt-in existed sees it once, at launch, over the tabs: only when the system has
	/// not been asked and the screen was never shown. A new profile went through it in the onboarding. The flag
	/// is raised by the claim, as the screen is about to show.
	private func presentReminderPromptIfNeeded() async {
		guard case .profile = profileState, await reminderPrompt.claimPresentation(center: reminderCenter)
		else { return }
		showsReminderPrompt = true
	}

	/// "Continuer" was touched and the system answered. A yes plans the reminders now: Today may be served from
	/// the cache, which would leave the plan on disk unscheduled until the next day (TRA-747, TRA-746). A second
	/// call, from a double touch, finds the screen already closed.
	private func reminderPromptAnswered(granted: Bool) {
		guard showsReminderPrompt else { return }
		showsReminderPrompt = false
		guard granted, case .profile(let profile) = profileState, let reminders, let readers else { return }
		let store = dailyRecommendationStore
		Task {
			await reminders.scheduleStoredPlan(for: profile, readCatalog: readers.catalog, store: store)
		}
	}
}

private struct TodayEntryView<Today: View>: View {
	let profileState: ProfileRead
	@ViewBuilder let today: (Profile) -> Today
	let exploreSearch: () -> Void
	let recoverProfile: () -> Void

	var body: some View {
		switch profileState {
		case .profile(let profile):
			today(profile)
		case .missing, .unavailable:
			// The host shows the onboarding or the unavailable status instead of the tabs for these two (J.4).
			// They only reach this entry while the tabs fade out, so it draws the base color and nothing else.
			Track1Tokens.colorBackgroundBase.ignoresSafeArea()
		case .corrupt, .unsupportedVersion:
			ProfileRecoveryView(
				description: profileState.recoveryDescription,
				recoverProfile: recoverProfile,
				exploreSearch: exploreSearch
			)
		}
	}
}

private struct ProfileRecoveryView: View {
	let description: String
	let recoverProfile: () -> Void
	let exploreSearch: () -> Void

	var body: some View {
		// Scrolls when the column outgrows the screen (accessibility sizes): "Ouvrir Genres" is the way out.
		GeometryReader { proxy in
			ScrollView {
				column.frame(maxWidth: .infinity, minHeight: proxy.size.height)
			}
			.scrollBounceBehavior(.basedOnSize)
		}
		.todayBackdrop()
		.toolbar(.hidden, for: .navigationBar)
	}

	private var column: some View {
		VStack(spacing: Track1Tokens.spacing16) {
			Track1Text("Profil local à récupérer", role: .title3)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
				.accessibilityAddTraits(.isHeader)
			Track1Text(
				"\(description) Supprimez-le depuis les réglages de l’onglet Genres avant de recommencer.",
				role: .bodyMedium
			)
			.foregroundStyle(Track1Tokens.colorTextSecondary)
			.accessibilityIdentifier("profile-recovery-message")
			VStack(spacing: Track1Tokens.spacing12) {
				Track1Button("Ouvrir Genres", kind: .primary, size: .large, action: recoverProfile)
				Track1Button("Explorer la recherche", kind: .secondary, size: .medium, action: exploreSearch)
			}
			.padding(.top, Track1Tokens.spacing8)
		}
		.multilineTextAlignment(.center)
		.padding(Track1Tokens.spacing24)
	}
}

/// The reader pushed by "Découvrir". `PlayerView` keeps its model in a `let`, so the model lives here, in
/// `@State`.
/// 2026-11-17 (TRA-736, ios-check run 44116321948): the destination closure of the stack runs again at every
/// change of the router or of the window, and each run built a new `NodeViewModel` that nobody loaded (the
/// `.task` of the reader does not restart), so the reader stayed on its splash and `player-paragraph-0` never
/// appeared. `NodeView` holds its model in `@State` for the same reason.
private struct PlayerDestination: View {
	@State private var model: NodeViewModel
	private let imageStore: NodeImageStore<UIImage>
	private let safeAreaBottom: CGFloat
	private let onBack: () -> Void

	init(
		model: NodeViewModel, imageStore: NodeImageStore<UIImage>, safeAreaBottom: CGFloat,
		onBack: @escaping () -> Void
	) {
		_model = State(initialValue: model)
		self.imageStore = imageStore
		self.safeAreaBottom = safeAreaBottom
		self.onBack = onBack
	}

	var body: some View {
		PlayerView(model: model, imageStore: imageStore, safeAreaBottom: safeAreaBottom, onBack: onBack)
	}
}

private struct InvalidConfigurationView: View {
	let error: AppConfigurationError

	var body: some View {
		ContentUnavailableView {
			Label("Configuration requise", systemImage: "exclamationmark.triangle")
		} description: {
			Text(error.userMessage)
		}
		.accessibilityIdentifier("invalid-configuration")
		.accessibilityElement(children: .combine)
		.accessibilityLabel("Configuration requise. \(error.userMessage)")
	}
}

/// The bottom safe area of the key window, read now. Only a seed: `WindowSafeAreaReader` stays the source
/// that follows the window afterwards. It is 0 when no window is key yet.
private enum KeyWindowSafeArea {
	static var bottom: CGFloat {
		MainActor.assumeIsolated {
			UIApplication.shared.connectedScenes
				.compactMap { $0 as? UIWindowScene }
				.flatMap(\.windows)
				.first(where: \.isKeyWindow)?.safeAreaInsets.bottom ?? 0
		}
	}
}

/// Reports the bottom safe area of the window that hosts it: when it joins the window, then each time its
/// layout changes (rotation, scene change). Nothing is reported while the view is not in a window.
private struct WindowSafeAreaReader: UIViewRepresentable {
	let onChange: (CGFloat) -> Void

	func makeUIView(context: Context) -> WindowSafeAreaProbe {
		WindowSafeAreaProbe()
	}

	func updateUIView(_ uiView: WindowSafeAreaProbe, context: Context) {
		uiView.onChange = onChange
		uiView.report()
	}
}

private final class WindowSafeAreaProbe: UIView {
	var onChange: ((CGFloat) -> Void)?
	private var lastReported: CGFloat?

	override init(frame: CGRect) {
		super.init(frame: frame)
		isUserInteractionEnabled = false
		isAccessibilityElement = false
	}

	@available(*, unavailable)
	required init?(coder: NSCoder) {
		fatalError("init(coder:) is not used")
	}

	override func didMoveToWindow() {
		super.didMoveToWindow()
		report()
	}

	override func layoutSubviews() {
		super.layoutSubviews()
		report()
	}

	override func safeAreaInsetsDidChange() {
		super.safeAreaInsetsDidChange()
		report()
	}

	/// Only a change is sent, and one turn of the main loop later: this can run while SwiftUI updates its
	/// views, where a write to `@State` is refused.
	func report() {
		guard let inset = window?.safeAreaInsets.bottom, inset != lastReported, onChange != nil else { return }
		lastReported = inset
		Task { @MainActor [weak self] in self?.onChange?(inset) }
	}
}

/// Reserves the height of the drawn tab bar at the bottom of a screen, as extra bottom safe area (iOS 17).
private struct TabBarReservation: ViewModifier {
	let safeAreaBottom: CGFloat

	func body(content: Content) -> some View {
		content.safeAreaPadding(.bottom, Track1TabBarMetrics.reservedHeight(safeAreaBottom: safeAreaBottom))
	}
}
