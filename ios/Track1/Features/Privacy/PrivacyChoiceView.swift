import SwiftUI
import Track1Core

/// The analytics consent screen. Figma does not draw it (D14, validated at the 2026-10-11 gate, Q4): it is
/// composed from drawn components, an `AmbientGlow(.ember)`, `Track1Text` roles and two Large buttons. Only
/// the look is Nocturne; the choice and its persistence are the caller's.
struct PrivacyChoiceView: View {
	let consent: AnalyticsConsent
	let accept: () -> Void
	let decline: () -> Void

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: Track1Tokens.spacing16) {
				Track1Text("track1", role: .eyebrow)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
				Track1Text("Améliorer track1 ensemble ?", role: .title2)
					.foregroundStyle(Track1Tokens.colorTextPrimary)
					.accessibilityAddTraits(.isHeader)
				Track1Text(
					"Vous pouvez partager des événements anonymes pour nous aider à améliorer la découverte musicale.",
					role: .bodyMedium
				)
				.foregroundStyle(Track1Tokens.colorTextSecondary)
				PrivacyExplanation(
					title: "Ce que nous mesurons", detail: "Les étapes du parcours, sans vos recherches ni vos goûts.")
				PrivacyExplanation(
					title: "Ce qui reste privé", detail: "Aucun e-mail, profil publicitaire ou historique d’écoute.")
				PrivacyChoiceButton(
					title: "Accepter", kind: .primary, identifier: "analytics-consent-accept", action: accept
				)
				.padding(.top, Track1Tokens.spacing8)
				PrivacyChoiceButton(
					title: "Continuer sans partager", kind: .secondary, identifier: "analytics-consent-decline",
					action: decline)
				Track1Text("Ce choix reste modifiable dans Réglages.", role: .caption)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
			}
			.padding(Track1Tokens.spacing24)
		}
		.background(alignment: .top) { AmbientGlow(tone: .ember).ignoresSafeArea(edges: .top) }
		.background { Track1Tokens.colorBackgroundBase.ignoresSafeArea() }
		.accessibilityIdentifier("analytics-consent-choice")
	}
}

/// A Large `Track1Button` that fills the width. `Track1Button` sizes to its label and has no full-width
/// option, and Core is outside this ticket: as `BottomActionBar` does, the same style is applied to a
/// full-width label, with the same light impact as the button's `haptic`.
private struct PrivacyChoiceButton: View {
	let title: String
	let kind: Track1ButtonKind
	let identifier: String
	let action: () -> Void
	@State private var taps = 0

	var body: some View {
		Button {
			taps += 1
			action()
		} label: {
			Track1Text(title, role: Track1ControlSize.large.labelRole)
				.multilineTextAlignment(.center)
				.frame(maxWidth: .infinity)
		}
		.buttonStyle(Track1ButtonStyle(kind: kind, size: .large, icon: nil, iconOnly: false))
		.sensoryFeedback(.impact(weight: .light), trigger: taps)
		.accessibilityIdentifier(identifier)
	}
}

private struct PrivacyExplanation: View {
	let title: String
	let detail: String

	var body: some View {
		VStack(alignment: .leading, spacing: Track1Tokens.spacing6) {
			Track1Text(title, role: .labelMedium).foregroundStyle(Track1Tokens.colorTextPrimary)
			Track1Text(detail, role: .bodySmall).foregroundStyle(Track1Tokens.colorTextSecondary)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(Track1Tokens.spacing16)
		.background(
			Track1Tokens.colorSurfaceDefault,
			in: RoundedRectangle(cornerRadius: Track1Tokens.radius16, style: .continuous))
	}
}
