import Foundation

/// What the person ticked in the editorial onboarding: families (tiles) and taxonomy genres (rows). The
/// recommendation still reads `genre:*` identities, so `derivedGenreIDs(in:)` turns this selection into
/// them (plan D2, D3).
public struct GenreSelection: Codable, Equatable, Sendable {
	/// Family keys in selection order, unique, at least one.
	public let families: [String]
	/// Taxonomy genre ids (a Wikidata QID or `local:*`), unique.
	public let genres: [String]

	public init(families: [String], genres: [String]) {
		self.families = families
		self.genres = genres
	}

	/// For each selected family visible in the taxonomy: the slugs of the genres explicitly ticked in it,
	/// or, when none is, the slugs of all its visible genres. A family alone therefore means the whole
	/// family and ticked genres narrow it down (Q1). The family's own slug (`genre:rock`) is deliberately
	/// not added (Q5): it would pull in every descendant and defeat the restriction.
	/// Genre ids outside the selected families, unknown ids and unknown families add nothing.
	public func derivedGenreIDs(in taxonomy: EditorialGenreTaxonomy) -> [NodeIdentity] {
		let ticked = Set(genres)
		var slugs = Set<NodeIdentity>()
		for family in families where taxonomy.family(family) != nil {
			let visible = taxonomy.genres(of: family)
			let explicit = visible.filter { ticked.contains($0.id) }
			for genre in explicit.isEmpty ? visible : explicit {
				slugs.formUnion(genre.slugs)
			}
		}
		return slugs.sorted { $0.rawValue < $1.rawValue }
	}

	func isValid() -> Bool {
		!families.isEmpty && Set(families).count == families.count && Set(genres).count == genres.count
	}
}
