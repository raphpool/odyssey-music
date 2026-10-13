import SwiftUI

/// Figma `IconButton` (`14:58`, doc `170:68`): an icon-only round action, 44 or 52 pt square. The
/// accessibility label is required: nothing else names the control.
struct Track1IconButton: View {
	private let glyph: Track1Icon.Glyph
	private let accessibilityLabel: String
	private let kind: Track1ButtonKind
	private let size: Track1ControlSize
	private let action: () -> Void

	init(
		_ glyph: Track1Icon.Glyph, accessibilityLabel: String, kind: Track1ButtonKind, size: Track1ControlSize,
		action: @escaping () -> Void
	) {
		self.glyph = glyph
		self.accessibilityLabel = accessibilityLabel
		self.kind = kind
		self.size = size
		self.action = action
	}

	/// Never under 44 x 44 pt (Figma rule).
	static func targetSize(for size: Track1ControlSize) -> CGSize {
		CGSize(width: size.height, height: size.height)
	}

	var body: some View {
		Button(action: action) {
			EmptyView()
		}
		.buttonStyle(Track1ButtonStyle(kind: kind, size: size, icon: glyph, iconOnly: true))
		.accessibilityLabel(accessibilityLabel)
	}
}
