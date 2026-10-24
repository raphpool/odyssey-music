import SwiftUI

/// Figma `Teaser card` (`171:49`, doc `171:52`): the editorial teaser of a node, in `Body/Medium`, full width.
/// Since the UI refresh (2026-10-23, Figma `282:835`) it is plain text with no fill and no padding of its own:
/// the content card around it provides both. The name stays `TeaserCard` for the callers. The text comes
/// from the network, so it is drawn with `Text(verbatim:)` and is never cut: it wraps as long as it needs.
struct TeaserCard: View {
	static let identifier = "teaser"

	private let text: String

	init(text: String) {
		self.text = text
	}

	var body: some View {
		Track1Text(text, role: .bodyMedium, verbatim: true)
			.foregroundStyle(Track1Tokens.colorTextPrimary)
			.multilineTextAlignment(.leading)
			.frame(maxWidth: .infinity, alignment: .leading)
			// On the whole text: a parent that proposes less height must not squeeze or clip the text.
			.fixedSize(horizontal: false, vertical: true)
			.accessibilityIdentifier(Self.identifier)
	}
}
