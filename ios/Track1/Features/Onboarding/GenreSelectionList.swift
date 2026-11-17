import SwiftUI
import Track1Core

/// Measures of the genre accordion list, read on Figma `316:5066` (TRA-767, 393 x 852 frame). The list
/// (`316:5077`) is 16 pt from the screen edges with 12 pt between two cards. `GenresStepLayout` forwards the
/// same values under the names its layout tests read.
enum GenreSelectionListMetrics {
	/// Horizontal margin of the cards (Figma `316:5077`: 16).
	static let listInset = Track1Tokens.spacing16
	/// Between two cards (Figma: 12; it was 4 before `316:5066`).
	static let cardSpacing = Track1Tokens.spacing12
	/// Above and below the list (Figma: 12).
	static let listVerticalInset = Track1Tokens.spacing12
	/// Inside an open card, between the "Tous" row and the chips (Figma `316:5084`: 4), before the row's own
	/// bottom inset.
	static let cardBodySpacing = Track1Tokens.spacing4
	/// Under the "Tous" chip (Figma `316:5085`: 8), so 12 pt in all between it and the first chip.
	static let selectAllRowBottomInset = Track1Tokens.spacing8
	/// Between two chips of a card, in a row and between rows (Figma `316:5087`: 8).
	static let chipSpacing = Track1Tokens.spacing8
}

private struct GenreRowEdgeSpaceKey: EnvironmentKey {
	static let defaultValue: String? = nil
}

extension EnvironmentValues {
	/// Coordinate space in which each card of a `GenreSelectionList` reports its bottom edge (`RowEdgeReader`).
	/// Set by a host that ticks while its list scrolls (the onboarding, plan D5); nil reports nothing. It is an
	/// environment value, not an `init` parameter, so that the list keeps `init(model:)` and the scroll tick
	/// stays in the screen that owns the scroll view.
	var genreRowEdgeSpace: String? {
		get { self[GenreRowEdgeSpaceKey.self] }
		set { self[GenreRowEdgeSpaceKey.self] = newValue }
	}
}

/// The accordion list of the genre families (Figma `316:5077`): one card per family of the editorial
/// taxonomy, the genres of a family as chips inside its card, and "Tous" to tick a whole card. Extracted from
/// the onboarding screen (TRA-732) so that the Genres tab can draw the same list (TRA-737, not wired yet). It
/// does not scroll: the host places it in its own `ScrollView`. Selection logic lives in
/// `GenreSelectionModel`, this view only reads and toggles it, and owns which cards are open.
struct GenreSelectionList: View {
	/// `select-all-<key>`, the family key: two cards can be open at once, so "Tous" needs an identifier per
	/// card.
	static func selectAllIdentifier(for family: String) -> String {
		"select-all-\(family)"
	}

	let model: GenreSelectionModel

	/// Keys of the open cards. All closed on arrival, and closed again after a return from Welcome: the
	/// selection survives in the model, the unfolded state does not (plan D4).
	@State private var expanded = Set<String>()
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.genreRowEdgeSpace) private var rowEdgeSpace

	init(model: GenreSelectionModel) {
		self.model = model
	}

	/// 20 cards at most, and a card builds its chips only while open: a plain `VStack` is enough (plan R3).
	var body: some View {
		VStack(spacing: GenreSelectionListMetrics.cardSpacing) {
			ForEach(model.familyChoices) { family in
				card(for: family)
			}
		}
		.padding(.horizontal, GenreSelectionListMetrics.listInset)
		.padding(.vertical, GenreSelectionListMetrics.listVerticalInset)
	}

	private func card(for family: FamilyChoice) -> some View {
		GenreAccordionCard(
			title: family.name,
			subgenreCount: model.subgenres(of: family.id).count,
			selectedCount: model.selectedCount(of: family.id),
			isExpanded: expanded.contains(family.id),
			identifier: GenreAccordionCard<EmptyView>.identifier(for: family.id),
			onToggle: {
				withAnimation(Track1Motion.spring(reduceMotion: reduceMotion)) {
					toggleExpansion(of: family.id)
				}
			}
		) {
			chips(of: family)
		}
		// One tick per card passing under the bar, not per chip (plan D5): the chips of an open card are a
		// flow layout, not a list.
		.background {
			if let rowEdgeSpace {
				RowEdgeReader(id: family.id, space: rowEdgeSpace)
			}
		}
	}

	private func chips(of family: FamilyChoice) -> some View {
		VStack(alignment: .leading, spacing: GenreSelectionListMetrics.cardBodySpacing) {
			SubgenreChip(title: "Tous", glyph: .arrowDownRight, isSelected: model.isAllSelected(of: family.id)) {
				model.toggleAll(of: family.id)
			}
			.accessibilityIdentifier(Self.selectAllIdentifier(for: family.id))
			// The "Tous" row of Figma (`316:5085`) ends 8 pt under the chip, then the card body adds its 4 pt gap.
			.padding(.bottom, GenreSelectionListMetrics.selectAllRowBottomInset)
			ChipFlowLayout(spacing: GenreSelectionListMetrics.chipSpacing, rowAlignment: .top) {
				ForEach(model.subgenres(of: family.id)) { choice in
					SubgenreChip(title: choice.name, isSelected: model.isSubgenreSelected(choice.id)) {
						model.toggleSubgenre(choice.id)
					}
					.accessibilityIdentifier(SubgenreChip.identifier(for: choice.id))
				}
			}
		}
	}

	private func toggleExpansion(of family: String) {
		if expanded.remove(family) == nil { expanded.insert(family) }
	}
}
