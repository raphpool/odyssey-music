import Foundation

/// The discs offered when creating a profile, in the order of the Figma grid (`362:3119`): left to right,
/// then top to bottom. The raw value is what the profile file stores, so a name is never renamed.
public enum ProfileDisc: String, Codable, CaseIterable, Sendable {
	case iridescent, blue, mint, coral, violet, teal
}

public enum PseudoRules {
	public static let maxLength = 20

	/// The stored form of a pseudo, or nil when nothing is left of it.
	///
	/// Control characters are removed rather than turned into spaces, so a pasted line break does not split a
	/// pseudo in two. The zero width joiners are kept on purpose: a composed emoji is made of them, and
	/// stripping every invisible format character would break it into several graphemes.
	public static func normalized(_ raw: String) -> String? {
		var result = ""
		var spacePending = false
		for character in raw {
			if character.unicodeScalars.allSatisfy(Self.isRemoved) { continue }
			if character.isWhitespace {
				spacePending = !result.isEmpty
				continue
			}
			if spacePending {
				result.append(" ")
				spacePending = false
			}
			result.append(character)
		}
		// A run of spaces is already one and the edges are already trimmed, so cutting at 20 graphemes can only
		// leave a single trailing space.
		var kept = result.prefix(maxLength)
		if kept.last == " " { kept = kept.dropLast() }
		return kept.isEmpty ? nil : String(kept)
	}

	private static func isRemoved(_ scalar: Unicode.Scalar) -> Bool {
		if scalar.properties.generalCategory == .control { return true }
		switch scalar.value {
		// Arabic letter mark, left and right marks, the embedding and override controls, the isolates.
		case 0x061C, 0x200E, 0x200F, 0x202A...0x202E, 0x2066...0x2069: return true
		default: return false
		}
	}
}
