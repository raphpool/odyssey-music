import SwiftUI
import Track1Core

struct PrivacyChoiceView: View {
	let consent: AnalyticsConsent
	let accept: () -> Void
	let decline: () -> Void

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				Text("track1")
					.font(.headline)
					.foregroundStyle(Track1Theme.actionTint)
				Image(systemName: "hand.raised.fill")
					.font(.system(size: 32, weight: .semibold))
					.foregroundStyle(Track1Theme.actionTint)
					.frame(width: 72, height: 72)
					.background(Track1Theme.sectionSurface, in: Circle())
				Text("Améliorer track1 ensemble ?")
					.font(.title)
					.fontWeight(.bold)
				Text("Vous pouvez partager des événements anonymes pour nous aider à améliorer la découverte musicale.")
					.font(.body)
					.foregroundStyle(.secondary)
				PrivacyExplanation(
					title: "Ce que nous mesurons", detail: "Les étapes du parcours, sans vos recherches ni vos goûts.",
					tint: .green)
				PrivacyExplanation(
					title: "Ce qui reste privé", detail: "Aucun e-mail, profil publicitaire ou historique d’écoute.",
					tint: .primary)
				Button("Accepter", action: accept)
					.buttonStyle(Track1PrimaryButtonStyle())
					.accessibilityIdentifier("analytics-consent-accept")
				Button("Continuer sans partager", action: decline)
					.buttonStyle(.borderless)
					.frame(maxWidth: .infinity, minHeight: Track1Theme.minimumHitTarget)
					.accessibilityIdentifier("analytics-consent-decline")
				Text("Ce choix reste modifiable dans Réglages.")
					.font(.caption)
					.foregroundStyle(.secondary)
			}
			.padding(24)
		}
		.accessibilityIdentifier("analytics-consent-choice")
	}
}

private struct PrivacyExplanation: View {
	let title: String
	let detail: String
	let tint: Color

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(title).font(.headline).foregroundStyle(tint)
			Text(detail).font(.footnote).foregroundStyle(.secondary)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding()
		.background(Track1Theme.sectionSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
	}
}
