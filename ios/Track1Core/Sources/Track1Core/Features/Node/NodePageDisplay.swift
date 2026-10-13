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

public enum NodePageListening {
	/// The streaming bar's actions: none for a genre or a label (D12), and none until the state is `ready`.
	public static func actions(for type: NodeType, state: ListeningState) -> [ListeningAction] {
		guard type != .genre, type != .label, case .ready(let actions) = state else { return [] }
		return actions
	}
}
