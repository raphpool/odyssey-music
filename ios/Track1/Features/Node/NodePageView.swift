import SwiftUI
import Track1Core
import UIKit

/// The node page of the Figma Flow 2 (screens 2.1 to 2.5), for the five node types. The node data is untrusted:
/// every string is drawn `verbatim` and no field becomes a link.
struct NodePageView: View {
	private let node: NodeDetail
	private let hero: NodeHeroModel
	private let imageStore: NodeImageStore<UIImage>
	private let topBar: TopBar.Content
	private let isRoot: Bool
	private let listening: ListeningState
	private let isOpeningListening: Bool
	private let onOpenEdge: (NodeEdge, String) -> Void
	private let onOpenListening: (ListeningAction) -> Void
	private let onSelectCrumb: (TopBarCrumb) -> Void
	@State private var expandedFields = Set<String>()
	@Environment(\.openURL) private var openURL

	/// `imageStore` (carousel covers) and `isOpeningListening` (streaming bar) go beyond the ticket's contract.
	init(
		node: NodeDetail,
		hero: NodeHeroModel,
		imageStore: NodeImageStore<UIImage>,
		topBar: TopBar.Content,
		isRoot: Bool,
		listening: ListeningState,
		isOpeningListening: Bool,
		onOpenEdge: @escaping (NodeEdge, String) -> Void,
		onOpenListening: @escaping (ListeningAction) -> Void,
		onSelectCrumb: @escaping (TopBarCrumb) -> Void
	) {
		self.node = node
		self.hero = hero
		self.imageStore = imageStore
		self.topBar = topBar
		self.isRoot = isRoot
		self.listening = listening
		self.isOpeningListening = isOpeningListening
		self.onOpenEdge = onOpenEdge
		self.onOpenListening = onOpenListening
		self.onSelectCrumb = onSelectCrumb
	}

	/// Silver off the root (Figma 3.2); on the root a project or track with a tint takes it, the rest is Ember.
	static func glowTone(isRoot: Bool, type: NodeType, tint: Color?) -> AmbientGlow.Tone {
		guard isRoot else { return .silver }
		if type == .project || type == .track, let tint { return .tinted(tint) }
		return .ember
	}

	static func heroImage(for state: NodeHeroModel.State) -> Track1Artwork.State {
		switch state {
		case .loading: .loading
		case .loaded(let image, _): .image(image)
		case .placeholder: .unavailable
		}
	}

	static func heroTint(for state: NodeHeroModel.State) -> Color? {
		if case .loaded(_, let tint) = state { tint } else { nil }
	}

	var body: some View {
		let tint = Self.heroTint(for: hero.state)
		let actions = NodePageListening.actions(for: node.type, state: listening)
		VStack(spacing: 0) {
			TopBar(topBar, onSelect: onSelectCrumb)
				.padding(.horizontal, Track1Tokens.spacing24)
			ScrollView { content(tint: tint) }
		}
		// Glow first, opaque base last: a later `.background` goes behind the earlier ones.
		.background(alignment: .top) {
			AmbientGlow(tone: Self.glowTone(isRoot: isRoot, type: node.type, tint: tint))
				.ignoresSafeArea(edges: .top)
		}
		.background { Track1Tokens.colorBackgroundBase.ignoresSafeArea() }
		.safeAreaInset(edge: .bottom, spacing: actions.isEmpty ? 0 : Track1Tokens.spacing8) {
			if !actions.isEmpty {
				StreamingBar(actions: actions, isOpening: isOpeningListening, open: onOpenListening)
			}
		}
		.task { await hero.load() }
	}

