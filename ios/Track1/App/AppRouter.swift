import Observation
import SwiftUI
import Track1Core

enum AppRoute: Hashable, Sendable {
	case node(identity: NodeIdentity, context: NavigationContext)
}

/// The root tabs (D8). Search is not a destination: selecting it opens the search sheet, so it never
/// becomes `AppRouter.selectedTab`.
enum AppTab: String, CaseIterable, Hashable, Identifiable, Sendable {
	case today
	case genres
	case search

	var id: Self { self }

	var title: String {
		switch self {
		case .today: "Aujourd’hui"
		case .genres: "Genres"
		case .search: "Recherche"
		}
	}

	/// The tab bar glyph (Figma `Tab bar` `173:108`), shared with the design system icon set.
	var glyph: Track1Icon.Glyph {
		switch self {
		case .today: .home
		case .genres: .musicNote
		case .search: .search
		}
	}
}

@MainActor
@Observable
final class AppRouter {
	var selectedTab: AppTab = .today
	var isSearchPresented = false
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

	/// Every tab change goes through here (the `TabView` binding). Search opens its sheet and leaves the
	/// current tab selected; selecting Today while it is already selected goes back to the node of the day.
	func select(_ tab: AppTab) {
		switch tab {
		case .search:
			isSearchPresented = true
		case .today where selectedTab == .today:
			setPath([], for: .today)
		case .today, .genres:
			selectedTab = tab
		}
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
