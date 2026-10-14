import SwiftUI
import Track1Core

struct SettingsView: View {
	let profileState: ProfileRead
	let profileStore: ProfileStore
	let recentNodes: RecentNodesStore
	let analytics: AnalyticsClient
	let editProfile: () -> Void
	let profileWasCleared: () -> Void
	@State private var showingAnalyticsChoice = false
	@State private var showingClearConfirmation = false
	@State private var isClearing = false
	@State private var recentsClearFailed = false

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: Track1Tokens.spacing24) {
				Track1Text("Votre profil musical reste sur ce téléphone.", role: .bodyMedium)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
					.padding(.horizontal, Track1Tokens.spacing16)
				SettingsSection(title: "Découverte") {
					if profileState.requiresExplicitRecovery {
						SettingsInfoRow(title: "Goûts musicaux", detail: profileState.recoveryDescription)
					} else {
						Track1ListItem(
							title: "Goûts musicaux", subtitle: profileDescription, accessory: .chevron, action: editProfile
						)
						.accessibilityIdentifier("profile-settings-edit")
						// Read by ProfileFlowTests (`.value`): the list item only exposes a combined label.
						.accessibilityValue(profileDescription)
					}
				}
				SettingsSection(title: "Confidentialité") {
					Track1ListItem(
						title: "Mesure d’usage",
						subtitle: analytics.consent.status == .granted ? "Autorisée" : "Non autorisée",
						accessory: .chevron
					) {
						showingAnalyticsChoice = true
					}
					.accessibilityIdentifier("analytics-settings")
				}
				SettingsSection(
					title: nil, footer: "L’effacement des goûts est distinct de la mesure d’usage et des notifications."
				) {
					Track1ListItem(
						title: profileState.requiresExplicitRecovery
							? "Supprimer le profil illisible" : "Effacer le profil musical",
						tone: .danger
					) {
						showingClearConfirmation = true
					}
					.disabled((profile == nil && !profileState.requiresExplicitRecovery) || isClearing)
					.accessibilityIdentifier(profileState.requiresExplicitRecovery ? "profile-recover" : "profile-clear")
				}
			}
			.padding(.vertical, Track1Tokens.spacing16)
			.padding(.horizontal, Track1Tokens.spacing8)
		}
		.background { Track1Tokens.colorBackgroundBase.ignoresSafeArea() }
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
		.alert("Fiches récentes non effacées", isPresented: $recentsClearFailed) {
			Button("OK", role: .cancel) {}
		} message: {
			Text("Votre profil musical est effacé, mais les fiches récentes sont restées sur cet iPhone.")
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
		// The recents belong to the same on-device data the screen promises to erase.
		// A failure does not undo the profile erasure, which is done: it is shown once the screen has moved on.
		let recentsCleared = await recentNodes.clear() == .cleared
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
		recentsClearFailed = !recentsCleared
	}
}

/// A titled group of rows. The title is `monoSection`; the optional footer is a secondary `bodySmall`.
private struct SettingsSection<Content: View>: View {
	let title: String?
	var footer: String?
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: Track1Tokens.spacing4) {
			if let title {
				Track1Text(title, role: .monoSection)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
					.padding(.horizontal, Track1Tokens.spacing16)
					.padding(.bottom, Track1Tokens.spacing4)
					.accessibilityAddTraits(.isHeader)
			}
			content
			if let footer {
				Track1Text(footer, role: .bodySmall)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
					.padding(.horizontal, Track1Tokens.spacing16)
					.padding(.top, Track1Tokens.spacing8)
			}
		}
	}
}

/// A row that does not navigate and is not tappable, laid out like a `Track1ListItem`: the unreadable
/// profile has no taste to edit, only a description to read.
private struct SettingsInfoRow: View {
	let title: String
	let detail: String

	var body: some View {
		VStack(alignment: .leading, spacing: Track1Tokens.spacing2) {
			Track1Text(title, role: .labelMedium).foregroundStyle(Track1Tokens.colorTextPrimary)
			Track1Text(detail, role: .bodySmall).foregroundStyle(Track1Tokens.colorTextSecondary)
		}
		.padding(.horizontal, Track1Tokens.spacing16)
		.padding(.vertical, Track1Tokens.spacing8)
		.frame(maxWidth: .infinity, minHeight: Track1ListItem.minHeight(hasArtwork: false), alignment: .leading)
		.accessibilityElement(children: .combine)
	}
}
