import Foundation

/// The discs offered when creating a profile, in the order of the Figma grid (`362:3119`): left to right,
/// then top to bottom. The raw value is what the profile file stores, so a name is never renamed.
public enum ProfileDisc: String, Codable, CaseIterable, Sendable {
	case iridescent, blue, mint, coral, violet, teal
}

public enum PseudoRules {
	public static let maxLength = 20

	/// The stored form of a pseudo, or nil when nothing visible is left of it.
	///
	/// Works on scalars, not on characters: `Character.isWhitespace` only looks at the first scalar, so a space
	/// followed by a combining mark would be judged as a separator and lose the mark. Tabs and line breaks are
	/// separators like any other space (a pasted "Raph\nDoe" must not become "RaphDoe"); the other control
	/// characters and the bidirectional controls are dropped. The zero width joiners stay on purpose: a composed
	/// emoji is made of them.
	public static func normalized(_ raw: String) -> String? {
		var scalars = String.UnicodeScalarView()
		var spacePending = false
		for scalar in raw.unicodeScalars {
			if scalar.properties.isWhitespace {
				spacePending = !scalars.isEmpty
			} else if !isRemoved(scalar) {
				if spacePending {
					scalars.append(" ")
					spacePending = false
				}
				scalars.append(scalar)
			}
		}
		// A run of spaces is already one and the edges are already trimmed, so cutting at 20 graphemes can only
		// leave a single trailing space.
		var kept = String(scalars).prefix(maxLength)
		if kept.last == " " { kept = kept.dropLast() }
		// 2026-11-16 (review of TRA-756): a zero width space alone is neither whitespace nor a control, so
		// "\u{200B}" used to pass as a pseudo that shows as nothing. It needs one scalar a person can see.
		guard kept.unicodeScalars.contains(where: isVisible) else { return nil }
		return String(kept)
	}

	private static func isRemoved(_ scalar: Unicode.Scalar) -> Bool {
		if scalar.properties.generalCategory == .control { return true }
		switch scalar.value {
		// Arabic letter mark, left and right marks, the embedding and override controls, the isolates.
		case 0x061C, 0x200E, 0x200F, 0x202A...0x202E, 0x2066...0x2069: return true
		default: return false
		}
	}

	private static func isVisible(_ scalar: Unicode.Scalar) -> Bool {
		!scalar.properties.isWhitespace && !scalar.properties.isDefaultIgnorableCodePoint
			&& scalar.properties.generalCategory != .format
	}
}
