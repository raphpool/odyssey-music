import SwiftUI

/// Figma `Bottom action bar` (`173:137`, doc `173:139`; variants `173:123` Default and `173:130` Disabled):
/// the pinned call to action of an onboarding step. A fade from transparent to `colorBackgroundBase`, a
/// Large Primary button and an optional selection counter. Disabled is the button's own state, read from
/// `isEnabled` by `Track1Button` (42 % opacity, disabled colors).
///
/// Place it with `safeAreaInset(edge: .bottom, spacing: 0)` on the screen so that the content scrolls under
/// the fade; the fade extends under the home indicator. The Figma bar sits on a full-screen frame, where its
/// 32 pt bottom padding is measured from the physical edge: next to the safe area inset, the button ends up
/// higher than in the capture.
struct BottomActionBar: View {
	static let actionIdentifier = "bottom-action"
	static let counterIdentifier = "bottom-counter"

	/// Transparent at the top, opaque from 35 % of the height, as drawn in Figma (`via 35%`). The top of the
	/// button therefore overlaps the end of the fade, exactly as in the Figma bar.
	static let fadeStops: [Gradient.Stop] = [
		.init(color: Track1Tokens.colorBackgroundBase.opacity(0), location: 0),
		.init(color: Track1Tokens.colorBackgroundBase, location: 0.35),
		.init(color: Track1Tokens.colorBackgroundBase, location: 1),
	]

	private let title: String
	private let isEnabled: Bool
	private let counter: String?
	private let action: () -> Void
	@State private var taps = 0

	init(title: String, isEnabled: Bool, counter: String?, action: @escaping () -> Void) {
		self.title = title
		self.isEnabled = isEnabled
		self.counter = counter
		self.action = action
	}

	var body: some View {
		VStack(spacing: Track1Tokens.spacing8) {
			// `Track1Button` sizes to its label and has no full-width option, and Core is outside this ticket:
			// the same style is applied to a full-width label instead. Same light impact as its `haptic`.
			Button {
				taps += 1
				action()
			} label: {
				Track1Text(title, role: Track1ControlSize.large.labelRole)
					.multilineTextAlignment(.center)
					.frame(maxWidth: .infinity)
			}
			.buttonStyle(Track1ButtonStyle(kind: .primary, size: .large, icon: nil, iconOnly: false))
			.sensoryFeedback(.impact(weight: .light), trigger: taps)
			.disabled(!isEnabled)
			.accessibilityIdentifier(Self.actionIdentifier)
			if let counter {
				Track1Text(counter, role: .caption, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
					.multilineTextAlignment(.center)
					.accessibilityIdentifier(Self.counterIdentifier)
			}
		}
		.frame(maxWidth: .infinity)
		.padding(.horizontal, Track1Tokens.spacing16)
		.padding(.top, Track1Tokens.spacing24)
		.padding(.bottom, Track1Tokens.spacing32)
		.background {
			LinearGradient(stops: Self.fadeStops, startPoint: .top, endPoint: .bottom)
				.ignoresSafeArea(edges: .bottom)
		}
	}
}
