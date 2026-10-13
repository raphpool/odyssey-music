import SwiftUI
import Track1Core

/// Geometry of the genre grid (spec `176:114`): two columns, a 16 pt gutter, and tiles that keep the
/// 164:176 ratio of the Figma tile, so the height scales with the width on small screens.
enum GenresStepLayout {
	static let columnCount = 2
	static let gutter = Track1Tokens.spacing16
	/// "Content column = width - 2 x 24 pt" (Flow 1 principles, `176:51`).
	static let contentInset = Track1Tokens.spacing24

	/// `containerWidth` is the content column, not the screen. A width too small for the gutter gives an
	/// empty size rather than a negative one, which `frame` would reject.
	static func tileSize(containerWidth: CGFloat) -> CGSize {
		let gutters = gutter * CGFloat(columnCount - 1)
		let width = max((containerWidth - gutters) / CGFloat(columnCount), 0)
		return CGSize(width: width, height: width / GenreTile.aspectRatio)
	}
}

/// Figma `1.2a Genres · empty` (`176:80`) and `1.2b Genres · selected` (`176:122`): the parent genre
/// tiles of the taxonomy. The title, the subtitle and the grid scroll together; the action bar stays
/// pinned. Selection logic lives in `OnboardingFlowModel`, this view only reads and toggles it.
struct GenresStepView: View {
	/// Set on the bar's button (`BottomActionBar.identifier`).
	static let continueIdentifier = "onboarding-genres-continue"

	/// The CTA follows the model (spec: "Nothing selected -> Continuer is Disabled"), not a copy of it.
	@MainActor
	static func isContinueEnabled(_ model: OnboardingFlowModel) -> Bool {
		model.canContinueFromGenres
	}

	/// The bar as the screen builds it, so a test reads the parameters the screen really passes.
	@MainActor
	static func actionBar(model: OnboardingFlowModel, onContinue: @escaping () -> Void) -> BottomActionBar {
		BottomActionBar(
			title: "Continuer", isEnabled: isContinueEnabled(model), counter: nil,
			identifier: continueIdentifier, action: onContinue)
	}

	let model: OnboardingFlowModel
	private let onContinue: () -> Void

	init(model: OnboardingFlowModel, onContinue: @escaping () -> Void) {
		self.model = model
		self.onContinue = onContinue
	}

	var body: some View {
		GeometryReader { proxy in
			let tile = GenresStepLayout.tileSize(
				containerWidth: proxy.size.width - 2 * GenresStepLayout.contentInset)
			ScrollView {
				VStack(alignment: .leading, spacing: Track1Tokens.spacing16) {
					Track1Text("Sélectionne tes genres", role: .title1)
						.foregroundStyle(Track1Tokens.colorTextPrimary)
						.accessibilityAddTraits(.isHeader)
					Track1Text("Tu recevras une recommandation par jour pour les explorer", role: .bodyMedium)
						.foregroundStyle(Track1Tokens.colorTextSecondary)
					grid(tile: tile)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.horizontal, GenresStepLayout.contentInset)
				// Figma starts the title 72 pt from the screen edge, which is below the status bar on every
				// device; the scroll view already sits under it, so a token gap is enough.
				.padding(.top, Track1Tokens.spacing16)
				.padding(.bottom, Track1Tokens.spacing24)
			}
			.safeAreaInset(edge: .bottom, spacing: 0) {
				Self.actionBar(model: model, onContinue: onContinue)
			}
		}
		// Order matters: each `.background` sits behind the previous one, so the glow goes first and the
		// opaque base color last. The other way round, the base color hides the glow (TRA-403 review).
		.background(alignment: .top) {
			AmbientGlow(tone: .ember).ignoresSafeArea(edges: .top)
		}
		.background {
			Track1Tokens.colorBackgroundBase.ignoresSafeArea()
		}
	}

	private func grid(tile: CGSize) -> some View {
		let columns = Array(
			repeating: GridItem(.fixed(tile.width), spacing: GenresStepLayout.gutter),
			count: GenresStepLayout.columnCount)
		return LazyVGrid(columns: columns, spacing: GenresStepLayout.gutter) {
			ForEach(model.parentChoices, id: \.identity) { choice in
				// No genre image exists yet (Q5): every tile shows the placeholder gradient.
				GenreTile(
					name: choice.name, isSelected: model.selectedParents.contains(choice.identity),
					artwork: nil
				) {
					model.toggleParent(choice.identity)
				}
				.frame(width: tile.width, height: tile.height)
				.accessibilityIdentifier(GenreTile.identifier(for: choice.identity))
			}
		}
	}
}
