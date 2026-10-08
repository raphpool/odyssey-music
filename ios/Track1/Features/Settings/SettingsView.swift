import SwiftUI

struct SettingsView: View {
	let profileState: ProfileRead
	let profileStore: ProfileStore
	let analytics: AnalyticsClient
	let editProfile: () -> Void
	let profileWasCleared: () -> Void
	@State private var showingAnalyticsChoice = false
	@State private var showingClearConfirmation = false
	@State private var isClearing = false

	var body: some View {
		List {
			Section {
				Text("Votre profil musical reste sur ce téléphone.")
					.font(.subheadline)
					.foregroundStyle(.secondary)
			}
			Section("Découverte") {
				if profileState.requiresExplicitRecovery {
					LabeledContent("Goûts musicaux") {
						Text(profileState.recoveryDescription)
					}
				} else {
					Button(action: editProfile) {
						LabeledContent("Goûts musicaux") {
							Text(profileDescription)
						}
					}
					.accessibilityIdentifier("profile-settings-edit")
					.accessibilityValue(profileDescription)
				}
			}
			Section("Confidentialité") {
				Button {
					showingAnalyticsChoice = true
				} label: {
					LabeledContent("Mesure d’usage") {
						Text(analytics.consent.status == .granted ? "Autorisée" : "Non autorisée")
					}
				}
				.accessibilityIdentifier("analytics-settings")
			}
			Section {
				Button(
					profileState.requiresExplicitRecovery ? "Supprimer le profil illisible" : "Effacer le profil musical",
					role: .destructive
				) {
					showingClearConfirmation = true
				}
				.disabled((profile == nil && !profileState.requiresExplicitRecovery) || isClearing)
				.accessibilityIdentifier(profileState.requiresExplicitRecovery ? "profile-recover" : "profile-clear")
			} footer: {
				Text("L’effacement des goûts est distinct de la mesure d’usage et des notifications.")
			}
		}
		.navigationTitle("Réglages")
		.sheet(isPresented: $showingAnalyticsChoice) {
			PrivacyChoiceView(
				consent: analytics.consent,
				accept: {
					Task {
						await analytics.grant()
						showingAnalyticsChoice = false
					}
				},
				decline: {
					Task {
						await analytics.deny()
						showingAnalyticsChoice = false
					}
				}
			)
		}
		.alert(
			profileState.requiresExplicitRecovery ? "Supprimer le profil illisible ?" : "Effacer le profil musical ?",
			isPresented: $showingClearConfirmation
		) {
			Button("Effacer", role: .destructive) { Task { await clearProfile() } }
			Button("Annuler", role: .cancel) {}
		} message: {
			Text(
				profileState.requiresExplicitRecovery
					? "Cette suppression est nécessaire avant de créer un nouveau profil sur cet iPhone."
					: "Vos genres enregistrés sur cet iPhone seront supprimés."
			)
		}
	}

	private var profile: Profile? {
		guard case .profile(let profile) = profileState else { return nil }
		return profile
	}

	private var profileDescription: String {
		guard let profile else { return "Aucun profil" }
		return profile.genreIDs.count == 1 ? "1 genre sélectionné" : "\(profile.genreIDs.count) genres sélectionnés"
	}

	private func clearProfile() async {
		isClearing = true
		defer { isClearing = false }
		guard await profileStore.clear() == .cleared else { return }
		if analytics.consent.status == .granted {
			analytics.record(
				AnalyticsEvent(
					name: .preferencesUpdated,
					properties: ["genres_count": .integer(0), "action": .string("cleared")],
					source: .settings
				)
			)
		}
		profileWasCleared()
	}
}
