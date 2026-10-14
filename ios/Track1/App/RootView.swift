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
						ProgressView()
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

private struct ChosenResult {
	let identity: NodeIdentity
	let context: NavigationContext
	let title: String
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
	/// The name of the node of the day: the root crumb of every page pushed from Today.
	@State private var todayRootTitle: String?
	/// The result chosen in the search sheet. The page is pushed once the sheet is gone, not under it.
	@State private var chosenResult: ChosenResult?

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
				Track1Tokens.colorBackgroundBase.ignoresSafeArea()
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
				tabsWithSheets.transition(.opacity)
			}
		}
		// The fade from the onboarding to the tabs; immediate under Reduce Motion.
		.animation(Track1Motion.animation(.slow, reduceMotion: reduceMotion), value: gate)
		.task { await reloadProfile() }
	}

	private var tabsWithSheets: some View {
		tabs
			.environment(\.recentNodes, recentNodes)
			.sensoryFeedback(.selection, trigger: router.selectedTab)
			// Search does not change the selected tab, but tapping it is still a tab change for the hand.
			.sensoryFeedback(.selection, trigger: router.isSearchPresented) { _, isPresented in isPresented }
			// 2026-10-13 (TRA-383): no tint here; the Nocturne action tint set at the app root must reach the tabs.
			.sheet(isPresented: $router.isSearchPresented, onDismiss: openChosenResult) { searchSheet }
	}

	/// The profile of the first launch is saved: Today loads its first recommendation (screen 1.6) under the fade.
	private func profileWasCreated(_ profile: Profile) {
		profileState = .profile(profile)
		router.select(.today)
	}

	/// Selecting a tab goes through the router: Search opens its sheet instead of changing the tab (D8).
	private var tabSelection: Binding<AppTab> {
		Binding(get: { router.selectedTab }, set: { router.select($0) })
	}

	@ViewBuilder
	private var tabs: some View {
		if #available(iOS 26, *) {
			// Native Liquid Glass bar; the search role draws the isolated round button of the Figma.
			TabView(selection: tabSelection) {
				Tab(AppTab.today.title, systemImage: AppTab.today.glyph.systemName, value: AppTab.today) {
					entry(for: .today)
				}
				Tab(AppTab.genres.title, systemImage: AppTab.genres.glyph.systemName, value: AppTab.genres) {
					entry(for: .genres)
				}
				Tab(
					AppTab.search.title, systemImage: AppTab.search.glyph.systemName, value: AppTab.search,
					role: .search
				) {
					// Never shown: selecting Search opens the sheet and keeps the current tab.
					Color.clear
				}
			}
		} else {
			TabView(selection: tabSelection) {
				ForEach(AppTab.allCases) { tab in
					Group {
						if tab == .search { Color.clear } else { entry(for: tab) }
					}
					// The glass of iOS 26 does not exist before: a frosted bar is the closest native fallback.
					// It goes on the tab content, where SwiftUI reads it, not on the `TabView`.
					.toolbarBackground(.visible, for: .tabBar)
					.toolbarBackground(.ultraThinMaterial, for: .tabBar)
					.tabItem { Label(tab.title, systemImage: tab.glyph.systemName) }
					.tag(tab)
				}
			}
		}
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
						exploreSearch: { router.select(.search) },
						recoverProfile: { router.select(.genres) }
					)
				case .search:
					// Search has no stack: its sheet is presented by the router and its results open on the selected tab.
					EmptyView()
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
			.navigationDestination(for: AppRoute.self) { route in
				switch route {
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
							topBar: .breadcrumb(
								router.breadcrumb(for: tab, rootTitle: tab == .today ? todayRootTitle ?? tab.title : tab.title)),
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
		}
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
				analytics: analytics,
				rootTitle: $todayRootTitle
			)
		} else {
			InvalidConfigurationView(error: .missingEnvironment)
		}
	}

	@ViewBuilder
	private var searchSheet: some View {
		if let readers {
			SearchSheetView(
				search: readers.search,
				recents: recentNodes,
				recordEvent: { analytics.record($0) },
				open: { identity, context, title in
					chosenResult = ChosenResult(identity: identity, context: context, title: title)
					router.isSearchPresented = false
				}
			)
		} else {
			InvalidConfigurationView(error: .missingEnvironment)
		}
	}

	/// The current tab keeps its stack: the page goes on top of it, and the breadcrumb starts from there (G.1).
	/// A sheet closed by a swipe leaves nothing chosen.
	private func openChosenResult() {
		guard let result = chosenResult else { return }
		chosenResult = nil
		router.openNode(result.identity, context: result.context, title: result.title, in: router.selectedTab)
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
