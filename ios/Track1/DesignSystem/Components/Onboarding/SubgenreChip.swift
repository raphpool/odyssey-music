import SwiftUI

/// Figma `Select-all chip` (`175:47`, states `243:1746` and `I243:1687;175:22`) and the subgenre chips of the
/// accordion card (`243:1609`): a pill with a short label and, optionally, a glyph on its right. The "Tous"
/// chip passes `arrowDownRight` in both states; only the colors change with the selection, like the other
/// chips. Names come from the catalog, so the label is shown verbatim.
struct SubgenreChip: View {
	/// `subgenre-chip-<id>`, the taxonomy genre id: the chip does not know its id, the screen sets this on it.
	static func identifier(for id: String) -> String {
		"subgenre-chip-\(id)"
	}

	/// The glyph fits in the line height of the label (16 pt), so the pill stays at 36 pt.
	static let glyphSize: CGFloat = 16

	private let title: String
	private let glyph: Track1Icon.Glyph?
	private let isSelected: Bool
	private let action: () -> Void
	@State private var taps = 0

	init(title: String, glyph: Track1Icon.Glyph? = nil, isSelected: Bool, action: @escaping () -> Void) {
		self.title = title
		self.glyph = glyph
		self.isSelected = isSelected
		self.action = action
	}

	var body: some View {
		let colors = OnboardingChoiceColors.resolve(isSelected: isSelected)
		let shape = RoundedRectangle(cornerRadius: Track1Tokens.radiusFull, style: .continuous)
		Button {
			taps += 1
			action()
		} label: {
			HStack(spacing: Track1Tokens.spacing8) {
				Track1Text(title, role: .monoTag, verbatim: true).foregroundStyle(colors.title)
				if let glyph {
					Track1Icon(glyph, color: colors.title, size: Self.glyphSize)
				}
			}
			.padding(.horizontal, Track1Tokens.spacing12)
			.padding(.vertical, Track1Tokens.spacing8)
			// Figma lays the 2 pt border out inside the pill (2 + 8 + 16 + 8 + 2 = 36 pt); `strokeBorder` draws
			// inside the shape without taking room, so the room is added here.
			.padding(OnboardingChoiceColors.borderWidth)
			.background(colors.fill, in: shape)
			.overlay { shape.strokeBorder(colors.border, lineWidth: OnboardingChoiceColors.borderWidth) }
			.contentShape(shape)
		}
		.buttonStyle(.plain)
		.sensoryFeedback(.selection, trigger: taps)
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}
}
