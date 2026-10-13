import Foundation

public enum Presentation: Sendable {
	case chips
	case carousel
	case trackList
	case single
}

/// One related-nodes section of a node page: what the view draws under a header, before any display limit.
public struct NodePageSection: Equatable, Sendable {
	public let field: String
	public let label: String
	public let presentation: Presentation
	public let edges: [NodeEdge]
	/// Number of related nodes, shown in the header when `showsCount` is true.
	public let totalCount: Int
	public let showsCount: Bool

	// `NodeEdge` is not `Equatable`, and an extension in this file could not synthesize it; comparing here keeps
	// that conformance out of the module's API.
	public static func == (lhs: NodePageSection, rhs: NodePageSection) -> Bool {
		lhs.field == rhs.field && lhs.label == rhs.label && lhs.presentation == rhs.presentation
			&& lhs.totalCount == rhs.totalCount && lhs.showsCount == rhs.showsCount
			&& lhs.edges.count == rhs.edges.count && zip(lhs.edges, rhs.edges).allSatisfy(sameEdge)
	}
}

private func sameEdge(_ lhs: NodeEdge, _ rhs: NodeEdge) -> Bool {
	lhs.slug == rhs.slug && lhs.type == rhs.type && lhs.name == rhs.name && lhs.mbid == rhs.mbid
		&& lhs.qid == rhs.qid && lhs.year == rhs.year && lhs.releaseType == rhs.releaseType
}

/// Projects a `NodeDetail` into the sections of the Data contract.
public enum NodePageModel {
	/// Sections in schema order (rule 2). An empty or absent edge has no section (rule 1), and a field the schema
	/// does not list for the type is ignored: the edges dictionary comes from the network.
	public static func sections(for node: NodeDetail) -> [NodePageSection] {
		let singles = NodePageSpec.singleFields[node.type] ?? []
		return (NodePageSpec.sectionOrder[node.type] ?? []).compactMap { field in
			guard let value = node.edges[field] else { return nil }
			let isSingle = singles.contains(field)
			let edges = isSingle ? Array(edges(of: value).prefix(1)) : edges(of: value)
			guard !edges.isEmpty else { return nil }
			return NodePageSection(
				field: field,
				label: NodePageSpec.label(field: field, type: node.type),
				presentation: presentation(of: field, in: node.type, isSingle: isSingle),
				edges: edges,
				totalCount: edges.count,
				showsCount: !isSingle
			)
		}
	}

	private static func presentation(of field: String, in type: NodeType, isSingle: Bool) -> Presentation {
		if isSingle { return .single }
		if type == .project && field == NodePageSpec.trackListField { return .trackList }
		if NodePageSpec.carouselField[type] == field { return .carousel }
		return .chips
	}

	private static func edges(of value: NodeEdgeValue) -> [NodeEdge] {
		switch value {
		case .one(let edge): [edge]
		case .many(let edges): edges
		}
	}
}
