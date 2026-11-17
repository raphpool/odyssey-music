import Observation
import SwiftUI
import Track1Core

enum AppRoute: Hashable, Sendable {
	/// The reader of a node (TRA-736): the only page Today pushes. It carries the attribution of the home.
	case player(identity: NodeIdentity, context: NavigationContext)
	/// The old node page. 2026-11-17 (TRA-736): nothing pushes it any more, but it stays with `openNode` and the
	/// breadcrumb until TRA-742, which deletes the node pages: `NodePageViewTests`, out of the scope of
	/// TRA-736, still build it, and removing it here would stop the test target from compiling.
	case node(identity: NodeIdentity, context: NavigationContext)
}

/// The root tabs (D8, v1: two tabs, search is no longer reachable from the bar).
enum AppTab: String, CaseIterable, Hashable, Identifiable, Sendable {
	case today
	case genres

	var id: Self { self }

	var title: String {
		switch self {
		case .today: "Aujourd’hui"
		case .genres: "Genres"
		}
	}

	/// The tab bar icon drawn in the Figma `Tab bar`, an image set of the asset catalog.
	var icon: Track1Icon.Asset {
		switch self {
		case .today: .tabToday
		case .genres: .tabGenres
		}
	}

	/// The identifier UI tests find the tab button by (`Track1TabBar` sets it on the button).
	var accessibilityIdentifier: String {
		switch self {
		case .today: "tab-today"
		case .genres: "tab-genres"
		}
	}
}

@MainActor
@Observable
final class AppRouter {
	var selectedTab: AppTab = .today
	/// Node names seen on the way in, so the breadcrumb can name a path step without reloading the node.
	private(set) var titles: [NodeIdentity: String] = [:]
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

	/// Every tab change goes through here (the `TabView` binding). Selecting Today while it is already selected
	/// goes back to the node of the day.
	func select(_ tab: AppTab) {
		switch tab {
		case .today where selectedTab == .today:
			setPath([], for: .today)
		case .today, .genres:
			selectedTab = tab
		}
	}

	/// Opens the reader of `identity`; Today's "Découvrir" is the caller.
	func openPlayer(_ identity: NodeIdentity, context: NavigationContext, in tab: AppTab? = nil) {
		push(.player(identity: identity, context: context), in: tab)
	}

	/// `title` is the name shown for this node in the breadcrumb; callers that do not know it yet omit it.
	func openNode(
		_ identity: NodeIdentity, context: NavigationContext, title: String? = nil, in tab: AppTab? = nil
	) {
		if let title, !title.isEmpty { titles[identity] = title }
		push(.node(identity: identity, context: context), in: tab)
	}

	func openIndependentNode(_ identity: NodeIdentity, source: AnalyticsSource, in tab: AppTab? = nil) {
		openNode(identity, context: .independent(source: source), in: tab)
	}

	func pop(in tab: AppTab? = nil) {
		let destination = tab ?? selectedTab
		_ = paths[destination, default: []].popLast()
	}

	/// Keeps `path[0...index]`. -1 is the root of the tab, so it empties the path; an index past the end
	/// changes nothing.
	func popTo(index: Int, in tab: AppTab? = nil) {
		let destination = tab ?? selectedTab
		let path = paths[destination, default: []]
		guard index < path.count - 1 else { return }
		paths[destination] = Array(path.prefix(max(index + 1, 0)))
	}

	/// The root (index -1) when `rootTitle` is given, then one crumb per node of the path, each carrying its
	/// position in the path so a tap can `popTo` it. Routes that are not nodes have no crumb.
	func breadcrumb(for tab: AppTab, rootTitle: String?) -> [TopBarCrumb] {
		let root = rootTitle.map { [TopBarCrumb(index: -1, title: $0)] } ?? []
		let steps = path(for: tab).enumerated().compactMap { index, route -> TopBarCrumb? in
			guard case .node(let identity, _) = route else { return nil }
			// The slug is the best name left when the node was opened without a title.
			let fallback =
				identity.rawValue.split(separator: ":", maxSplits: 1).last.map(String.init)
				?? identity.rawValue
			return TopBarCrumb(index: index, title: titles[identity] ?? fallback)
		}
		return root + steps
	}

	func pathBinding(for tab: AppTab) -> Binding<[AppRoute]> {
		Binding(
			get: { self.path(for: tab) },
			set: { self.setPath($0, for: tab) }
		)
	}
}
