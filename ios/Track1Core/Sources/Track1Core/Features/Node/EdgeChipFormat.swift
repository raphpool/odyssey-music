import Foundation

/// The text of an edge chip (Figma `Edge chip`, `171:96`, doc `171:100`), kept free of SwiftUI so that
/// `swift test` covers it. Everything it formats is third-party data: the caller shows the result verbatim.
public enum EdgeChipFormat {
	/// The meta segment after the name: "· 2015", "· 2015 · album", or nil when the edge carries neither.
	/// A blank value counts as absent: a year the API sends as "" must not leave a dangling "· ".
	public static func meta(year: String?, releaseType: String?) -> String? {
		let parts = [year, releaseType].compactMap { value -> String? in
			guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
				return nil
			}
			return trimmed
		}
		guard !parts.isEmpty else { return nil }
		return "· " + parts.joined(separator: " · ")
	}

	/// The meta of an API edge. The API has already validated `releaseType` to album, ep or single.
	public static func meta(of edge: NodeEdge) -> String? {
		meta(year: edge.year, releaseType: edge.releaseType)
	}

	/// The chip tag, and the one type label of the new screens, in the lowercase English of the Data contract
	/// (Q1, like `KIND_LABEL` of the web front). The chip draws it in capitals, as Figma does. Search rows (I.2)
	/// use it as their subtitle. The French type names of the legacy node screen went with it (H.1).
	public static func typeLabel(_ type: NodeType) -> String {
		type.rawValue
	}
}

/// Wrapping of chips into rows (Figma rule: "Chips wrap, 8 pt gap both axes"), as indexes into the sizes the
/// layout measured. The SwiftUI `ChipFlowLayout` only measures and places.
public enum ChipFlow {
	/// Fills each row left to right and starts a new one when the next size, with its spacing, would pass
	/// `maxWidth`. An item wider than `maxWidth` gets a row of its own: the layout then proposes `maxWidth` to
	/// it, which truncates its name instead of overflowing the screen. Every index appears exactly once.
	public static func rows(sizes: [CGSize], maxWidth: CGFloat, spacing: CGFloat) -> [[Int]] {
		var rows: [[Int]] = []
		var current: [Int] = []
		var used: CGFloat = 0
		for (index, size) in sizes.enumerated() {
			let width = max(size.width, 0)
			if current.isEmpty {
				current = [index]
				used = width
			} else if used + spacing + width <= maxWidth {
				current.append(index)
				used += spacing + width
			} else {
				rows.append(current)
				current = [index]
				used = width
			}
		}
		if !current.isEmpty { rows.append(current) }
		return rows
	}
}
