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

	/// Computed: a generic type cannot hold a stored static property, so the measures live in
	/// `GenreAccordionCardMetrics`.
	static var chevronSize: CGFloat { GenreAccordionCardMetrics.chevronSize }

	/// "Hip-hop, 13 sous-genres", then ", 4 sélectionnés" once something is ticked. The count words are those
	/// of `OnboardingCopy.spokenSelectedCount`: the badge draws the number alone, VoiceOver says the words.
	static func accessibilityLabel(title: String, subgenreCount: Int, selectedCount: Int) -> String {
		var parts = [title, OnboardingCopy.subgenreCount(subgenreCount)]
		if selectedCount >= 1 {
			parts.append(OnboardingCopy.spokenSelectedCount(selectedCount))
		}
		return parts.joined(separator: ", ")
	}

	/// The badge after the title, drawn like it: nil below 1 (nothing is drawn), else "(4)".
	static func badge(selectedCount: Int) -> String? {
		selectedCount >= 1 ? OnboardingCopy.selectedCount(selectedCount) : nil
	}

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
		let shape = RoundedRectangle(cornerRadius: GenreAccordionCardMetrics.cornerRadius, style: .continuous)
		VStack(alignment: .leading, spacing: 0) {
			header
			if isExpanded {
				content.padding(.vertical, GenreAccordionCardMetrics.bodyVerticalInset)
			}
		}
		.padding(.leading, GenreAccordionCardMetrics.leadingInset)
		.padding(.trailing, GenreAccordionCardMetrics.trailingInset)
		.padding(.vertical, GenreAccordionCardMetrics.verticalInset)
		.frame(maxWidth: .infinity, alignment: .leading)
		// No border (Figma `316:5078`): the card is a plain surface in both states.
		.background(GenreAccordionCardStyle.background, in: shape)
	}

	private var spokenLabel: String {
		Self.accessibilityLabel(title: title, subgenreCount: subgenreCount, selectedCount: selectedCount)
	}

	private var header: some View {
		Button {
			taps += 1
			onToggle()
		} label: {
			// Centered in both states. Figma puts the chevron at the top of the one line of an expanded header
			// (`316:5079`), 1 pt above the centered one; switching the alignment with `isExpanded` would flip it
			// inside the spring that opens the card, so that 1 pt is left to a check on a device.
			HStack(spacing: GenreAccordionCardMetrics.chevronGap) {
				VStack(alignment: .leading, spacing: GenreAccordionCardMetrics.countLineSpacing) {
					// 2026-10-23: "(4 sélectionnés)" was squeezed next to the title and both folded in the middle of
					// their strings. The title folds freely; the badge, a bare number, is never compressed and sits on
					// the first line of a folded title (`.firstTextBaseline`, as `SectionHeader` does).
					HStack(alignment: .firstTextBaseline, spacing: GenreAccordionCardMetrics.titleSpacing) {
						Track1Text(title, role: GenreAccordionCardMetrics.titleRole, verbatim: true)
							.foregroundStyle(GenreAccordionCardStyle.title)
						if let badge = Self.badge(selectedCount: selectedCount) {
							Track1Text(badge, role: GenreAccordionCardMetrics.badgeRole, verbatim: true)
								.foregroundStyle(GenreAccordionCardStyle.title)
								.fixedSize(horizontal: true, vertical: false)
						}
					}
					if !isExpanded {
						Track1Text(OnboardingCopy.subgenreCount(subgenreCount), role: GenreAccordionCardMetrics.countRole)
							.foregroundStyle(GenreAccordionCardStyle.count)
					}
				}
				Spacer(minLength: 0)
				Track1Icon(.chevronDown, color: GenreAccordionCardStyle.chevron, size: Self.chevronSize)
					.rotationEffect(.degrees(GenreAccordionCardMetrics.chevronRotationDegrees))
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

/// Measures of the card, read on Figma `316:5078` (expanded) and `316:5095` (collapsed) of `316:5066`
/// (TRA-725), apart from the generic view so that they can be tested.
enum GenreAccordionCardMetrics {
	static let cornerRadius: CGFloat = Track1Tokens.radius20
	static let leadingInset: CGFloat = Track1Tokens.spacing24
	static let trailingInset: CGFloat = Track1Tokens.spacing16
	/// Figma pads the card 11 pt vertically; 11 is not a spacing token.
	static let verticalInset: CGFloat = 11
	static let chevronSize: CGFloat = 20
	/// Turn of the chevron, in degrees, the same in both states. 2026-11-17 (TRA-725, arbitration Q6: follow the
	/// Figma): the chevrons of the expanded card (`316:5083`, Hip-hop) and of the collapsed ones (`316:5101`,
	/// Jazz; `316:5106`, Électronique) render the same pixels, a chevron pointing down. The card used to turn
	/// it 180 degrees when expanded, which the mock-up does not draw.
	static let chevronRotationDegrees: Double = 0
	/// Between the title and the "(1)" badge.
	static let titleSpacing: CGFloat = Track1Tokens.spacing8
	/// Between the title line and the "13 sous-genres" line of a collapsed card.
	static let countLineSpacing: CGFloat = Track1Tokens.spacing8
	/// Minimum room between the label and the chevron. Figma justifies the two apart and draws no gap; this
	/// keeps a long title off the chevron.
	static let chevronGap: CGFloat = Track1Tokens.spacing8
	/// Above and below the chips of an expanded card.
	static let bodyVerticalInset: CGFloat = Track1Tokens.spacing12
	static let titleRole: Track1TextRole = .monoItem
	static let badgeRole: Track1TextRole = .monoTag
	static let countRole: Track1TextRole = .bodySmall

	/// 11 + 22 + 8 + 18 + 11 = 70 pt, as drawn, at the default text size: the lines scale with Dynamic Type, so
	/// this is the Figma measure, not the height of a card on screen.
	static var collapsedHeight: CGFloat {
		2 * verticalInset + titleRole.lineHeight + countLineSpacing + countRole.lineHeight
	}
}

/// What the card draws, apart from the view so that the colors can be tested. The same surface in both states
/// and the same text colors whatever the selection: the "(4)" badge alone says how many are ticked.
enum GenreAccordionCardStyle {
	static let background = Track1Tokens.colorSurfaceCard
	/// The title and its badge.
	static let title = Track1Tokens.colorTextPrimary
	static let count = Track1Tokens.colorTextSecondary
	static let chevron = Track1Tokens.colorIconPrimary
}
