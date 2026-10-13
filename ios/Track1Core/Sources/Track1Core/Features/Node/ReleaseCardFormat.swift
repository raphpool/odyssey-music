import Foundation

/// The text of a release card (Figma `Release card`, `172:16`, doc `172:21`), kept free of SwiftUI so that
/// `swift test` covers it. Everything it formats is third-party data: the caller shows the result verbatim.
public enum ReleaseCardFormat {
	/// The line under the title, "2015 · album", or nil when the edge carries neither a year nor a type.
	/// A blank value counts as absent: a year the API sends as "" must not leave a dangling " · ". Unlike
	/// `EdgeChipFormat.meta`, there is no leading separator: the card shows the meta on a line of its own.
	public static func meta(year: String?, releaseType: String?) -> String? {
		// One rule for the chip and the card: the card is the chip's meta without its leading "· ".
		EdgeChipFormat.meta(year: year, releaseType: releaseType).map { String($0.dropFirst(2)) }
	}

	/// One spoken label, "To Pimp a Butterfly, 2015, album": the `·` of the meta is a visual separator that
	/// a screen reader would read out loud.
	public static func spokenLabel(title: String, meta: String?) -> String {
		let metaParts = (meta ?? "").split(separator: "·").map { $0.trimmingCharacters(in: .whitespaces) }
			.filter { !$0.isEmpty }
		return ([title] + metaParts).joined(separator: ", ")
	}
}
