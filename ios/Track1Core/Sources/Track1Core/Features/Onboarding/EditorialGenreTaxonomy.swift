import Foundation

public struct FamilyChoice: Equatable, Sendable, Identifiable {
	/// The family key served by the taxonomy.
	public let id: String
	/// The editorial label.
	public let name: String

	public init(id: String, name: String) {
		self.id = id
		self.name = name
	}
}

public struct EditorialGenreChoice: Equatable, Sendable, Identifiable {
	/// The taxonomy id (a Wikidata QID or `local:*`), not a node slug.
	public let id: String
	/// The editorial name, never `CatalogNode.name`.
	public let name: String
	/// The teaser of the first present slug, nil when absent or blank.
	public let definition: String?
	public let family: String
	/// Only the slugs whose genre node is in the catalog, in served order.
	public let slugs: [NodeIdentity]

	public init(id: String, name: String, definition: String?, family: String, slugs: [NodeIdentity]) {
		self.id = id
		self.name = name
		self.definition = definition
		self.family = family
		self.slugs = slugs
	}
}

/// The onboarding tiles (families) and rows (published genres), built from the served editorial taxonomy
/// instead of the tree derived from catalog edges (plan D4, D5). A genre is only shown when the catalog
/// holds at least one of its slugs, so the taxonomy can list genres a given materialization has not
/// produced yet without the app offering rows that lead nowhere.
public struct EditorialGenreTaxonomy: Sendable {
	/// By `order`, then `key`; every family has at least one visible genre.
	public let families: [FamilyChoice]
	private let genresByFamily: [String: [EditorialGenreChoice]]
	private let genresByID: [String: EditorialGenreChoice]
	private let legacyBySlug: [NodeIdentity: [String]]

	/// Nil when the catalog is degraded or when no family has a visible genre: the caller then falls back
	/// to its degraded path rather than showing an empty grid.
	public init?(catalog: Catalog) {
		guard case .editorial(let taxonomy) = catalog.taxonomy else { return nil }

		var nodesByIdentity = [NodeIdentity: CatalogNode]()
		for node in catalog.nodes where node.type == .genre && nodesByIdentity[node.identity] == nil {
			nodesByIdentity[node.identity] = node
		}

		var visibleGenres = [EditorialGenreChoice]()
		for genre in taxonomy.genres {
			let present = genre.slugs.filter { nodesByIdentity[$0] != nil }
			guard let first = present.first else { continue }
			let teaser = nodesByIdentity[first]?.teaser?.trimmingCharacters(in: .whitespacesAndNewlines)
			visibleGenres.append(
				EditorialGenreChoice(
					id: genre.id, name: genre.name, definition: teaser.flatMap { $0.isEmpty ? nil : $0 },
					family: genre.family, slugs: present))
		}

		// Served order within a family is the order of the web grid: no locale sort here (plan D5).
		let genresByFamily = Dictionary(grouping: visibleGenres, by: \.family)
		let families =
			taxonomy.families
			.filter { genresByFamily[$0.key] != nil }
			.sorted { ($0.order, $0.key) < ($1.order, $1.key) }
			.map { FamilyChoice(id: $0.key, name: $0.label) }
		guard !families.isEmpty else { return nil }

		self.families = families
		self.genresByFamily = genresByFamily
		genresByID = Dictionary(uniqueKeysWithValues: visibleGenres.map { ($0.id, $0) })
		let visibleIDs = Set(visibleGenres.map(\.id))
		legacyBySlug = taxonomy.legacySelectionBySlug.mapValues { $0.filter(visibleIDs.contains) }
	}

	public func genres(of family: String) -> [EditorialGenreChoice] {
		genresByFamily[family] ?? []
	}

	public func genre(_ id: String) -> EditorialGenreChoice? {
		genresByID[id]
	}

	public func family(_ key: String) -> FamilyChoice? {
		families.first { $0.id == key }
	}

	/// The genre ids a legacy slug selection maps to, restricted to genres this catalog can show.
	public func legacyGenreIDs(for slug: NodeIdentity) -> [String] {
		legacyBySlug[slug] ?? []
	}
}
