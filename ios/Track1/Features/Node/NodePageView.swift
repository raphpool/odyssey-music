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
	private let listeningFailure: ListeningProvider?
	private let onOpenEdge: (NodeEdge, String) -> Void
	private let onOpenListening: (ListeningAction) -> Void
	private let onSelectCrumb: (TopBarCrumb) -> Void
	@State private var expandedFields = Set<String>()
	@Environment(\.openURL) private var openURL

	/// `imageStore` (carousel covers), `isOpeningListening` and `listeningFailure` (streaming bar) go beyond
	/// the ticket's contract.
	init(
		node: NodeDetail,
		hero: NodeHeroModel,
		imageStore: NodeImageStore<UIImage>,
		topBar: TopBar.Content,
		isRoot: Bool,
		listening: ListeningState,
		isOpeningListening: Bool,
		listeningFailure: ListeningProvider? = nil,
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
		self.listeningFailure = listeningFailure
		self.onOpenEdge = onOpenEdge
		self.onOpenListening = onOpenListening
		self.onSelectCrumb = onSelectCrumb
	}

	/// The tint of the page and of its card: the cover's palette when there is one, else three equal bands of the
	/// node-type colour (D3), which `CoverTintTone` darkens like any cover. It does not depend on the root.
	static func pageTint(coverTint: CoverTint?, type: NodeType) -> CoverTint {
		if let coverTint { return coverTint }
		// The conversions cannot fail for a token colour; if one did, fall back on `background.elevated`
		// (0x1A110E), written out so that the last step cannot fail either.
		let rgb =
			LinearRGB(Track1Tokens.colorNode(type)) ?? LinearRGB(Track1Tokens.colorBackgroundElevated)
			?? LinearRGB(red: 26 / 255, green: 17 / 255, blue: 14 / 255)
		let bands = Array(repeating: rgb, count: CoverTintTone.stopBrightness.count)
		return CoverTintTone.tint(bands: bands) ?? CoverTint(stops: bands, shadow: rgb)
	}

	static func heroImage(for state: NodeHeroModel.State) -> Track1Artwork.State {
		switch state {
		case .loading: .loading
		case .loaded(let image, _, _): .image(image)
		case .placeholder: .unavailable
		}
	}

	static func heroTint(for state: NodeHeroModel.State) -> Color? {
		if case .loaded(_, let tint, _) = state { tint } else { nil }
	}

	/// The three-band palette of the cover, once the image is loaded and none of its bands is fully transparent.
	static func coverTint(for state: NodeHeroModel.State) -> CoverTint? {
		if case .loaded(_, _, let coverTint) = state { coverTint } else { nil }
	}

	/// The notice above the streaming bar once the model reports a failed opening, none otherwise.
	static func listeningNotice(for failure: ListeningProvider?) -> ListeningFailureNotice? {
		failure.map { ListeningFailureNotice(provider: $0) }
	}

	var body: some View {
		let tint = Self.heroTint(for: hero.state)
		let pageTint = Self.pageTint(coverTint: Self.coverTint(for: hero.state), type: node.type)
		let actions = NodePageListening.actions(for: node.type, state: listening)
		VStack(spacing: 0) {
			TopBar(topBar, onSelect: onSelectCrumb)
				.padding(.horizontal, Track1Tokens.spacing24)
			ScrollView { content(tint: tint, pageTint: pageTint) }
		}
		// The tint first, opaque base last: a later `.background` goes behind the earlier ones. The gradient fills
		// the frame of the top bar and the scroll view, not the content: it stays put while the page scrolls (D4).
		.background {
			CoverTintGradient(tint: pageTint, endpoint: Track1Tokens.colorBackgroundBase).ignoresSafeArea()
		}
		.background { Track1Tokens.colorBackgroundBase.ignoresSafeArea() }
		.safeAreaInset(edge: .bottom, spacing: actions.isEmpty ? 0 : Track1Tokens.spacing8) {
			if !actions.isEmpty {
				VStack(spacing: Track1Tokens.spacing8) {
					if let notice = Self.listeningNotice(for: listeningFailure) { notice }
					StreamingBar(actions: actions, isOpening: isOpeningListening, open: onOpenListening)
				}
				.padding(.bottom, StreamingBar.bottomGap)
			}
		}
		.task { await hero.load() }
	}

	private func content(tint: Color?, pageTint: CoverTint) -> some View {
		let header = NodePageHeader(node: node)
		let facts = header.facts.map { (label: $0.label, value: $0.value) }
		// The order of the children is fixed by the contract of the card and mirrored by `cardChildren(for:)`.
		return NodeContentCard(tint: pageTint) {
			NodeTypeBadge(type: node.type)
			NodeHero(
				kind: NodeHeroKind(node.type), image: Self.heroImage(for: hero.state), imageStyle: hero.style,
				discTint: tint,
				halo: NodeHeroStyle.appliesHalo(to: NodeHeroKind(node.type)) ? Color(pageTint.shadow) : nil,
				accessibilityLabel: header.title
			)
			.frame(maxWidth: .infinity)
			.id(node.id)
			titleBlock(header)
			if let teaser = header.teaser {
				TeaserCard(text: teaser)
			}
			if !FactsBlock.isEmpty(facts) {
				FactsBlock(rows: facts)
			}
			ForEach(Array(NodePageModel.blocks(for: node).enumerated()), id: \.offset) { _, block in
				switch block {
				case .section(let section): sectionView(section)
				case .highlights(let highlights): highlightsView(highlights)
				}
			}
			// Last, as fixed by H.1. A source opens through the OS only; `NodeArticleView` has already
			// dropped any citation whose URL is not a public HTTPS one.
			let article = NodeArticleView(
				article: node.article, citations: node.citations, onOpenSource: { openURL($0) })
			if article.hasContent {
				article
			}
		}
		.padding(.horizontal, NodeContentCardMetrics.outerInset)
		.padding(.top, Track1Tokens.spacing24)
		.padding(.bottom, Track1Tokens.spacing24)
	}

	/// The identifiers of the children of `node-card`, in the order `content(tint:)` draws them: the badge, the
	/// hero, the title and the subtitle, then the teaser, the facts, the blocks of `NodePageModel` and the
	/// article, each one only when the page draws it. A highlights block counts as one child.
	static func cardChildren(for node: NodeDetail) -> [String] {
		let header = NodePageHeader(node: node)
		var children = [NodeTypeBadgeMetrics.identifier, NodeHero.identifier, "node-title"]
		if header.subtitle != nil { children.append("node-subtitle") }
		if header.teaser != nil { children.append(TeaserCard.identifier) }
		if !FactsBlock.isEmpty(header.facts.map { (label: $0.label, value: $0.value) }) {
			children.append(FactsBlock.identifier)
		}
		for block in NodePageModel.blocks(for: node) {
			switch block {
			case .section(let section): children.append(SectionHeader.identifier(field: section.field))
			case .highlights: children.append("highlights")
			}
		}
		for section in NodeArticleView.sections(article: node.article, citations: node.citations) {
			switch section {
			case .article: children.append(NodeArticleView.articleIdentifier)
			case .sources: children.append(NodeArticleView.sourcesIdentifier)
			}
		}
		return children
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
			switch section.presentation {
			case .chips, .single:
				chips(section)
			case .carousel:
				carousel(section)
			case .trackList:
				trackList(section)
			}
		}
	}

	/// The landmark album and the reference track, above the discography (TRA-471). Built from drawn parts
	/// only: `SectionHeader`, `NodeReleaseCard` (the carousel's card) and `Track1ListItem`. Tapping opens the
	/// target like a chip does, with the edge field as the relation kind.
	private func highlightsView(_ highlights: ArtistHighlights) -> some View {
		VStack(alignment: .leading, spacing: Track1Tokens.spacing24) {
			ForEach(highlights.entries, id: \.identifier) { entry in
				VStack(alignment: .leading, spacing: 0) {
					SectionHeader(title: entry.label, count: nil)
						.accessibilityIdentifier(SectionHeader.identifier(field: entry.field))
					switch entry.kind {
					case .landmarkAlbum:
						NodeReleaseCard(edge: entry.edge, imageStore: imageStore, identifier: entry.identifier) {
							onOpenEdge(entry.edge, entry.field)
						}
					case .referenceTrack:
						Track1ListItem(title: entry.edge.name, accessory: .chevron) {
							onOpenEdge(entry.edge, entry.field)
						}
						.accessibilityIdentifier(entry.identifier)
					}
				}
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

	/// The cards start at the padding of the card and scroll to its edge, so the last visible card peeks: the
	/// scroll view overflows the padding of the card, not the card.
	private func carousel(_ section: NodePageSection) -> some View {
		ScrollView(.horizontal, showsIndicators: false) {
			LazyHStack(alignment: .top, spacing: Track1Tokens.spacing12) {
				ForEach(Array(section.edges.enumerated()), id: \.offset) { _, edge in
					NodeReleaseCard(edge: edge, imageStore: imageStore) { onOpenEdge(edge, section.field) }
				}
			}
		}
		.contentMargins(.horizontal, NodeContentCardMetrics.horizontalPadding, for: .scrollContent)
		.padding(.horizontal, -NodeContentCardMetrics.horizontalPadding)
	}

	private func trackList(_ section: NodePageSection) -> some View {
		VStack(spacing: 0) {
			ForEach(Array(section.edges.enumerated()), id: \.offset) { index, edge in
				TrackRow(number: index + 1, title: edge.name) { onOpenEdge(edge, section.field) }
			}
		}
	}
}

/// Feedback for a streaming service the OS would not open (TRA-446). Figma does not draw it (D14), so it is
/// composed from drawn parts: a danger-status pill, text from the type scale. It sits above the streaming
/// bar and is announced to VoiceOver when it appears.
struct ListeningFailureNotice: View {
	static let identifier = "listen-error"

	let provider: ListeningProvider

	var message: String { NodePageListening.failureMessage(for: provider) }

	var body: some View {
		Track1Text(message, role: .bodyMedium, verbatim: true)
			.foregroundStyle(Track1Tokens.colorStatusDangerContent)
			.multilineTextAlignment(.center)
			.padding(.horizontal, Track1Tokens.spacing16)
			.padding(.vertical, Track1Tokens.spacing8)
			// One background only, with its shape: a second chained `.background` would go behind this one.
			.background(
				Track1Tokens.colorStatusDangerBackground,
				in: RoundedRectangle(cornerRadius: Track1Tokens.radius12, style: .continuous)
			)
			.padding(.horizontal, Track1Tokens.spacing12)
			.accessibilityElement(children: .ignore)
			.accessibilityLabel(message)
			.accessibilityIdentifier(Self.identifier)
			.onAppear { AccessibilityNotification.Announcement(message).post() }
	}
}

/// A carousel card that loads its own cover when it appears, through `/image` of the target and the store.
private struct NodeReleaseCard: View {
	let edge: NodeEdge
	let imageStore: NodeImageStore<UIImage>
	/// Names the card for UI tests in place of `release-card-<slug>`: the artist highlights have a fixed one.
	var identifier: String?
	let action: () -> Void
	@State private var cover = Track1Artwork.State.loading

	var body: some View {
		ReleaseCard(
			title: edge.name, meta: ReleaseCard.meta(year: edge.year, releaseType: edge.releaseType), cover: cover,
			identity: identifier == nil ? edge.slug : nil, action: action
		)
		.modifier(CardIdentifier(identifier: identifier))
		.task(id: edge.slug) {
			guard case .loading = cover else { return }
			let image = await imageStore.image(for: edge.slug)
			guard !Task.isCancelled else { return }
			cover = image.map { .image($0) } ?? .unavailable
		}
	}
}

/// Sets the identifier only when there is one: an empty identifier would hide the one the card sets itself.
private struct CardIdentifier: ViewModifier {
	let identifier: String?

	@ViewBuilder
	func body(content: Content) -> some View {
		if let identifier {
			content.accessibilityIdentifier(identifier)
		} else {
			content
		}
	}
}