	private func content(tint: Color?) -> some View {
		let header = NodePageHeader(node: node)
		let facts = header.facts.map { (label: $0.label, value: $0.value) }
		return VStack(alignment: .leading, spacing: Track1Tokens.spacing24) {
			NodeHero(
				kind: NodeHeroKind(node.type), image: Self.heroImage(for: hero.state), discTint: tint,
				accessibilityLabel: header.title
			)
			.id(node.id)
			titleBlock(header)
				.padding(.horizontal, Track1Tokens.spacing24)
			if let teaser = header.teaser {
				TeaserCard(text: teaser)
					.padding(.horizontal, Track1Tokens.spacing24)
			}
			if !FactsBlock.isEmpty(facts) {
				FactsBlock(rows: facts)
					.padding(.horizontal, Track1Tokens.spacing24)
			}
			ForEach(NodePageModel.sections(for: node), id: \.field) { section in
				sectionView(section)
			}
			// Last, as fixed by H.1. A source opens through the OS only; `NodeArticleView` has already
			// dropped any citation whose URL is not a public HTTPS one.
			let article = NodeArticleView(
				article: node.article, citations: node.citations, onOpenSource: { openURL($0) })
			if article.hasContent {
				article.padding(.horizontal, Track1Tokens.spacing24)
			}
		}
		.padding(.bottom, Track1Tokens.spacing24)
	}

	private func titleBlock(_ header: NodePageHeader) -> some View {
		VStack(spacing: Track1Tokens.spacing6) {
			Track1Text(header.title, role: .title3, verbatim: true)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
				.accessibilityIdentifier("node-title")
				.accessibilityAddTraits(.isHeader)
			if let subtitle = header.subtitle {
				Track1Text(subtitle, role: .bodyMedium, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
					.accessibilityIdentifier("node-subtitle")
			}
		}
		.multilineTextAlignment(.center)
		.frame(maxWidth: .infinity)
	}

	// MARK: - Sections

	private func sectionView(_ section: NodePageSection) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			SectionHeader(title: section.label, count: section.showsCount ? section.totalCount : nil)
				.accessibilityIdentifier(SectionHeader.identifier(field: section.field))
				.padding(.horizontal, Track1Tokens.spacing24)
			switch section.presentation {
			case .chips, .single:
				chips(section)
					.padding(.horizontal, Track1Tokens.spacing24)
			case .carousel:
				carousel(section)
			case .trackList:
				trackList(section)
					.padding(.horizontal, Track1Tokens.spacing24)
			}
		}
	}

	private func chips(_ section: NodePageSection) -> some View {
		let expanded = expandedFields.contains(section.field)
		let hidden = section.hiddenCount(expanded: expanded)
		return ChipFlowLayout {
			ForEach(Array(section.displayedEdges(expanded: expanded).enumerated()), id: \.offset) { _, edge in
				EdgeChip(edge: edge) { onOpenEdge(edge, section.field) }
			}
			if hidden > 0 {
				EdgeChipOverflow(hiddenCount: hidden, field: section.field) {
					expandedFields.insert(section.field)
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	/// The cards start at the page margin and scroll to the screen edge, so the last visible card peeks.
	private func carousel(_ section: NodePageSection) -> some View {
		ScrollView(.horizontal, showsIndicators: false) {
			LazyHStack(alignment: .top, spacing: Track1Tokens.spacing12) {
				ForEach(Array(section.edges.enumerated()), id: \.offset) { _, edge in
					NodeReleaseCard(edge: edge, imageStore: imageStore) { onOpenEdge(edge, section.field) }
				}
			}
		}
		.contentMargins(.horizontal, Track1Tokens.spacing24, for: .scrollContent)
	}

	private func trackList(_ section: NodePageSection) -> some View {
		VStack(spacing: 0) {
			ForEach(Array(section.edges.enumerated()), id: \.offset) { index, edge in
				TrackRow(number: index + 1, title: edge.name) { onOpenEdge(edge, section.field) }
			}
		}
	}
}

/// A carousel card that loads its own cover when it appears, through `/image` of the target and the store.
private struct NodeReleaseCard: View {
	let edge: NodeEdge
	let imageStore: NodeImageStore<UIImage>
	let action: () -> Void
	@State private var cover = Track1Artwork.State.loading

	var body: some View {
		ReleaseCard(
			title: edge.name, meta: ReleaseCard.meta(year: edge.year, releaseType: edge.releaseType), cover: cover,
			identity: edge.slug, action: action
		)
		.task(id: edge.slug) {
			guard case .loading = cover else { return }
			let image = await imageStore.image(for: edge.slug)
			guard !Task.isCancelled else { return }
			cover = image.map { .image($0) } ?? .unavailable
		}
	}
}
