import SwiftUI
import Track1Core

/// The onboarding flow of Flow 1: Welcome, the parent genres, then one subgenre step per selected parent.
/// Not wired into `RootView` until J.4, so nothing reaches it yet.
///
/// The caller owns `model` (a `@State` in its host): a model created inside a parent's `body` would be
/// rebuilt on every render and drop the selection with it.
struct OnboardingFlowView: View {
	enum Step: Hashable {
		case genres
		/// One step per selected parent, identified by the parent so that a step keeps its place in the path.
		case subgenres(NodeIdentity)
	}

	let model: OnboardingFlowModel
	let onFinish: (ProfileDraft) -> Void
	@State private var path = [Step]()

	init(model: OnboardingFlowModel, onFinish: @escaping (ProfileDraft) -> Void) {
		self.model = model
		self.onFinish = onFinish
	}

	var body: some View {
		NavigationStack(path: $path) {
			WelcomeView {
				// A second tap before the push animation ends must not stack a second Genres screen.
				if path.isEmpty { path.append(.genres) }
			}
			.toolbar(.hidden, for: .navigationBar)
			.navigationDestination(for: Step.self) { step in
				destination(for: step)
					.toolbar(.hidden, for: .navigationBar)
					// The bar is hidden and Figma draws no back control: VoiceOver's two-finger scrub and
					// the edge swipe are the ways back, to the previous step or to Welcome.
					.accessibilityAction(.escape) {
						if !path.isEmpty { path.removeLast() }
					}
			}
		}
	}

	@ViewBuilder
	private func destination(for step: Step) -> some View {
		switch step {
		case .genres:
			GenresStepView(model: model) {
				// Parents are chosen: the first subgenre step follows, in selection order. Only the top
				// of the path may advance, so a second tap before the push animation ends is ignored.
				if path.last == .genres, let first = model.subgenreSteps.first {
					path.append(.subgenres(first))
				}
			}
		case .subgenres(let parentID):
			// A parent that is no longer selected has no step; the path cannot hold one, since the parents
			// only change on the genre step, below it.
			if let parent = model.parentChoices.first(where: { $0.identity == parentID }) {
				SubgenresStepView(parent: parent, model: model) { advance(from: parentID) }
			}
		}
	}

	/// The next selected parent, or the end of the flow after the last one. The host must ignore a second
	/// `onFinish`: a double tap on the last CTA sends two.
	private func advance(from parentID: NodeIdentity) {
		guard path.last == .subgenres(parentID) else { return }
		if let next = model.subgenreStep(after: parentID) {
			path.append(.subgenres(next))
		} else {
			onFinish(model.makeDraft())
		}
	}
}
