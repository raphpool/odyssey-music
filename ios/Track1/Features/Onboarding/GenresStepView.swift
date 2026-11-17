import AudioToolbox
import SwiftUI
import Track1Core

/// Geometry of the genre screen, read on Figma `316:5066` (TRA-767, 393 x 852 frame). The accordion list
/// (`316:5077`) is 16 pt from the screen edges with 12 pt between two cards; the header (`316:5074`) keeps
/// the 24 pt content column. `columnCount`, `gutter` and `contentInset` are also the grid of the Genres tab
/// (`GenresTabView`).
enum GenresStepLayout {
	static let columnCount = 2
	static let gutter = Track1Tokens.spacing16
	/// "Content column = width - 2 x 24 pt" (Flow 1 principles, `176:51`).
	static let contentInset = Track1Tokens.spacing24
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

	/// Figma places the header at y 78 of the 393 x 852 frame, whose status bar takes 59 pt (the safe area of
	/// the iPhone with that frame). The scroll view starts under the safe area, so the header is pushed down
	/// by the difference, 19 pt: the title is at y 78 on that device, and keeps that gap on the others.
	static let headerTop: CGFloat = 78
	static let referenceTopInset: CGFloat = 59
	static var headerTopPadding: CGFloat { headerTop - referenceTopInset }
	/// Between the title and the subtitle.
	static let headerTextSpacing = Track1Tokens.spacing8
	/// Between the subtitle and the list, which adds its own `listVerticalInset`.
	static let headerBottomInset = Track1Tokens.spacing16
	static let titleRole: Track1TextRole = .title1
	static let subtitleRole: Track1TextRole = .bodyMedium
	static let titleColor = Track1Tokens.colorTextPrimary
	static let subtitleColor = Track1Tokens.colorTextSecondary

	/// Vertical gradient of the screen: `screen/gradient-top` at the top, `background/elevated` from 33.099 %
	/// of the height down, as on the root node.
	static let backgroundStops: [Gradient.Stop] = [
		.init(color: Track1Tokens.colorScreenGradientTop, location: 0),
		.init(color: Track1Tokens.colorBackgroundElevated, location: 0.33099),
	]
}

/// Figma `1.2a Genres · empty` (`243:1585`, spec `257:416`): one accordion card per family of the editorial
/// taxonomy, the genres of a family as chips inside its card, and "Tous" to tick a whole card. The title, the
/// subtitle and the list scroll together; the action bar stays pinned. Selection logic lives in
/// `GenreSelectionModel`, this view only reads and toggles it, and owns which cards are open.
struct GenresStepView: View {
	/// Set on the bar's button (`BottomActionBar.identifier`).
	static let continueIdentifier = "onboarding-genres-continue"

	static let title = "Sélectionne tes genres"
	/// Figma `316:5076`. It read "... par jour pour les explorer" before TRA-767.
	static let subtitle = "Tu recevras une recommandation par jour"

	/// `select-all-<key>`, the family key: two cards can be open at once, so "Tous" needs an identifier per
	/// card.
	static func selectAllIdentifier(for family: String) -> String {
		"select-all-\(family)"
	}

	/// The CTA follows the model (spec: "Nothing selected -> Continuer is Disabled"), not a copy of it.
	@MainActor
	static func isContinueEnabled(_ model: GenreSelectionModel) -> Bool {
		model.canContinue
	}

	/// The bar as the screen builds it, so a test reads the parameters the screen really passes.
	@MainActor
	static func actionBar(model: GenreSelectionModel, onContinue: @escaping () -> Void) -> BottomActionBar {
		BottomActionBar(
			title: model.ctaTitle, isEnabled: isContinueEnabled(model),
			counter: OnboardingCopy.counter(model.selectedSubgenreCount), identifier: continueIdentifier,
			action: onContinue)
	}

