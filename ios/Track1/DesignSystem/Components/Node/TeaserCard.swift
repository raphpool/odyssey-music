import SwiftUI

/// Figma `Teaser card` (`171:49`, doc `171:52`): the editorial teaser of a node, in `Body/Medium` on the
/// elevated background, full width. The text comes from the network, so it is drawn with
/// `Text(verbatim:)` and is never cut: it wraps as long as it needs.
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
			// A card in a scroll view can be proposed less height than its text needs: never clip it.
			.fixedSize(horizontal: false, vertical: true)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(Track1Tokens.spacing16)
			.background(Track1Tokens.colorBackgroundElevated)
			.accessibilityIdentifier(Self.identifier)
	}
}
