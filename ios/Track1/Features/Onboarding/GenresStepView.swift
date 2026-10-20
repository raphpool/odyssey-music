import AudioToolbox
import SwiftUI
import Track1Core

/// Geometry of the genre screen. The accordion list (Figma `243:1671`) is 16 pt from the screen edges with
/// 4 pt between two cards; the header keeps the 24 pt content column. `columnCount`, `gutter` and
/// `contentInset` are also the grid of the Genres tab (`GenresTabView`).
enum GenresStepLayout {
	static let columnCount = 2
	static let gutter = Track1Tokens.spacing16
	/// "Content column = width - 2 x 24 pt" (Flow 1 principles, `176:51`).
	static let contentInset = Track1Tokens.spacing24
	/// Horizontal margin of the cards (Figma `243:1671`: 16).
	static let listInset = Track1Tokens.spacing16
	/// Between two cards (Figma: 4).
	static let cardSpacing = Track1Tokens.spacing4
	/// Above and below the list (Figma: 12).
	static let listVerticalInset = Track1Tokens.spacing12
}

/// Figma `1.2a Genres · empty` (`243:1585`, spec `257:416`): one accordion card per family of the editorial
/// taxonomy, the genres of a family as chips inside its card, and "Tous" to tick a whole card. The title, the
/// subtitle and the list scroll together; the action bar stays pinned. Selection logic lives in
/// `GenreSelectionModel`, this view only reads and toggles it, and owns which cards are open.
struct GenresStepView: View {
	/// Set on the bar's button (`BottomActionBar.identifier`).
	static let continueIdentifier = "onboarding-genres-continue"

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
			VStack(alignment: .leading, spacing: Track1Tokens.spacing16) {
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
		// Order matters: each `.background` sits behind the previous one, so the glow goes first and the
		// opaque base color last. The other way round, the base color hides the glow (TRA-403 review).
		.background(alignment: .top) {
			AmbientGlow(tone: .ember).ignoresSafeArea(edges: .top)
		}
		.background {
			Track1Tokens.colorBackgroundBase.ignoresSafeArea()
		}
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: Track1Tokens.spacing16) {
			Track1Text("Sélectionne tes genres", role: .title1)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
				.accessibilityAddTraits(.isHeader)
			Track1Text("Tu recevras une recommandation par jour pour les explorer", role: .bodyMedium)
				.foregroundStyle(Track1Tokens.colorTextSecondary)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal, GenresStepLayout.contentInset)
		// Figma starts the title 72 pt from the screen edge, which is below the status bar on every
		// device; the scroll view already sits under it, so a token gap is enough.
		.padding(.top, Track1Tokens.spacing16)
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
			onToggle: {
				withAnimation(Track1Motion.spring(reduceMotion: reduceMotion)) {
					toggleExpansion(of: family.id)
				}
			}
		) {
			chips(of: family)
		}
		.accessibilityIdentifier(GenreAccordionCard<EmptyView>.identifier(for: family.id))
		// One tick per card passing under the bar, not per chip (plan D5): the chips of an open card are a
		// flow layout, not a list.
		.background { RowEdgeReader(id: family.id, space: Space.content) }
	}

	private func chips(of family: FamilyChoice) -> some View {
		VStack(alignment: .leading, spacing: Track1Tokens.spacing8) {
			SubgenreChip(title: "Tous", glyph: .arrowDownRight, isSelected: model.isAllSelected(of: family.id)) {
				model.toggleAll(of: family.id)
			}
			.accessibilityIdentifier(Self.selectAllIdentifier(for: family.id))
			ChipFlowLayout(spacing: Track1Tokens.spacing8) {
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
