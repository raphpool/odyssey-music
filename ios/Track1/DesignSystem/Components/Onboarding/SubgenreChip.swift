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

	/// Half the height of a one-line pill: 18 pt at the default size (2 + 8 + 16 + 8 + 2 = 36 pt), and it
	/// follows the line height as the text size grows. 2026-10-24 (TRA-679, macOS probe): with `radiusFull` a
	/// name folded on several lines made the pill an ellipse that cut its own lines; a folded pill keeps the
	/// corners of a one-line one instead and becomes a rounded rectangle. `lineHeight` is that of the tallest
	/// content of the line: with a glyph, the 16 pt glyph does not scale down with the text.
	static func cornerRadius(lineHeight: CGFloat) -> CGFloat {
		(lineHeight + 2 * Track1Tokens.spacing8 + 2 * OnboardingChoiceColors.borderWidth) / 2
	}

	private let title: String
	private let glyph: Track1Icon.Glyph?
	private let isSelected: Bool
	private let action: () -> Void
	@State private var taps = 0
	@ScaledMetric private var lineHeight: CGFloat

	init(title: String, glyph: Track1Icon.Glyph? = nil, isSelected: Bool, action: @escaping () -> Void) {
		// The same scaling as `Track1Text`, so the radius tracks the height of a line of the label.
		_lineHeight = ScaledMetric(
			wrappedValue: Track1TextRole.monoTag.lineHeight, relativeTo: Track1TextRole.monoTag.textStyle)
		self.title = title
		self.glyph = glyph
		self.isSelected = isSelected
		self.action = action
	}

	var body: some View {
		let colors = OnboardingChoiceColors.resolve(isSelected: isSelected)
		let shape = RoundedRectangle(cornerRadius: Self.cornerRadius(lineHeight: glyph == nil ? lineHeight : max(lineHeight, Self.glyphSize)), style: .continuous)
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

/// The Default and Selected variants of the chips (`SubgenreChip` draws both the subgenre chips and the
/// "Tous" chip). Figma named them `Subgenre row` (`175:21`, `175:24`) and `Select-all chip` (`175:39`,
/// `175:43`), which share them: a 2 pt border, no fill by default, and the selection tokens when selected.
enum OnboardingChoiceColors {
	/// `title` is the chip label, `detail` the secondary text color (no chip draws a description since the rows
	/// went away). Selected draws both in the same selection color.
	typealias Resolved = (fill: Color, border: Color, title: Color, detail: Color)

	static let borderWidth: CGFloat = 2

	static func resolve(isSelected: Bool) -> Resolved {
		if isSelected {
			(
				Track1Tokens.colorBackgroundElevated, Track1Tokens.colorSelectionBorder,
				Track1Tokens.colorSelectionContent, Track1Tokens.colorSelectionContent
			)
		} else {
			(
				Color.clear, Track1Tokens.colorBorderContrast, Track1Tokens.colorTextPrimary,
				Track1Tokens.colorTextSecondary
			)
		}
	}
}
