import AudioToolbox
import SwiftUI
import Track1Core

/// Figma `1.3 Subgenres · Hip-hop` (`176:166`, spec `176:209`) and `1.4 Subgenres · Jazz` (`176:223`, spec
/// `176:257`): the genres of one selected family. The same screen serves both, the last step only differs
/// by its CTA label, which the model decides. The title, the chip and the rows scroll together; the action
/// bar stays pinned. Selection logic lives in `GenreOnboardingModel`, this view only reads and toggles it.
struct SubgenresStepView: View {
	/// Set on the bar's button (`BottomActionBar.identifier`).
	static let continueIdentifier = "onboarding-subgenres-continue"

	/// The bar as the screen builds it, so a test reads the parameters the screen really passes.
	/// "Continuer stays available while other parents remain" (spec `176:216`): a step with no row checked is
	/// valid, the family alone then stands for all of its genres (plan Q1).
	@MainActor
	static func actionBar(title: String, counter: String?, onContinue: @escaping () -> Void)
		-> BottomActionBar
	{
		BottomActionBar(
			title: title, isEnabled: true, counter: counter, identifier: continueIdentifier,
			action: onContinue)
	}

	/// Names of the coordinate spaces the scroll measurements are expressed in.
	private enum Space {
		/// The whole screen: the bar and the scrolled content are both measured in it.
		static let viewport = "subgenres-viewport"
		/// The scrolled content: the rows keep the same coordinates in it while the list moves.
		static let content = "subgenres-content"
	}

	let parent: FamilyChoice
	let model: GenreOnboardingModel
	private let onContinue: () -> Void

	/// Written on every scroll frame, so kept out of `@State` values: a reference does not invalidate the view.
	@State private var scroll = ScrollTracker()
	@State private var tickCount = 0

	init(parent: FamilyChoice, model: GenreOnboardingModel, onContinue: @escaping () -> Void) {
		self.parent = parent
		self.model = model
		self.onContinue = onContinue
	}

	/// The last family ends the flow with "Terminer" (or "Enregistrer" when editing): the model knows the
	/// position of the step. A family outside the steps cannot be shown, so it reads as the first one.
	private var ctaTitle: String {
		model.ctaTitle(forStep: model.subgenreSteps.firstIndex(of: parent.id) ?? 0)
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: Track1Tokens.spacing12) {
				Track1Text(parent.name, role: .title1, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextPrimary)
					.accessibilityAddTraits(.isHeader)
				Track1Text("Sélectionne les sous-genres qui t'intéressent", role: .bodyMedium)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
				// With no row ticked the family stands for all of its genres, so "Tous" and an empty list give the
				// same profile: said once, always shown, so that ticking a first row never shifts the list.
				Track1Text(OnboardingCopy.wholeFamilyHint, role: .bodySmall, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
				// Figma puts an 8 pt spacer between two 12 pt gaps: 32 pt between the subtitle and the chip.
				SelectAllChip(isSelected: model.isAllSelected(of: parent.id)) {
					model.toggleAll(of: parent.id)
				}
				.padding(.top, Track1Tokens.spacing20)
				ForEach(model.subgenreChoices(of: parent.id)) { choice in
					SubgenreRow(
						name: choice.name, description: choice.definition,
						isSelected: model.isSubgenreSelected(choice.id)
					) {
						model.toggleSubgenre(choice.id, of: parent.id)
					}
					.accessibilityIdentifier(SubgenreRow.identifier(for: choice.id))
					.background { RowEdgeReader(id: choice.id, space: Space.content) }
				}
			}
			.coordinateSpace(name: Space.content)
			.background { ContentOffsetReader(space: Space.viewport) }
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, GenresStepLayout.contentInset)
			// Same top gap as the genre step: the scroll view already sits under the status bar.
			.padding(.top, Track1Tokens.spacing16)
			.padding(.bottom, Track1Tokens.spacing24)
		}
		.safeAreaInset(edge: .bottom, spacing: 0) {
			Self.actionBar(
				title: ctaTitle, counter: OnboardingCopy.counter(model.countedGenreCount),
				onContinue: onContinue
			)
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
		// opaque base color last (see `GenresStepView`).
		.background(alignment: .top) {
			AmbientGlow(tone: .ember).ignoresSafeArea(edges: .top)
		}
		.background {
			Track1Tokens.colorBackgroundBase.ignoresSafeArea()
		}
	}
}
