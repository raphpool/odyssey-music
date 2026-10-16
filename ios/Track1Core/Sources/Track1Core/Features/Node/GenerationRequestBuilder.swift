import Foundation

/// Builds the body of `POST /mobile/v1/generations` for a tap on a node that has no card yet (contract of
/// TRA-477). Pure and free of SwiftUI so that `swift test` covers it.
///
/// Why the artist travels with every project or track: a work's slug is scoped by its artist, and a bare
/// `mbid` only finds a work that is already cached. Without the artist, the server answers `invalid_request`
/// for an uncached work once `ODYSSEY_SCOPED_RELEASE_SLUGS` is on (TRA-509), and a homonym could be opened.
///
/// The response is not read here: the node the server serves is `Generation.nodeID`, which may differ from the
/// requested slug when MusicBrainz corrected the credit. The server repoints the `source` edge itself and does
/// not expose `requested_slug` to the mobile client, so there is nothing to rewrite locally.
public enum GenerationRequestBuilder {
	/// Longest artist the server accepts.
	static let maximumArtistLength = 200

	/// A tap on a chip of `node`. `kind` is the edge field of the section the chip sits in.
	///
	/// - The artist is the edge's own (`NodeEdge.artist`), else the one the page itself gives (`pageArtist`),
	///   and only for a project or a track: other targets carry no artist context. With neither, the request
	///   goes without artist, as the web front does: the slug of the edge then has to carry the scope.
	/// - `source` names the section the tap came from, unless `kind` is not an edge field of `node.type`: the
	///   server refuses such a field with `invalid_request`, so the request goes without it instead.
	public static func request(
		for relation: NodeEdge, kind: String, from node: NodeDetail, requestID: UUID = UUID()
	) -> GenerationRequest {
		// A blank edge artist must not hide the screen's own artist, hence two reads instead of `??` on raw values.
		let context =
			isWork(relation.type)
			? contextArtist(relation.artist) ?? contextArtist(pageArtist(of: node, kind: kind)) : nil
		let isEdgeField = NodePageSpec.sectionOrder[node.type]?.contains(kind) ?? false
		return GenerationRequest(
			requestID: requestID, type: relation.type, name: relation.name, slug: relation.slug,
			mbid: relation.mbid, qid: relation.qid, disambiguator: nil, artist: context,
			source: isEdgeField ? GenerationSource(slug: node.id, field: kind) : nil)
	}

	/// A tap on a search hit that has no card. The artist is the hit's `artist` (first credited artist), never
	/// the `subtitle`: that one is a joined display credit and is not an artist name. A hit has no source edge.
	public static func request(for hit: SearchHit, requestID: UUID = UUID()) -> GenerationRequest {
		GenerationRequest(
			requestID: requestID, type: hit.type, name: hit.name, slug: hit.slug, mbid: hit.mbid, qid: nil,
			disambiguator: nil, artist: isWork(hit.type) ? contextArtist(hit.artist) : nil, source: nil)
	}

	/// The artist a work chip of `node` belongs to when its edge does not say (nodes cached before TRA-477).
	///
	/// - An artist page: every work chip in its sections is that artist's, so its name.
	/// - A project page, `tracklist` only: the first credit of its `artists` edge, else the scope of its slug
	///   (`project:mezzanine--massive-attack` gives "massive attack"), which is the server's own rule in
	///   `materialize-service.ts`. The other sections (`related_projects`, `personnel`...) point at works
	///   of other artists, so the project's artist would attach them to the wrong one.
	/// - Anywhere else nil: a track page lists samples and remixes by other artists.
	static func pageArtist(of node: NodeDetail, kind: String) -> String? {
		switch node.type {
		case .artist:
			return node.name
		case .project where kind == "tracklist":
			if let credited = firstCreditedName(node.edges["artists"]) { return credited }
			guard let scope = node.id.rawValue.components(separatedBy: "--").dropFirst().first else { return nil }
			return scope.replacingOccurrences(of: "-", with: " ")
		default:
			return nil
		}
	}

	/// The first credit with a usable name: a blank first credit must not hide the next one.
	private static func firstCreditedName(_ value: NodeEdgeValue?) -> String? {
		let credits: [NodeEdge]
		switch value {
		case .one(let edge): credits = [edge]
		case .many(let edges): credits = edges
		case nil: return nil
		}
		return credits.lazy.compactMap { contextArtist($0.name) }.first
	}

	/// The artist as the server reads it: trimmed, whitespace runs collapsed. Nil when nothing usable is left (blank,
	/// control character, over the server's limit). A name the server cannot scope a slug with (no Latin letter or
	/// digit) is passed on: the server refuses it or ignores it by flag, and dropping it here would hide the
	/// refusal and let the work attach to the wrong artist.
	static func contextArtist(_ raw: String?) -> String? {
		guard let raw else { return nil }
		let collapsed = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
		// UTF-16 units, as the server counts (`String.length`): graphemes would let an emoji-heavy name through.
		guard !collapsed.isEmpty, collapsed.utf16.count <= maximumArtistLength,
			!collapsed.unicodeScalars.contains(where: { $0.properties.generalCategory == .control })
		else { return nil }
		return collapsed
	}

	private static func isWork(_ type: NodeType) -> Bool {
		type == .project || type == .track
	}
}

extension NodeViewModel {
	/// The generation to ask for when `relation`, a chip of the loaded node, has no card. Nil until the node is
	/// loaded: there is no source to name before that.
	public func generationRequest(
		for relation: NodeEdge, kind: String, requestID: UUID = UUID()
	) -> GenerationRequest? {
		guard case .loaded(let node) = state else { return nil }
		return GenerationRequestBuilder.request(for: relation, kind: kind, from: node, requestID: requestID)
	}
}
