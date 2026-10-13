import SwiftUI

/// Figma `1.6 Loading` (`176:326`, spec `176:338`): the Ambient glow, one line of text and the Progress bar,
/// centered. It shows while the daily recommendation is prepared. The text is French (Q1, validated at the
/// 2026-10-11 gate); the Figma frame still carries the English draft.
///
/// Past `timeout` it becomes the "taking longer than expected" status (D14, Q1), whose action starts over.
struct RecommendationLoadingView: View {
	static let message = "Préparation de ta recommandation du jour…"
	/// Spec `176:338`, edge cases: "Timeout (> 20s)".
	static let timeout: Duration = .seconds(20)
	/// Figma frame width of the bar (`176:335`); a narrower screen gives it less.
	static let barMaxWidth: CGFloat = 320

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
				Track1StatusView(.loadingTimeout, action: restart)
			} else {
				loading
			}
		}
		.todayBackdrop()
		.task(id: run) {
			try? await Task.sleep(for: Self.timeout)
			if !Task.isCancelled { timedOut = true }
		}
	}

	private var loading: some View {
		VStack(spacing: Track1Tokens.spacing24) {
			Track1Text(Self.message, role: .headline)
				.foregroundStyle(Track1Tokens.colorTextSecondary)
				.multilineTextAlignment(.center)
				.accessibilityIdentifier("today-loading")
			Track1ProgressBar(mode: .indeterminate, accessibilityLabel: "Préparation de la recommandation du jour")
				.frame(maxWidth: Self.barMaxWidth)
		}
		.padding(.horizontal, Track1Tokens.spacing24)
		.padding(.bottom, Track1Tokens.spacing24)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}

	private func restart() {
		timedOut = false
		run += 1
		retry()
	}
}

extension View {
	/// The root screens of the Today tab that have no page (loading and the undrawn states): the Ember glow
	/// over the base color. The glow goes first: a later `.background` goes behind the earlier ones.
	func todayBackdrop() -> some View {
		background(alignment: .top) {
			AmbientGlow(tone: .ember).ignoresSafeArea(edges: .top)
		}
		.background { Track1Tokens.colorBackgroundBase.ignoresSafeArea() }
	}
}
