import SwiftUI

/// Figma `1.1 Welcome` (`176:56`, spec `176:69`): the brand moment and single entry point of the app. The
/// name and the tagline sit centred in the space above the action bar, over the `WelcomeBackdrop`, which
/// owns the contrast veil. Dark only: no light variant exists.
struct WelcomeView: View {
	/// Set on the bar's container: `BottomActionBar` already gives its button `bottom-action`, and an
	/// identifier set from outside does not replace the one a child carries.
	static let startIdentifier = "onboarding-start"
	/// Q1 / Q2 (plan): the product name is "track1" and the interface is in French.
	static let productName = "track1"
	static let tagline = "Explorations musicales quotidiennes"

	private let start: () -> Void

	init(start: @escaping () -> Void) {
		self.start = start
	}

	var body: some View {
		VStack(spacing: Track1Tokens.spacing8) {
			Track1Text(Self.productName, role: .displayHero, verbatim: true)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
				.accessibilityAddTraits(.isHeader)
			// Figma sets the tagline in Label/Large (semibold 17/22) and `text/secondary`; the plan says
			// `bodyLarge`. Figma wins.
			Track1Text(Self.tagline, role: .labelLarge)
				.foregroundStyle(Track1Tokens.colorTextSecondary)
		}
		.multilineTextAlignment(.center)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.padding(.horizontal, Track1Tokens.spacing24)
		.padding(.bottom, Track1Tokens.spacing24)
		.safeAreaInset(edge: .bottom, spacing: 0) {
			BottomActionBar(title: "Démarrer", isEnabled: true, counter: nil, action: start)
				.accessibilityElement(children: .contain)
				.accessibilityIdentifier(Self.startIdentifier)
		}
		.background { WelcomeBackdrop() }
	}
}
