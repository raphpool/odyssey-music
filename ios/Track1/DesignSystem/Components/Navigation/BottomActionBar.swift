import SwiftUI

/// Figma `Bottom action bar` (`173:137`, doc `173:139`; variants `173:123` Default and `173:130` Disabled;
/// on the genre screen `362:5074`): the pinned call to action of an onboarding step. A fade from transparent
/// to `colorBackgroundElevated`, an optional selection counter and, under it, a Large Primary button.
/// Disabled is the button's own state, read from `isEnabled` by `Track1Button` (42 % opacity, disabled
/// colors).
///
/// Place it with `safeAreaInset(edge: .bottom, spacing: 0)` on the screen so that the content scrolls under
/// the fade; the fade rises above the bar and its end color fills the home-indicator inset under it. The
/// Figma bar sits on a full-screen frame, where its 32 pt bottom padding is measured from the physical edge:
/// next to the safe area inset, the button ends up higher than in the capture, and the fade with it.
///
/// `identifier` is set on the button itself: an identifier set from outside on the bar would not replace the
/// one the button carries, so a screen that needs its own (`onboarding-start`) passes it here. `showsFade`
/// is off where the screen already owns the contrast under the button (the Welcome backdrop, `176:61`).
struct BottomActionBar: View {
	static let actionIdentifier = "bottom-action"
	static let counterIdentifier = "bottom-counter"

	/// What the bar is made of. `contentOrder` is the order they are laid out in, and so the reading order.
	enum Part: Hashable {
		case counter, button
	}

	/// The counter reads before the button (Figma `362:5074`: "Total : 1 genre" above "Continuer").
	static let contentOrder: [Part] = [.counter, .button]

	/// Height of the Figma bar (`362:5074`), the one the fade stops are measured on. The bar is shorter than
	/// that (24 + 20 + 8 + 52 + 32 = 136 pt): the fade rises above it, over the scrolled content. It stays
	/// 195 pt at larger text sizes, where the bar grows into the ramp.
	static let fadeHeight: CGFloat = 195

	/// Transparent from 22.821 % of `fadeHeight`, opaque from 44.103 %, as drawn in Figma. Outside the two
	/// stops the gradient keeps the nearest color. 2026-11-17 (TRA-767): the end color is
	/// `colorBackgroundElevated` (`#1A110E`), no longer `colorBackgroundBase` (`#120C0A`).
	static let fadeStops: [Gradient.Stop] = [
		.init(color: Track1Tokens.colorBackgroundElevated.opacity(0), location: 0.22821),
		.init(color: Track1Tokens.colorBackgroundElevated, location: 0.44103),
	]

	static let horizontalInset: CGFloat = Track1Tokens.spacing16
	static let topInset: CGFloat = Track1Tokens.spacing24
	static let bottomInset: CGFloat = Track1Tokens.spacing32
	/// Between the counter and the button.
	static let spacing: CGFloat = Track1Tokens.spacing8
	static let counterRole: Track1TextRole = .monoCounter
	static let counterColor = Track1Tokens.colorTextSecondary

	let identifier: String
	let showsFade: Bool
	private let title: String
	private let isEnabled: Bool
	private let counter: String?
	private let action: () -> Void

	init(
		title: String, isEnabled: Bool, counter: String?, identifier: String = BottomActionBar.actionIdentifier,
		showsFade: Bool = true, action: @escaping () -> Void
	) {
		self.title = title
		self.isEnabled = isEnabled
		self.counter = counter
		self.identifier = identifier
		self.showsFade = showsFade
		self.action = action
	}

	/// The parts this bar draws, in order: without a counter (Welcome) only the button is left, so nothing is
	/// laid out in its place.
	var parts: [Part] {
		Self.contentOrder.filter { $0 != .counter || counter != nil }
	}

	var body: some View {
		VStack(spacing: Self.spacing) {
			ForEach(parts, id: \.self) { part in
				switch part {
				case .counter:
					if let counter {
						Track1Text(counter, role: Self.counterRole, verbatim: true)
							.foregroundStyle(Self.counterColor)
							.multilineTextAlignment(.center)
							.accessibilityIdentifier(Self.counterIdentifier)
					}
				case .button:
					Track1Button(title, kind: .primary, size: .large, haptic: true, fullWidth: true, action: action)
						.disabled(!isEnabled)
						.accessibilityIdentifier(identifier)
				}
			}
		}
		.frame(maxWidth: .infinity)
		.padding(.horizontal, Self.horizontalInset)
		.padding(.top, Self.topInset)
		.padding(.bottom, Self.bottomInset)
		.background(alignment: .bottom) {
			if showsFade {
				// Hung on the bottom edge of the bar, which stands for the bottom of the Figma frame: the stops then
				// fall on the counter and the button as in Figma, whatever the home-indicator inset under the bar.
				// It rises above the bar, over the scrolled content, and must not catch the taps of the cards it
				// covers.
				LinearGradient(stops: Self.fadeStops, startPoint: .top, endPoint: .bottom)
					.frame(height: Self.fadeHeight)
					.allowsHitTesting(false)
			}
		}
		.background(alignment: .bottom) {
			if showsFade {
				// The fade has ended at the bar's bottom edge: the home-indicator inset under it takes the end color
				// so that no card shows there. A thin strip on that edge, whose background ignores the safe area.
				Color.clear
					.frame(height: 1)
					.background(Track1Tokens.colorBackgroundElevated, ignoresSafeAreaEdges: .bottom)
					.allowsHitTesting(false)
			}
		}
	}
}
