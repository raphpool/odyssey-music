import Foundation

/// A musical work ranked against the person's chosen genres.
public struct AffinityCandidate: Equatable, Sendable {
	public let identity: NodeIdentity
	public let type: NodeType
	public let name: String
	public let teaser: String?
	public let score: Int
	public let reasons: [String]
}

/// Swift port of `mobile/src/recommendation/affinity.ts`: scores and reasons match the React Native client,
/// but the set of candidates no longer does (see `rank`).
public enum Affinity {
	/// The only node types the home recommends. Shared with `TodayViewModel` so that what `rank` returns and
	/// what a persisted recommendation may be served as cannot drift apart.
	static func isRecommendable(_ type: NodeType) -> Bool {
		type == .project || type == .track
	}

	/// The ranking is truncated so the daily pick draws from a bounded, deterministic pool.
	static let candidateLimit = 60

	private struct CuratedWeight {
		let weight: Int
		let label: String
	}

	private struct NearbyLink: Hashable {
		let selectedID: NodeIdentity
		let relation: String
	}

	private struct Accumulator {
		let node: CatalogNode
		var score = 0
		var reasons = Set<String>()
		var contributions = Set<String>()
	}

	private static let curatedWeights: [String: CuratedWeight] = [
		"key_artists": CuratedWeight(weight: 3, label: "Artiste clé"),
		"landmark_projects": CuratedWeight(weight: 4, label: "Projet repère"),
		"landmark_tracks": CuratedWeight(weight: 4, label: "Morceau repère"),
	]

	private static let frenchLocale = Locale(identifier: "fr")

	/// Scores only projects and tracks. Catalog edges are untrusted API data, so identities that
	/// are missing from the catalog, or whose type is not recommendable, never become candidates.
	///
	/// Deliberate break of parity with the React Native client (2026-11-16, TRA-713, Figma node 362:5089): the
	/// spec says artists are no longer recommended and the v1 home only has a pictogram for a project or a
	/// track. `mobile/src/recommendation/affinity.ts` still ranks artists, so for the same catalog the
	/// candidates, and therefore the daily pick that `DailySelection` draws from them, no longer match it.
	/// Scores, reasons and relative order of the remaining candidates are unchanged.
	public static func rank(catalog: Catalog, genreIDs: [NodeIdentity]) -> [AffinityCandidate] {
		// The last node wins on duplicate identities, like the `Map` built by the TypeScript client.
		let nodes = Dictionary(catalog.nodes.map { ($0.identity, $0) }, uniquingKeysWith: { _, last in last })
		var seen = Set<NodeIdentity>()
		let selected = genreIDs.filter { nodes[$0]?.type == .genre && seen.insert($0).inserted }
		let selectedSet = Set(selected)
		var selectedNames: [NodeIdentity: String] = [:]
		for identity in selected { selectedNames[identity] = nodes[identity]?.name ?? identity.rawValue }

		var nearby: [NodeIdentity: [NearbyLink]] = [:]
		for edge in catalog.edges where selectedSet.contains(edge.source) {
			guard edge.type == "subgenres" || edge.type == "related_genres", nodes[edge.target]?.type == .genre
			else { continue }
			let link = NearbyLink(selectedID: edge.source, relation: edge.type)
			if nearby[edge.target, default: []].contains(link) { continue }
			nearby[edge.target, default: []].append(link)
		}

		var candidates: [NodeIdentity: Accumulator] = [:]
		func add(_ identity: NodeIdentity, contribution: String, weight: Int, reason: String) {
			guard let node = nodes[identity], isRecommendable(node.type) else { return }
			var current = candidates[identity] ?? Accumulator(node: node)
			guard current.contributions.insert(contribution).inserted else { return }
			current.score += weight
			current.reasons.insert(reason)
			candidates[identity] = current
		}

		for edge in catalog.edges {
			if let name = selectedNames[edge.source], let curated = curatedWeights[edge.type] {
				add(
					edge.target,
					contribution: "curated:\(edge.source.rawValue):\(edge.type)",
					weight: curated.weight,
					reason: "\(curated.label) d’\(name)")
			}
			guard edge.type == "genres" else { continue }
			if let directName = selectedNames[edge.target] {
				add(
					edge.source,
					contribution: "direct:\(edge.target.rawValue)",
					weight: 3,
					reason: "Lié à \(directName)")
			}
			for link in nearby[edge.target] ?? [] {
				guard let selectedName = selectedNames[link.selectedID] else { continue }
				add(
					edge.source,
					contribution: "near:\(link.selectedID.rawValue):\(link.relation):\(edge.target.rawValue)",
					weight: 1,
					reason: "Proche de \(selectedName)")
			}
		}

		let ranked =
			candidates.values
			.filter { $0.score > 0 }
			.map { candidate in
				AffinityCandidate(
					identity: candidate.node.identity,
					type: candidate.node.type,
					name: candidate.node.name,
					teaser: candidate.node.teaser,
					score: candidate.score,
					reasons: candidate.reasons.sorted(by: reasonPrecedes))
			}
			.sorted { left, right in
				if left.score != right.score { return left.score > right.score }
				return left.identity.rawValue.utf8.lexicographicallyPrecedes(right.identity.rawValue.utf8)
			}
		return Array(ranked.prefix(candidateLimit))
	}

	/// Mirrors `localeCompare(_, "fr")`; the raw comparison only keeps the order total when two distinct
	/// strings collate as equal.
	private static func reasonPrecedes(_ left: String, _ right: String) -> Bool {
		switch left.compare(right, locale: frenchLocale) {
		case .orderedAscending: return true
		case .orderedDescending: return false
		case .orderedSame: return left.utf8.lexicographicallyPrecedes(right.utf8)
		}
	}
}
