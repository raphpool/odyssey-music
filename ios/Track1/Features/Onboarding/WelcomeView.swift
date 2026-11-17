import SwiftUI

/// Measures of the Figma `1.1 Welcome` (`316:4853`, 393 x 852), read on 2026-11-17 (TRA-724). The central
/// block `362:4932` is a column centered in the space above the action bar (y 62 to 744); the text block
/// `316:4855` hangs under the app mark. A value changed here alone fails `OnboardingComponentsTests`.
enum WelcomeMetrics {
	/// Gap between the app mark and the text block (`362:4932`).
	static let markTextSpacing: CGFloat = Track1Tokens.spacing24
	/// Gap between the "track1" wordmark and the tagline (`316:4855`).
	static let wordmarkTaglineSpacing: CGFloat = Track1Tokens.spacing16
	/// The app mark (`362:4910`).
	static let markSize: CGFloat = AppMarkMetrics.welcomeSize
	/// The wordmark vector (`318:6607`). The tagline is as wide as it is, whatever the line count.
	static let wordmarkSize = CGSize(width: 136.032, height: 29.6)
	/// Side margin of the text block (`316:4855`).
	static let textSideMargin: CGFloat = Track1Tokens.spacing24
}

/// Figma `1.1 Welcome` (`316:4853`, spec `176:69`): the brand moment and single
/// entry point of the app. The app mark, the "track1" wordmark and the tagline sit centered in the space
/// above the action bar, over the `WelcomeBackdrop`, which owns the contrast veil. Dark only: no light
/// variant exists.
struct WelcomeView: View {
	/// Set on the bar's button (`BottomActionBar.identifier`).
	static let startIdentifier = "onboarding-start"
	/// Q1 / Q2 (plan): the product name is "track1" and the interface is in French.
	static let productName = "track1"
	static let tagline = "Explorations musicales quotidiennes"

	/// The wordmark is drawn (the `Brand/Wordmark` asset, node `318:6607`), so it has no text for VoiceOver:
	/// its label is the product name, and it is the screen's heading.
	static let wordmarkImageName = "Brand/Wordmark"
	static let wordmarkLabel = productName
	static var wordmarkTraits: AccessibilityTraits { .isHeader }

	/// What VoiceOver reads, top to bottom. The app mark is hidden (`AppMark`); `body` stacks the others in
	/// this order, with the bar last because `safeAreaInset` places it after the content.
	enum ReadingStop: Equatable {
		case wordmark, tagline, start
	}

	static let readingOrder: [ReadingStop] = [.wordmark, .tagline, .start]

	/// The bar as the screen builds it, so a test reads the parameters the screen really passes. The Figma
	/// Welcome has no fade under the button: the backdrop owns the contrast (TRA-440).
	@MainActor
	static func actionBar(start: @escaping () -> Void) -> BottomActionBar {
		BottomActionBar(
			title: "Démarrer", isEnabled: true, counter: nil, identifier: startIdentifier,
			showsFade: false, action: start)
	}

	private let start: () -> Void
	/// The Figma tagline is as wide as the wordmark (136.032 pt) and wraps on three lines in French (risk R13
	/// of the plan). The width grows with Dynamic Type, so that a larger tagline wraps between words rather
	/// than inside one; at the default size it is the Figma value.
	@ScaledMetric(relativeTo: .title3) private var taglineWidth = WelcomeMetrics.wordmarkSize.width

	init(start: @escaping () -> Void) {
		self.start = start
	}

	var body: some View {
		VStack(spacing: WelcomeMetrics.markTextSpacing) {
			AppMark(size: WelcomeMetrics.markSize)
			textBlock
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.safeAreaInset(edge: .bottom, spacing: 0) {
			Self.actionBar(start: start)
		}
		.background { WelcomeBackdrop() }
	}

	private var textBlock: some View {
		VStack(spacing: WelcomeMetrics.wordmarkTaglineSpacing) {
			Image(Self.wordmarkImageName)
				.renderingMode(.template)
				.resizable()
				.frame(width: WelcomeMetrics.wordmarkSize.width, height: WelcomeMetrics.wordmarkSize.height)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
				.accessibilityLabel(Self.wordmarkLabel)
				.accessibilityAddTraits(Self.wordmarkTraits)
			Track1Text(Self.tagline, role: .tagline)
				.foregroundStyle(Track1Tokens.colorTextSecondary)
				.multilineTextAlignment(.center)
				.frame(maxWidth: taglineWidth)
		}
		.padding(.horizontal, WelcomeMetrics.textSideMargin)
	}
}
