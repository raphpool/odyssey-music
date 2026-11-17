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
	static let glyphSize: CGFloat = SubgenreChipStyle.glyphSize

	/// Half the height of a one-line pill: 18 pt at the default size (2 + 8 + 16 + 8 + 2 = 36 pt), and it
	/// follows the line height as the text size grows. 2026-10-24 (TRA-679, macOS probe): with `radiusFull` a
	/// name folded on several lines made the pill an ellipse that cut its own lines; a folded pill keeps the
	/// corners of a one-line one instead and becomes a rounded rectangle. `lineHeight` is that of the tallest
	/// content of the line: with a glyph, the 16 pt glyph does not scale down with the text.
	static func cornerRadius(lineHeight: CGFloat) -> CGFloat {
		(lineHeight + 2 * SubgenreChipStyle.verticalPadding + 2 * SubgenreChipStyle.borderWidth) / 2
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
		let colors = SubgenreChipStyle.resolve(isSelected: isSelected)
		let contentHeight = glyph == nil ? lineHeight : max(lineHeight, Self.glyphSize)
		let shape = RoundedRectangle(cornerRadius: Self.cornerRadius(lineHeight: contentHeight), style: .continuous)
		Button {
			taps += 1
			action()
		} label: {
			HStack(spacing: SubgenreChipStyle.glyphSpacing) {
				Track1Text(title, role: SubgenreChipStyle.titleRole, verbatim: true).foregroundStyle(colors.title)
				if let glyph {
					Track1Icon(glyph, color: colors.title, size: Self.glyphSize)
				}
			}
			.padding(.horizontal, SubgenreChipStyle.horizontalPadding)
			.padding(.vertical, SubgenreChipStyle.verticalPadding)
			// Figma lays the 2 pt border out inside the pill (2 + 8 + 16 + 8 + 2 = 36 pt); `strokeBorder` draws
			// inside the shape without taking room, so the room is added here.
			.padding(SubgenreChipStyle.borderWidth)
			// No fill in either state (Figma `316:5084`): the card shows through, the border carries the selection.
			.overlay { shape.strokeBorder(colors.border, lineWidth: SubgenreChipStyle.borderWidth) }
			.contentShape(shape)
		}
		.buttonStyle(.plain)
		.sensoryFeedback(.selection, trigger: taps)
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}
}

/// Measures and colors of the chips (`SubgenreChip` draws both the subgenre chips and the "Tous" chip), read
/// on Figma `316:5084` and the following chips of `316:5066` (TRA-725). Both states share the same shape and
/// text: a 2 pt border, no fill, the primary text color. Only the border tells them apart.
enum SubgenreChipStyle {
	static let borderWidth: CGFloat = 2
	static let horizontalPadding: CGFloat = Track1Tokens.spacing12
	static let verticalPadding: CGFloat = Track1Tokens.spacing8
	/// Between the label and the glyph of the "Tous" chip.
	static let glyphSpacing: CGFloat = Track1Tokens.spacing8
	static let glyphSize: CGFloat = 16
	/// Between two chips of a card, in a row and between rows.
	static let flowSpacing: CGFloat = Track1Tokens.spacing8
	static let titleRole: Track1TextRole = .monoTag

	typealias Resolved = (border: Color, title: Color)

	/// Default: `border/subtle` (`#F6E9D8` at 10 %). Selected: `icon/primary` (`#F6E9D8`).
	static func resolve(isSelected: Bool) -> Resolved {
		(
			border: isSelected ? Track1Tokens.colorIconPrimary : Track1Tokens.colorBorderSubtle,
			title: Track1Tokens.colorTextPrimary
		)
	}
}
