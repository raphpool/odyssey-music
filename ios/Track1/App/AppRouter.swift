import Observation
import SwiftUI

enum AppRoute: Hashable, Sendable {
	case entryStatus(AppTab)
}

enum AppTab: String, CaseIterable, Hashable, Identifiable, Sendable {
	case today
	case search
	case settings

	var id: Self { self }

	var title: String {
		switch self {
		case .today: "Aujourd’hui"
		case .search: "Recherche"
		case .settings: "Réglages"
		}
	}

	var symbolName: String {
		switch self {
		case .today: "face.smiling"
		case .search: "magnifyingglass"
		case .settings: "slider.horizontal.3"
		}
	}
}

@MainActor
@Observable
final class AppRouter {
	var selectedTab: AppTab = .today
	private var paths: [AppTab: [AppRoute]] = Dictionary(uniqueKeysWithValues: AppTab.allCases.map { ($0, []) })

	func path(for tab: AppTab) -> [AppRoute] {
		paths[tab, default: []]
	}

	func setPath(_ path: [AppRoute], for tab: AppTab) {
		paths[tab] = path
	}

	func push(_ route: AppRoute, in tab: AppTab? = nil) {
		let destination = tab ?? selectedTab
		paths[destination, default: []].append(route)
	}

	func pop(in tab: AppTab? = nil) {
		let destination = tab ?? selectedTab
		_ = paths[destination, default: []].popLast()
	}

	func pathBinding(for tab: AppTab) -> Binding<[AppRoute]> {
		Binding(
			get: { self.path(for: tab) },
			set: { self.setPath($0, for: tab) }
		)
	}
}
