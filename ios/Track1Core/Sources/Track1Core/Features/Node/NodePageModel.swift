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

/// The two picks the artist page puts above the discography carousel (TRA-471, D3 of the graph-integrity plan):
/// the landmark album and the reference track. Both are single edges of the artist; the page draws them as a
/// card and a row instead of the chips the generic section flow would give them.
public struct ArtistHighlights: Sendable {
	/// One drawn highlight: a card for the album, a row for the track. `field` is the edge field, which also
	/// names the relation in analytics when the highlight is opened.
	public struct Entry: Sendable {
		public enum Kind: Sendable {
			case landmarkAlbum
			case referenceTrack
		}

		public let kind: Kind
		public let field: String
		public let label: String
		/// Accessibility identifier of the card or the row.
		public let identifier: String
		public let edge: NodeEdge
	}

	/// The edge fields the highlights carry; the generic section flow skips them.
	public static let fields = ["landmark_project", "reference_track"]

	public let landmarkProject: NodeEdge?
	public let referenceTrack: NodeEdge?

	/// The highlights to draw, the album first.
	public var entries: [Entry] {
		var entries = [Entry]()
		if let landmarkProject {
			entries.append(
				Entry(
					kind: .landmarkAlbum, field: "landmark_project",
					label: NodePageSpec.label(field: "landmark_project", type: .artist),
					identifier: "landmark-album", edge: landmarkProject))
		}
		if let referenceTrack {
			entries.append(
				Entry(
					kind: .referenceTrack, field: "reference_track",
					label: NodePageSpec.label(field: "reference_track", type: .artist),
					identifier: "reference-track", edge: referenceTrack))
		}
		return entries
	}
}

extension ArtistHighlights: Equatable {
	public static func == (lhs: ArtistHighlights, rhs: ArtistHighlights) -> Bool {
		sameOptionalEdge(lhs.landmarkProject, rhs.landmarkProject)
			&& sameOptionalEdge(lhs.referenceTrack, rhs.referenceTrack)
	}
}

private func sameOptionalEdge(_ lhs: NodeEdge?, _ rhs: NodeEdge?) -> Bool {
	switch (lhs, rhs) {
	case (nil, nil): true
	case (let lhs?, let rhs?): sameEdge(lhs, rhs)
	default: false
	}
}

/// Projects a `NodeDetail` into the sections of the Data contract.
public enum NodePageModel {
	/// The landmark album and the reference track of an artist, nil for any other type and for an artist that
	/// has neither (the backfill of TRA-491 fills them in; until then no block is drawn, so no empty space).
	/// Like a section, a single edge keeps the first edge if the server sends a list.
	public static func highlights(for node: NodeDetail) -> ArtistHighlights? {
		guard node.type == .artist else { return nil }
		let landmark = node.edges["landmark_project"].flatMap { edges(of: $0).first }
		let reference = node.edges["reference_track"].flatMap { edges(of: $0).first }
		guard landmark != nil || reference != nil else { return nil }
		return ArtistHighlights(landmarkProject: landmark, referenceTrack: reference)
	}

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
