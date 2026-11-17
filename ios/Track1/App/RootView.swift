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
							analytics: analytics,
							profileStore: container.profileStore,
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
	let analytics: AnalyticsClient
	let profileStore: ProfileStore
	let recentNodes: RecentNodesStore
	let dailyRecommendationStore: DailyRecommendationStore
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var profileState = ProfileRead.missing
	/// False until the profile has been read once: `.missing` before that is not a first launch, and the
	/// onboarding must not flash for a person who has a profile.
	@State private var profileLoaded = false
	/// The window's bottom safe area, handed to the tab bar (see `tabs`).
	@State private var windowSafeAreaBottom: CGFloat = 0

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
					loadCatalog: onboardingCatalog ?? readers?.catalog,
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
		.task { await reloadProfile() }
	}

	// 2026-10-13 (TRA-383): no tint here; the Nocturne action tint set at the app root must reach the tabs.
	private var tabsWithFeedback: some View {
		tabs
			.environment(\.recentNodes, recentNodes)
			.sensoryFeedback(.selection, trigger: router.selectedTab)
	}

	/// The profile of the first launch is saved: Today loads its first recommendation (screen 1.6) under the fade.
	private func profileWasCreated(_ profile: Profile) {
		profileState = .profile(profile)
		router.select(.today)
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
		// The window's bottom safe area, read here, outside the insets of the tabs: inside one the bar is
		// already above the home indicator and would read 0. The keyboard is left out so that the bar does not
		// change its padding while a field is focused.
		.background {
			GeometryReader { proxy in
				Color.clear.preference(key: WindowSafeAreaBottomKey.self, value: proxy.safeAreaInsets.bottom)
			}
			.ignoresSafeArea(.keyboard, edges: .bottom)
		}
		.onPreferenceChange(WindowSafeAreaBottomKey.self) { windowSafeAreaBottom = $0 }
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
						loadCatalog: onboardingCatalog ?? readers?.catalog,
						// The recommendation of the day follows the new revision: Today reads the profile it is given.
						profileWasSaved: { profile in
							profileState = .profile(profile)
							router.select(.today)
						},
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
							PlayerView(
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

/// The bottom safe area of the window, carried from a background `GeometryReader` to `ApplicationTabs`.
private struct WindowSafeAreaBottomKey: PreferenceKey {
	static let defaultValue: CGFloat = 0

	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
		value = nextValue()
	}
}

/// Reserves the height of the drawn tab bar at the bottom of a screen, as extra bottom safe area (iOS 17).
private struct TabBarReservation: ViewModifier {
	let safeAreaBottom: CGFloat

	func body(content: Content) -> some View {
		content.safeAreaPadding(.bottom, Track1TabBarMetrics.reservedHeight(safeAreaBottom: safeAreaBottom))
	}
}
