import SwiftUI

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
						ApplicationTabs(router: container.router, analytics: analytics)
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
	let analytics: AnalyticsClient

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
	}

	@ViewBuilder
	private func entry(for tab: AppTab) -> some View {
		NavigationStack(path: router.pathBinding(for: tab)) {
			Group {
				if tab == .settings {
					SettingsEntryView(analytics: analytics) {
						router.push(.entryStatus(tab), in: tab)
					}
				} else {
					EntryView(tab: tab) {
						router.push(.entryStatus(tab), in: tab)
					}
				}
			}
			.navigationDestination(for: AppRoute.self) { route in
				switch route {
				case .entryStatus(let tab):
					EntryStatusView(tab: tab)
				}
			}
		}
	}
}

private struct SettingsEntryView: View {
	let analytics: AnalyticsClient
	let showStatus: () -> Void
	@State private var showingChoice = false

	var body: some View {
		List {
			Section("Confidentialité") {
				Button {
					showingChoice = true
				} label: {
					LabeledContent("Mesure d’usage") {
						Text(analytics.consent.status == .granted ? "Autorisée" : "Non autorisée")
					}
				}
				.accessibilityIdentifier("analytics-settings")
			}
			Section("À propos") {
				Text("Cette entrée est prête à accueillir son contenu.")
					.accessibilityIdentifier("entry-description-settings")
				Button("Voir l’état de l’entrée", action: showStatus)
					.accessibilityIdentifier("entry-status-settings")
			}
		}
		.navigationTitle("Réglages")
		.sheet(isPresented: $showingChoice) {
			PrivacyChoiceView(
				consent: analytics.consent,
				accept: {
					Task {
						await analytics.grant()
						showingChoice = false
					}
				},
				decline: {
					Task {
						await analytics.deny()
						showingChoice = false
					}
				}
			)
		}
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
