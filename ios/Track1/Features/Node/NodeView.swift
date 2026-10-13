import SwiftUI
import Track1Core
import UIKit

private struct RecentNodesKey: EnvironmentKey {
	static let defaultValue: RecentNodesStore? = nil
}

extension EnvironmentValues {
	/// Where a page read for the first time is remembered, for the recents of the search sheet. Set once at the
	/// root of the tabs, so that every page, from Today or from a relation, records itself.
	var recentNodes: RecentNodesStore? {
		get { self[RecentNodesKey.self] }
		set { self[RecentNodesKey.self] = newValue }
	}
}

/// Maps the state of a node to the page, a progress bar, or an undrawn state composed from the design system (D14).
struct NodeView: View {
	@State private var model: NodeViewModel
	/// Frozen at creation: a page keeps the breadcrumb of the path that led to it, and must not follow the
	/// stack that grows above it (the page below would otherwise gain a crumb while the next one slides in).
	@State private var topBar: TopBar.Content
	@Environment(\.openURL) private var openURL
	@Environment(\.recentNodes) private var recentNodes
	private let imageStore: NodeImageStore<UIImage>
	private let isRoot: Bool
	private let openRelation: (NodeEdge, NavigationContext) -> Void
	private let selectCrumb: (TopBarCrumb) -> Void

	init(
		model: NodeViewModel,
		imageStore: NodeImageStore<UIImage>,
		topBar: TopBar.Content,
		isRoot: Bool = false,
		openRelation: @escaping (NodeEdge, NavigationContext) -> Void,
		selectCrumb: @escaping (TopBarCrumb) -> Void
	) {
		_model = State(initialValue: model)
		_topBar = State(initialValue: topBar)
		self.imageStore = imageStore
		self.isRoot = isRoot
		self.openRelation = openRelation
		self.selectCrumb = selectCrumb
	}

	var body: some View {
		Group {
			switch model.state {
			case .loaded(let node):
				HeroOwner(node: node, store: imageStore) { hero in
					NodePageView(
						node: node,
						hero: hero,
						imageStore: imageStore,
						topBar: topBar,
						isRoot: isRoot,
						listening: model.listening,
						isOpeningListening: model.isOpeningListening,
						onOpenEdge: { edge, kind in
							model.openRelation(edge, kind: kind) { _, context in openRelation(edge, context) }
						},
						onOpenListening: { action in
							Task { await model.openListening(action, using: { await openURL.open($0) }) }
						},
						onSelectCrumb: selectCrumb
					)
				}
				.id(node.id)
			case .loading:
				undrawn {
					Track1ProgressBar(mode: .indeterminate, accessibilityLabel: "Chargement de la fiche")
						.padding(.horizontal, Track1Tokens.spacing24)
						.frame(maxHeight: .infinity)
				}
			case .missing:
				undrawn { Track1StatusView(.nodeMissing, action: nil) }
			case .failed:
				undrawn { Track1StatusView(.nodeFailed, action: { Task { await model.load() } }) }
			}
		}
		// The Top bar replaces the system bar: it is the only way back from every state.
		.toolbar(.hidden, for: .navigationBar)
		.task { await model.load() }
		// 2026-10-14 (I.2): a page counts as "seen" once it is drawn, not when it is asked for: a missing or failed
		// page is not worth offering again.
		.onChange(of: loadedRecent, initial: true) { _, recent in
			guard let recent, let recentNodes else { return }
			Task { await recentNodes.record(recent) }
		}
	}

	private var loadedRecent: RecentNode? {
		guard case .loaded(let node) = model.state else { return nil }
		return RecentNode(node: node)
	}

	/// The states that have no page: the Top bar stays, so the reader can always step back.
	private func undrawn<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
		VStack(spacing: 0) {
			TopBar(topBar, onSelect: selectCrumb)
				.padding(.horizontal, Track1Tokens.spacing24)
			content()
		}
		.background(alignment: .top) {
			AmbientGlow(tone: isRoot ? .ember : .silver).ignoresSafeArea(edges: .top)
		}
		.background { Track1Tokens.colorBackgroundBase.ignoresSafeArea() }
	}
}

/// Owns the hero model of one node; the caller keys it by the node (`NodeHeroModel` fixes its candidates).
private struct HeroOwner<Content: View>: View {
	@State private var hero: NodeHeroModel
	private let content: (NodeHeroModel) -> Content

	init(
		node: NodeDetail, store: NodeImageStore<UIImage>, @ViewBuilder content: @escaping (NodeHeroModel) -> Content
	) {
		_hero = State(initialValue: NodeHeroModel(node: node, store: store))
		self.content = content
	}

	var body: some View {
		content(hero)
	}
}
