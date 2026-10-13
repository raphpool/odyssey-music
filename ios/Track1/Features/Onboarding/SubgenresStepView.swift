import AudioToolbox
import SwiftUI
import Track1Core

/// Figma `1.3 Subgenres · Hip-hop` (`176:166`, spec `176:209`) and `1.4 Subgenres · Jazz` (`176:223`, spec
/// `176:257`): the subgenres of one selected parent. The same screen serves both, the last step only differs
/// by its CTA label, which the model decides. The title, the chip and the rows scroll together; the action
/// bar stays pinned. Selection logic lives in `OnboardingFlowModel`, this view only reads and toggles it.
struct SubgenresStepView: View {
	/// Set on the bar's button (`BottomActionBar.identifier`).
	static let continueIdentifier = "onboarding-subgenres-continue"

	/// The bar as the screen builds it, so a test reads the parameters the screen really passes.
	/// "Continuer stays available while other parents remain" (spec `176:216`): a step with no row checked is
	/// valid, the parent alone is already a genre of the profile (D13).
	@MainActor
	static func actionBar(title: String, counter: String?, onContinue: @escaping () -> Void)
		-> BottomActionBar
	{
		BottomActionBar(
			title: title, isEnabled: true, counter: counter, identifier: continueIdentifier,
			action: onContinue)
	}

	/// The tick sound of the scroll (spec `176:219`): the system "Tock" click. A system sound, so the silent
	/// switch mutes it, as drawn.
	static let tickSound: SystemSoundID = 1104

	/// Names of the coordinate spaces the scroll measurements are expressed in.
	private enum Space {
		/// The whole screen: the bar and the scrolled content are both measured in it.
		static let viewport = "subgenres-viewport"
		/// The scrolled content: the rows keep the same coordinates in it while the list moves.
		static let content = "subgenres-content"
	}

	let parent: GenreChoice
	let model: OnboardingFlowModel
	private let onContinue: () -> Void

	/// Written on every scroll frame, so kept out of `@State` values: a reference does not invalidate the view.
	@State private var scroll = ScrollTracker()
	@State private var tickCount = 0

	init(parent: GenreChoice, model: OnboardingFlowModel, onContinue: @escaping () -> Void) {
		self.parent = parent
		self.model = model
		self.onContinue = onContinue
	}

	/// The last parent ends the flow with "Terminer" (or "Enregistrer" when editing): the model knows the
	/// position of the step. A parent outside the steps cannot be shown, so it reads as the first one.
	private var ctaTitle: String {
		model.ctaTitle(forStep: model.subgenreSteps.firstIndex(of: parent.identity) ?? 0)
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: Track1Tokens.spacing12) {
				Track1Text(parent.name, role: .title1, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextPrimary)
					.accessibilityAddTraits(.isHeader)
				Track1Text("Sélectionne les sous-genres qui t'intéressent", role: .bodyMedium)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
				// Figma puts an 8 pt spacer between two 12 pt gaps: 32 pt between the subtitle and the chip.
				SelectAllChip(isSelected: model.isAllSelected(of: parent.identity)) {
					model.toggleAll(of: parent.identity)
				}
				.padding(.top, Track1Tokens.spacing20)
				ForEach(model.subgenreChoices(of: parent.identity), id: \.identity) { choice in
					SubgenreRow(
						name: choice.name, description: choice.definition,
						isSelected: model.isSubgenreSelected(choice.identity)
					) {
						model.toggleSubgenre(choice.identity, of: parent.identity)
					}
					.accessibilityIdentifier(SubgenreRow.identifier(for: choice.identity))
					.background { RowEdgeReader(identity: choice.identity, space: Space.content) }
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
				title: ctaTitle, counter: OnboardingCopy.counter(model.selectedSubgenreCount),
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
			AudioServicesPlaySystemSound(Self.tickSound)
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

/// The scroll measurements and the offset they were last compared at.
@MainActor
private final class ScrollTracker {
	private var rowMaxYs = [NodeIdentity: CGFloat]()
	/// Top of the bar in the viewport space; nil until the first layout pass.
	private var barTop: CGFloat?
	private var lastOffset: CGFloat?

	/// A new layout is not a scroll: the offset that follows only sets the reference again, so a row that
	/// moved because the content was re-laid out (Dynamic Type, rotation, the safe area settling) never ticks.
	func layoutChanged(rowMaxYs: [NodeIdentity: CGFloat]) {
		self.rowMaxYs = rowMaxYs
		lastOffset = nil
	}

	func layoutChanged(barTop: CGFloat?) {
		self.barTop = barTop
		lastOffset = nil
	}

	/// The number of rows that passed the top of the bar since the previous offset. The first offset after a
	/// layout only sets the reference.
	func scrolled(toOffset offset: CGFloat) -> Int {
		defer { lastOffset = offset }
		guard let lastOffset, let barTop else { return 0 }
		return ScrollTickDetector.crossings(
			rowMaxYs: Array(rowMaxYs.values), previousOffset: lastOffset, newOffset: offset, threshold: barTop)
	}
}

private struct RowEdgeKey: PreferenceKey {
	static let defaultValue = [NodeIdentity: CGFloat]()

	static func reduce(value: inout [NodeIdentity: CGFloat], nextValue: () -> [NodeIdentity: CGFloat]) {
		value.merge(nextValue()) { _, new in new }
	}
}

private struct BarTopKey: PreferenceKey {
	static let defaultValue: CGFloat? = nil

	static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
		value = nextValue() ?? value
	}
}

private struct ContentMinYKey: PreferenceKey {
	static let defaultValue: CGFloat = 0

	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
		value = nextValue()
	}
}

/// Reports the bottom edge of the row it sits behind, in the content space.
private struct RowEdgeReader: View {
	let identity: NodeIdentity
	let space: String

	var body: some View {
		GeometryReader { proxy in
			Color.clear.preference(
				key: RowEdgeKey.self, value: [identity: proxy.frame(in: .named(space)).maxY])
		}
	}
}

/// Reports where the scrolled content starts in the viewport: its opposite is how far the list has scrolled.
private struct ContentOffsetReader: View {
	let space: String

	var body: some View {
		GeometryReader { proxy in
			Color.clear.preference(key: ContentMinYKey.self, value: proxy.frame(in: .named(space)).minY)
		}
	}
}

/// Reports the top edge of the action bar in the viewport.
private struct BarTopReader: View {
	let space: String

	var body: some View {
		GeometryReader { proxy in
			Color.clear.preference(key: BarTopKey.self, value: proxy.frame(in: .named(space)).minY)
		}
	}
}
