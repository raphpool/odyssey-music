import Foundation

/// What the node page draws from the sections of `NodePageModel`; pure, so `swift test` covers it.
extension NodePageSection {
	/// Only a chip list is limited (rule 3); a carousel, a track list and a single edge show everything.
	public func displayedEdges(expanded: Bool, limit: Int = NodePageSpec.chipLimit) -> [NodeEdge] {
		guard presentation == .chips, !expanded else { return edges }
		return Array(edges.prefix(limit))
	}

	/// The number shown by the "+N more" chip, 0 when there is none to draw.
	public func hiddenCount(expanded: Bool, limit: Int = NodePageSpec.chipLimit) -> Int {
		edges.count - displayedEdges(expanded: expanded, limit: limit).count
	}
}

/// One block of the node page body, in drawing order.
public enum NodePageBlock: Sendable {
	case section(NodePageSection)
	case highlights(ArtistHighlights)
}

extension NodePageModel {
	/// The body of the page: the sections of `sections(for:)`, minus the fields `ArtistHighlights` carries (they
	/// are no chips), with the highlights block above the discography carousel. An artist without a discography
	/// gets the block where that carousel would stand, before the first section ranked after it. No highlight,
	/// no block.
	public static func blocks(for node: NodeDetail) -> [NodePageBlock] {
		let highlights = highlights(for: node)
		let carried = highlights == nil ? [] : ArtistHighlights.fields
		let sections = sections(for: node).filter { !carried.contains($0.field) }
		var blocks = sections.map(NodePageBlock.section)
		guard let highlights else { return blocks }
		let order = NodePageSpec.sectionOrder[node.type] ?? []
		let anchor = NodePageSpec.carouselField[node.type].flatMap { order.firstIndex(of: $0) } ?? order.count
		let index = sections.firstIndex { (order.firstIndex(of: $0.field) ?? order.count) >= anchor }
		blocks.insert(.highlights(highlights), at: index ?? blocks.count)
		return blocks
	}
}

public enum NodePageListening {
	/// The streaming bar's actions: none for a genre or a label (D12), and none until the state is `ready`.
	public static func actions(for type: NodeType, state: ListeningState) -> [ListeningAction] {
		guard type != .genre, type != .label, case .ready(let actions) = state else { return [] }
		return actions
	}

	/// Feedback when the OS refused to open `provider` and the web fallback failed too (TRA-446). Figma draws
	/// no such state; the copy is French and names the service, as the old `listen-error` did.
	public static func failureMessage(for provider: ListeningProvider) -> String {
		"Impossible d’ouvrir \(provider.displayName)."
	}
}
