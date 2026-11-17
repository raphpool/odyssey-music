import SwiftUI

/// Figma `1.6 Loading` (`176:326`), shown while the daily recommendation is prepared. Since TRA-719 it is the
/// splash screen of the v1 mock-up (`318:6513`, `SplashView`): the Ambient glow, the line of text and the
/// Progress bar are gone, the mock-up does not draw them.
///
/// Past `timeout` it becomes the "taking longer than expected" status (D14, Q1), whose action starts over.
struct RecommendationLoadingView: View {
	/// Spec `176:338`, edge cases: "Timeout (> 20s)".
	static let timeout: Duration = .seconds(20)

	private let retry: () -> Void
	@State private var timedOut = false
	/// Restarts the timer: a retry that lands while the model is still loading does not recreate this view.
	@State private var run = 0

	init(retry: @escaping () -> Void) {
		self.retry = retry
	}

	var body: some View {
		Group {
			if timedOut {
				// The splash draws its own gradient; only the status needs the backdrop.
				Track1StatusView(.loadingTimeout, action: restart)
					.todayBackdrop()
			} else {
				SplashView()
			}
		}
		.task(id: run) {
			try? await Task.sleep(for: Self.timeout)
			if !Task.isCancelled { timedOut = true }
		}
	}

	private func restart() {
		timedOut = false
		run += 1
		retry()
	}
}

extension View {
	/// The root screens of the Today tab that have no page (the undrawn states): the Ember glow over the base
	/// color. The glow goes first: a later `.background` goes behind the earlier ones.
	func todayBackdrop() -> some View {
		background(alignment: .top) {
			AmbientGlow(tone: .ember).ignoresSafeArea(edges: .top)
		}
		.background { Track1Tokens.colorBackgroundBase.ignoresSafeArea() }
	}
}
