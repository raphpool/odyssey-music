import Foundation

/// Resolves the genre names behind the "parce que tu explores …" line of the Today tab. The names are resolved
/// once, when the day's pick is made, and stored with the recommendation: a recommendation served from the
/// history never re-reads the catalog (2026-10-24, TRA-698, plan D8; TRA-343).
public enum TodayReason {
	/// Figma 286:1669 shows three names.
	public static let maxGenres = 3

	/// `selection.genres` in tick order → `taxonomy.genre(id)?.name`; unknown ids and blank names (after
	/// trimming) are skipped; at most `maxGenres`; `[]` when `selection` or `taxonomy` is nil.
	public static func genreNames(selection: GenreSelection?, taxonomy: EditorialGenreTaxonomy?) -> [String] {
		guard let selection, let taxonomy else { return [] }
		let names = selection.genres.compactMap { id -> String? in
			guard let name = taxonomy.genre(id)?.name.trimmingCharacters(in: .whitespacesAndNewlines),
				!name.isEmpty
			else { return nil }
			return name
		}
		return Array(names.prefix(maxGenres))
	}
}

/// The copy of the line, kept apart from the view so that it is tested without a window.
public enum TodayReasonCopy {
	/// U+0020 U+002D U+0020, as drawn in the Figma.
	public static let separator = " - "

	/// "parce que tu explores IDM - Glitch - Ambient"; nil for an empty list. No truncation here.
	public static func line(genreNames: [String]) -> String? {
		guard !genreNames.isEmpty else { return nil }
		return "parce que tu explores " + genreNames.joined(separator: separator)
	}
}
