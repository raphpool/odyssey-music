import SwiftUI
import Track1Core

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
							onboardingCatalog: container.onboardingCatalog,
							analytics: analytics,
							profileStore: container.profileStore
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
	let onboardingCatalog: (@Sendable () async -> APIResult<Catalog>)?
	let analytics: AnalyticsClient
	let profileStore: ProfileStore
	@State private var profileState = ProfileRead.missing
	@State private var showingOnboarding = false
	@State private var profileToEdit: Profile?

	var body: some View {
		TabView(selection: $router.selectedTab) {
			entry(for: .today)
				.tabItem { Label(AppTab.today.title, systemImage: AppTab.today.symbolName) }
				.tag(AppTab.today)
			entry(for: .search)
				.tabItem { Label(AppTab.search.title, systemImage: AppTab.search.symbolName) }
				.tag(AppTab.search)
			entry(for: .settings)
				.tabItem { Label(AppTab.settings.title, systemImage: AppTab.settings.symbolName) }
				.tag(AppTab.settings)
		}
		.tint(Track1Theme.actionTint)
		.task { await reloadProfile() }
		.sheet(isPresented: $showingOnboarding) {
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
					showingOnboarding = false
					router.selectedTab = .search
				}
			)
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
						chooseProfile: { beginOnboarding(editing: nil) },
						exploreSearch: { router.selectedTab = .search },
						recoverProfile: { router.selectedTab = .settings }
					)
				case .search:
					EntryView(tab: tab) {
						router.push(.entryStatus(tab), in: tab)
					}
				case .settings:
					SettingsEntryView(
						profileState: profileState,
						profileStore: profileStore,
						analytics: analytics,
						editProfile: { beginOnboarding(editing: profile(from: profileState)) },
						profileWasCleared: { profileState = .missing }
					)
				}
			}
			.navigationDestination(for: AppRoute.self) { route in
				switch route {
				case .entryStatus(let tab):
					EntryStatusView(tab: tab)
				case .node(let identity, let context):
					if let readers {
						NodeView(
							model: NodeViewModel(
								identity: identity,
								context: context,
								readNode: readers.node,
								readLinks: readers.links,
								recordEvent: { analytics.record($0) }
							),
							// Same tab: the relation stacks on the path the reader is already in.
							openRelation: { relation, relationContext in
								router.openNode(relation, context: relationContext, in: tab)
							}
						)
					} else {
						InvalidConfigurationView(error: .missingEnvironment)
					}
				}
			}
		}
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
	let analytics: AnalyticsClient

	var body: some View {
		SettingsView(
			profileState: profileState,
			profileStore: profileStore,
			analytics: analytics,
			editProfile: editProfile,
			profileWasCleared: profileWasCleared
		)
	}

	let editProfile: () -> Void
	let profileWasCleared: () -> Void
}

private struct TodayEntryView: View {
	let profileState: ProfileRead
	let chooseProfile: () -> Void
	let exploreSearch: () -> Void
	let recoverProfile: () -> Void

	var body: some View {
		switch profileState {
		case .profile:
			EntryView(tab: .today, showStatus: {})
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

private struct EntryView: View {
	let tab: AppTab
	let showStatus: () -> Void

	var body: some View {
		ContentUnavailableView {
			Label(tab.title, systemImage: tab.symbolName)
		} description: {
			Text("Cette entrée est prête à accueillir son contenu.")
				.accessibilityIdentifier("entry-description-\(tab.rawValue)")
		} actions: {
			Button("Voir l’état de l’entrée", action: showStatus)
				.buttonStyle(.bordered)
				.accessibilityIdentifier("entry-status-\(tab.rawValue)")
		}
		.navigationTitle(tab.title)
		.navigationBarTitleDisplayMode(.large)
	}
}

private struct EntryStatusView: View {
	let tab: AppTab

	var body: some View {
		ContentUnavailableView {
			Label("État de l’entrée", systemImage: "info.circle")
		} description: {
			Text("Les fonctionnalités de \(tab.title.lowercased()) seront ajoutées dans des livraisons dédiées.")
				.accessibilityIdentifier("entry-status-description-\(tab.rawValue)")
		}
		.navigationTitle(tab.title)
		.navigationBarTitleDisplayMode(.inline)
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
