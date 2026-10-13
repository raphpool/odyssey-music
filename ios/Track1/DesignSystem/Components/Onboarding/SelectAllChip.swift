import SwiftUI

/// Figma `Select-all chip` (`175:47`, doc `175:49`): selects every subgenre of the current parent genre.
/// Default shows a chevron, Selected a check. Whether it is selected is derived from the selection by the
/// flow model, not stored here.
struct SelectAllChip: View {
	static let identifier = "select-all"
	static let title = "Tous"

	/// `chevronDown` while some subgenres are left out, `check` once every one is in (`175:41`, `175:45`).
	static func glyph(isSelected: Bool) -> Track1Icon.Glyph {
		isSelected ? .check : .chevronDown
	}

	private let isSelected: Bool
	private let action: () -> Void
	@State private var taps = 0

	init(isSelected: Bool, action: @escaping () -> Void) {
		self.isSelected = isSelected
		self.action = action
	}

	var body: some View {
		let colors = OnboardingChoiceColors.resolve(isSelected: isSelected)
		let shape = RoundedRectangle(cornerRadius: Track1Tokens.radius0, style: .continuous)
		Button {
			taps += 1
			action()
		} label: {
			HStack(spacing: Track1Tokens.spacing8) {
				Track1Text(Self.title, role: .monoItem).foregroundStyle(colors.title)
				Track1Icon(Self.glyph(isSelected: isSelected), color: colors.title)
			}
			.padding(.horizontal, Track1Tokens.spacing12)
			.padding(.vertical, Track1Tokens.spacing8)
			.frame(minHeight: Track1Tokens.sizeControlMedium)
			.background(colors.fill, in: shape)
			.overlay { shape.strokeBorder(colors.border, lineWidth: OnboardingChoiceColors.borderWidth) }
			.contentShape(shape)
		}
		.buttonStyle(.plain)
		.sensoryFeedback(.selection, trigger: taps)
		.accessibilityIdentifier(Self.identifier)
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}
}
