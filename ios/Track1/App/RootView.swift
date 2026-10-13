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
							apiClient: container.apiClient,
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
	let apiClient: APIClient?
	let readers: ContentReaders?
	let imageStore: NodeImageStore<UIImage>?
	let onboardingCatalog: (@Sendable () async -> APIResult<Catalog>)?
	let analytics: AnalyticsClient
	let profileStore: ProfileStore
	let recentNodes: RecentNodesStore
	let dailyRecommendationStore: DailyRecommendationStore
	@State private var profileState = ProfileRead.missing
	@State private var showingOnboarding = false
	@State private var profileToEdit: Profile?
	@State private var searchAfterOnboarding = false
	/// The name of the node of the day: the root crumb of every page pushed from Today.
	@State private var todayRootTitle: String?

	var body: some View {
		tabs
			.sensoryFeedback(.selection, trigger: router.selectedTab)
			// Search does not change the selected tab, but tapping it is still a tab change for the hand.
			.sensoryFeedback(.selection, trigger: router.isSearchPresented) { _, isPresented in isPresented }
			// 2026-10-13 (TRA-383): no tint here; the Nocturne action tint set at the app root must reach the tabs.
			.task { await reloadProfile() }
			.sheet(isPresented: $router.isSearchPresented) { SearchSheetPlaceholder() }
			.sheet(isPresented: $showingOnboarding, onDismiss: presentSearchIfRequested) {
				OnboardingView(
					apiClient: apiClient,
					catalogProvider: onboardingCatalog,
					profileStore: profileStore,
					analytics: analytics,
					editingProfile: profileToEdit,
					complete: { profile in
						profileState = .profile(profile)
						showingOnboarding = false
					},
					cancel: { showingOnboarding = false },
					exploreWithoutProfile: {
						searchAfterOnboarding = true
						showingOnboarding = false
					}
				)
			}
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
						chooseProfile: { beginOnboarding(editing: nil) },
						exploreSearch: { router.select(.search) },
						recoverProfile: { router.select(.genres) }
					)
				case .search:
					// Search has no stack: its sheet is presented by the router (I.2 fills it).
					EmptyView()
				case .genres:
					// Provisional root until K.1 composes the Genres tab; Settings lives here meanwhile.
					SettingsEntryView(
						profileState: profileState,
						profileStore: profileStore,
						recentNodes: recentNodes,
						analytics: analytics,
						editProfile: { beginOnboarding(editing: profile(from: profileState)) },
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

	private func presentSearchIfRequested() {
		guard searchAfterOnboarding else { return }
		searchAfterOnboarding = false
		router.select(.search)
	}

	private func beginOnboarding(editing profile: Profile?) {
		profileToEdit = profile
		showingOnboarding = true
	}

	private func reloadProfile() async {
		profileState = await profileStore.read()
	}

	private func profile(from state: ProfileRead) -> Profile? {
		guard case .profile(let profile) = state else { return nil }
		return profile
	}
}

private struct SettingsEntryView: View {
	let profileState: ProfileRead
	let profileStore: ProfileStore
	let recentNodes: RecentNodesStore
	let analytics: AnalyticsClient

	var body: some View {
		SettingsView(
			profileState: profileState,
			profileStore: profileStore,
			recentNodes: recentNodes,
			analytics: analytics,
			editProfile: editProfile,
			profileWasCleared: profileWasCleared
		)
	}

	let editProfile: () -> Void
	let profileWasCleared: () -> Void
}

private struct TodayEntryView<Today: View>: View {
	let profileState: ProfileRead
	@ViewBuilder let today: (Profile) -> Today
	let chooseProfile: () -> Void
	let exploreSearch: () -> Void
	let recoverProfile: () -> Void

	var body: some View {
		switch profileState {
		case .profile(let profile):
			today(profile)
		case .missing, .unavailable:
			ProfileMissingView(chooseProfile: chooseProfile, exploreSearch: exploreSearch)
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
		ContentUnavailableView {
			Label("Profil local à récupérer", systemImage: "exclamationmark.triangle")
		} description: {
			Text("\(description) Supprimez-le depuis Réglages avant de recommencer.")
				.accessibilityIdentifier("profile-recovery-message")
		} actions: {
			VStack(spacing: Track1Theme.contentSpacing) {
				Button("Ouvrir les réglages", action: recoverProfile)
					.buttonStyle(Track1PrimaryButtonStyle())
				Button("Explorer la recherche", action: exploreSearch)
					.buttonStyle(.bordered)
			}
			.padding()
		}
		.navigationTitle("Aujourd’hui")
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

/// Stands for the search sheet until I.2: the field is inert, the sheet only proves the Search tab opens it.
private struct SearchSheetPlaceholder: View {
	@State private var text = ""
	@FocusState private var isFocused: Bool

	var body: some View {
		VStack(spacing: Track1Tokens.spacing16) {
			Track1SearchField(text: $text, focus: $isFocused, onSubmit: {})
				.disabled(true)
			Spacer()
		}
		.padding(Track1Tokens.spacing24)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.presentationBackground(Track1Tokens.colorBackgroundBase)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("search-sheet")
	}
}
