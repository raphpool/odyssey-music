import SwiftUI
import Track1Core

/// Figma `Subgenre row` (`175:27`, doc `175:29`): a child genre choice of onboarding step 3, with its name and
/// a short definition. The whole row is the tap target. Names and definitions come from the catalog, so they
/// are shown verbatim.
struct SubgenreRow: View {
	/// `subgenre-row-<id>`, the taxonomy genre id: the row does not know its id, the screen sets this on it.
	static func identifier(for id: String) -> String {
		"subgenre-row-\(id)"
	}

	/// The Figma description wraps on two lines in a 345 pt row; a longer one is cut rather than growing the
	/// list.
	static let descriptionLineLimit = 2

	/// A missing or blank definition draws no second line, and no gap for it.
	static func visibleDescription(_ description: String?) -> String? {
		guard let description, !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
			return nil
		}
		return description
	}

	static func accessibilityLabel(name: String, description: String?) -> String {
		[name, visibleDescription(description)].compactMap { $0 }.joined(separator: ", ")
	}

	private let name: String
	private let description: String?
	private let isSelected: Bool
	private let action: () -> Void
	@State private var taps = 0

	init(name: String, description: String?, isSelected: Bool, action: @escaping () -> Void) {
		self.name = name
		self.description = description
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
			VStack(alignment: .leading, spacing: Track1Tokens.spacing4) {
				Track1Text(name, role: .monoItem, verbatim: true).foregroundStyle(colors.title)
				if let text = Self.visibleDescription(description) {
					Track1Text(text, role: .bodyMedium, verbatim: true)
						.foregroundStyle(colors.detail)
						.lineLimit(Self.descriptionLineLimit)
						.multilineTextAlignment(.leading)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, Track1Tokens.spacing12)
			.padding(.vertical, Track1Tokens.spacing8)
			.frame(minHeight: Track1Tokens.sizeControlMedium)
			.background(colors.fill, in: shape)
			.overlay { shape.strokeBorder(colors.border, lineWidth: OnboardingChoiceColors.borderWidth) }
			.contentShape(shape)
		}
		.buttonStyle(.plain)
		.sensoryFeedback(.selection, trigger: taps)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Text(verbatim: Self.accessibilityLabel(name: name, description: description)))
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}
}

/// The Default and Selected variants of `Subgenre row` (`175:21`, `175:24`) and of `Select-all chip`
/// (`175:39`, `175:43`), which share them: a 2 pt border, no fill by default, and the selection tokens when
/// selected.
enum OnboardingChoiceColors {
	/// `title` is the name (or the chip label), `detail` the description. Selected draws both in the same
	/// selection color.
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
