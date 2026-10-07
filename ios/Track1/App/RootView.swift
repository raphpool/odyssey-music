import SwiftUI

struct RootView: View {
	let container: AppContainer

	var body: some View {
		switch container.configurationResult {
		case .success:
			ApplicationTabs(router: container.router)
		case .failure(let error):
			InvalidConfigurationView(error: error)
		}
	}
}

private struct ApplicationTabs: View {
	@Bindable var router: AppRouter

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
			EntryView(tab: tab) {
				router.push(.entryStatus(tab), in: tab)
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
