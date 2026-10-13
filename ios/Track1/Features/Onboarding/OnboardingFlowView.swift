import SwiftUI
import Track1Core

/// The onboarding flow of Flow 1: Welcome, then the parent genres. The subgenre steps arrive with J.3.
/// Not wired into `RootView` until J.4, so nothing reaches it yet.
///
/// The caller owns `model` (a `@State` in its host): a model created inside a parent's `body` would be
/// rebuilt on every render and drop the selection with it.
struct OnboardingFlowView: View {
	enum Step: Hashable {
		case genres
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
				switch step {
				case .genres:
					GenresStepView(model: model) {
						// J.3 pushes the subgenre steps here. Until then the parents alone are a valid
						// draft (D13: at least one genre), so the flow ends on this screen. The host must
						// ignore a second call: a double tap on Continuer sends two.
						onFinish(model.makeDraft())
					}
					.toolbar(.hidden, for: .navigationBar)
					// The bar is hidden and Figma draws no back control: VoiceOver's two-finger scrub and
					// the edge swipe are the ways back to Welcome.
					.accessibilityAction(.escape) { path.removeAll() }
				}
			}
		}
	}
}
