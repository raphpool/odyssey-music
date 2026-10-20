import SwiftUI
import Track1Core

/// Figma accordion card of onboarding step 1.2: expanded `243:1609`, collapsed with a selection `243:1675`,
/// collapsed without `243:1622`. One card per genre family; its header toggles the card and `content` (the
/// subgenre chips) shows below it when expanded. The card keeps no state and animates nothing itself: the
/// screen owns `isExpanded` and wraps `onToggle` in `withAnimation(Track1Motion.spring(reduceMotion:))`.
struct GenreAccordionCard<Content: View>: View {
	/// `genre-card-<key>`, the family key: the card does not know its key, the screen passes this to `init` and
	/// the header button carries it.
	static func identifier(for family: String) -> String {
		"genre-card-\(family)"
	}

	/// Computed: a generic type cannot hold a stored static property.
	static var chevronSize: CGFloat { 20 }

	/// "Hip-hop, 13 sous-genres", then ", 4 sélectionnés" once something is ticked. The count words are those
	/// of `OnboardingCopy`, whose selected count is drawn between parentheses that a spoken label drops.
	static func accessibilityLabel(title: String, subgenreCount: Int, selectedCount: Int) -> String {
		var parts = [title, OnboardingCopy.subgenreCount(subgenreCount)]
		if selectedCount >= 1 {
			let spoken = OnboardingCopy.selectedCount(selectedCount)
				.trimmingCharacters(in: CharacterSet(charactersIn: "()"))
			parts.append(spoken)
		}
		return parts.joined(separator: ", ")
	}

	/// Figma pads the card 11 pt vertically; 11 is not a spacing token.
	private static var verticalPadding: CGFloat { 11 }

	private let title: String
	private let subgenreCount: Int
	private let selectedCount: Int
	private let isExpanded: Bool
	private let identifier: String
	private let onToggle: () -> Void
	private let content: Content
	@State private var taps = 0

	init(
		title: String, subgenreCount: Int, selectedCount: Int, isExpanded: Bool, identifier: String,
		onToggle: @escaping () -> Void, @ViewBuilder content: () -> Content
	) {
		self.title = title
		self.subgenreCount = subgenreCount
		self.selectedCount = selectedCount
		self.isExpanded = isExpanded
		self.identifier = identifier
		self.onToggle = onToggle
		self.content = content()
	}

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: GenreAccordionCardStyle.cornerRadius, style: .continuous)
		VStack(alignment: .leading, spacing: 0) {
			header
			if isExpanded {
				content.padding(.vertical, Track1Tokens.spacing12)
			}
		}
		.padding(.leading, Track1Tokens.spacing24)
		.padding(.trailing, Track1Tokens.spacing16)
		.padding(.vertical, Self.verticalPadding)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(GenreAccordionCardStyle.background(isExpanded: isExpanded), in: shape)
	}

	private var spokenLabel: String {
		Self.accessibilityLabel(title: title, subgenreCount: subgenreCount, selectedCount: selectedCount)
	}

	private var header: some View {
		let accent = GenreAccordionCardStyle.accent(selectedCount: selectedCount)
		let chevronColor = selectedCount >= 1 ? accent : Track1Tokens.colorIconPrimary
		return Button {
			taps += 1
			onToggle()
		} label: {
			HStack(spacing: Track1Tokens.spacing8) {
				VStack(alignment: .leading, spacing: Track1Tokens.spacing8) {
					HStack(spacing: Track1Tokens.spacing8) {
						Track1Text(title, role: .monoItem, verbatim: true).foregroundStyle(accent)
						if selectedCount >= 1 {
							Track1Text(OnboardingCopy.selectedCount(selectedCount), role: .monoTag)
								.foregroundStyle(accent)
						}
					}
					if !isExpanded {
						Track1Text(OnboardingCopy.subgenreCount(subgenreCount), role: .monoLabel)
							.foregroundStyle(Track1Tokens.colorTextSecondary)
					}
				}
				Spacer(minLength: 0)
				Track1Icon(.chevronDown, color: chevronColor, size: Self.chevronSize)
					.rotationEffect(.degrees(isExpanded ? 180 : 0))
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.sensoryFeedback(.selection, trigger: taps)
		.accessibilityLabel(Text(verbatim: spokenLabel))
		.accessibilityValue(isExpanded ? "déplié" : "replié")
		// 2026-10-20 (TRA-639): on the button, not on the card. Set on the card, SwiftUI hands the identifier
		// down to every element inside it, the open card's chips included, which then lose their own.
		.accessibilityIdentifier(identifier)
	}
}

/// What the card draws from its inputs, apart from the view so that the colors can be tested.
enum GenreAccordionCardStyle {
	static let cornerRadius: CGFloat = Track1Tokens.radius20

	/// `surface/default` when expanded, `background/elevated` when collapsed.
	static func background(isExpanded: Bool) -> Color {
		isExpanded ? Track1Tokens.colorSurfaceDefault : Track1Tokens.colorBackgroundElevated
	}

	/// The title, the count and the chevron take the selection color as soon as one subgenre is ticked (the
	/// `#BC7722` token, not the `#E6A23A` amber drawn in the Figma, plan D5).
	static func accent(selectedCount: Int) -> Color {
		selectedCount >= 1 ? Track1Tokens.colorSelectionContent : Track1Tokens.colorTextPrimary
	}
}
