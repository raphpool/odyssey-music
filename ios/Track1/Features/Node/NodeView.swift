import SwiftUI
import Track1Core
import UIKit

/// Maps the state of a node to the page, a progress bar, or an undrawn state composed from the design system (D14).
struct NodeView: View {
	@State private var model: NodeViewModel
	/// Frozen at creation: a page keeps the breadcrumb of the path that led to it, and must not follow the
	/// stack that grows above it (the page below would otherwise gain a crumb while the next one slides in).
	@State private var topBar: TopBar.Content
	@Environment(\.openURL) private var openURL
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

extension OpenURLAction {
	/// `false` when the OS declines the URL (no handler, or the user cancelled), as the completion reports it.
	@MainActor
	fileprivate func open(_ url: URL) async -> Bool {
		await withCheckedContinuation { continuation in
			callAsFunction(url) { continuation.resume(returning: $0) }
		}
	}
}