	/// Names of the coordinate spaces the scroll measurements are expressed in.
	private enum Space {
		/// The whole screen: the bar and the scrolled content are both measured in it.
		static let viewport = "genres-viewport"
		/// The scrolled content: the cards keep the same coordinates in it while the list moves.
		static let content = "genres-content"
	}

	let model: GenreSelectionModel
	private let onContinue: () -> Void

	/// Keys of the open cards. All closed on arrival, and closed again after a return from Welcome: the
	/// selection survives in the model, the unfolded state does not (plan D4).
	@State private var expanded = Set<String>()
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	/// Written on every scroll frame, so kept out of `@State` values: a reference does not invalidate the view.
	@State private var scroll = ScrollTracker()
	@State private var tickCount = 0

	init(model: GenreSelectionModel, onContinue: @escaping () -> Void) {
		self.model = model
		self.onContinue = onContinue
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 0) {
				header
				list
			}
			.coordinateSpace(name: Space.content)
			.background { ContentOffsetReader(space: Space.viewport) }
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.safeAreaInset(edge: .bottom, spacing: 0) {
			Self.actionBar(model: model, onContinue: onContinue)
				.background { BarTopReader(space: Space.viewport) }
		}
		.coordinateSpace(name: Space.viewport)
		.onPreferenceChange(RowEdgeKey.self) { scroll.layoutChanged(rowMaxYs: $0) }
		.onPreferenceChange(BarTopKey.self) { scroll.layoutChanged(barTop: $0) }
		.onPreferenceChange(ContentMinYKey.self) { offset in
			let crossed = scroll.scrolled(toOffset: -offset)
			guard crossed > 0 else { return }
			tickCount += crossed
			AudioServicesPlaySystemSound(OnboardingScrollTick.sound)
		}
		.sensoryFeedback(.impact(weight: .light, intensity: 0.5), trigger: tickCount)
		// Figma `316:5066` draws one gradient and no ambient glow. It is opaque, so no base color is needed
		// behind it (the glow and the base color were stacked here until TRA-767).
		.background {
			LinearGradient(stops: GenresStepLayout.backgroundStops, startPoint: .top, endPoint: .bottom)
				.ignoresSafeArea()
		}
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: GenresStepLayout.headerTextSpacing) {
			Track1Text(Self.title, role: GenresStepLayout.titleRole)
				.foregroundStyle(GenresStepLayout.titleColor)
				.accessibilityAddTraits(.isHeader)
			Track1Text(Self.subtitle, role: GenresStepLayout.subtitleRole)
				.foregroundStyle(GenresStepLayout.subtitleColor)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal, GenresStepLayout.contentInset)
		.padding(.top, GenresStepLayout.headerTopPadding)
		.padding(.bottom, GenresStepLayout.headerBottomInset)
	}

	/// 20 cards at most, and a card builds its chips only while open: a plain `VStack` is enough (plan R3).
	private var list: some View {
		VStack(spacing: GenresStepLayout.cardSpacing) {
			ForEach(model.familyChoices) { family in
				card(for: family)
			}
		}
		.padding(.horizontal, GenresStepLayout.listInset)
		.padding(.vertical, GenresStepLayout.listVerticalInset)
		.padding(.bottom, Track1Tokens.spacing24)
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
		.background { RowEdgeReader(id: family.id, space: Space.content) }
	}

	private func chips(of family: FamilyChoice) -> some View {
		VStack(alignment: .leading, spacing: GenresStepLayout.cardBodySpacing) {
			SubgenreChip(title: "Tous", glyph: .arrowDownRight, isSelected: model.isAllSelected(of: family.id)) {
				model.toggleAll(of: family.id)
			}
			.accessibilityIdentifier(Self.selectAllIdentifier(for: family.id))
			// The "Tous" row of Figma (`316:5085`) ends 8 pt under the chip, then the card body adds its 4 pt gap.
			.padding(.bottom, GenresStepLayout.selectAllRowBottomInset)
			ChipFlowLayout(spacing: GenresStepLayout.chipSpacing, rowAlignment: .top) {
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
