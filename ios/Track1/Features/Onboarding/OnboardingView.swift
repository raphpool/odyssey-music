import SwiftUI

struct ProfileMissingView: View {
	let chooseProfile: () -> Void
	let exploreSearch: () -> Void

	var body: some View {
		ContentUnavailableView {
			Label("Votre découverte commence par vos goûts", systemImage: "music.note.list")
		} description: {
			Text(
				"Choisissez quelques genres pour recevoir une recommandation différente chaque jour. Aucun compte n’est nécessaire."
			)
		} actions: {
			VStack(spacing: Track1Theme.contentSpacing) {
				Text("Profil local")
					.font(.headline)
				Text("Vos choix restent sur cet iPhone et peuvent être effacés à tout moment.")
					.font(.footnote)
					.foregroundStyle(.secondary)
				Button("Choisir mes goûts", action: chooseProfile)
					.buttonStyle(Track1PrimaryButtonStyle())
					.accessibilityIdentifier("profile-choose")
				Button("Explorer la recherche", action: exploreSearch)
					.buttonStyle(.bordered)
					.accessibilityIdentifier("profile-explore-search")
			}
			.padding()
		}
		.navigationTitle("Aujourd’hui")
	}
}

struct OnboardingView: View {
	let apiClient: APIClient?
	let catalogProvider: (@Sendable () async -> APIResult<Catalog>)?
	let profileStore: ProfileStore
	let analytics: AnalyticsClient?
	let editingProfile: Profile?
	let complete: (Profile) -> Void
	let cancel: () -> Void
	let exploreWithoutProfile: () -> Void

	@State private var draft: ProfileDraft?
	@State private var genres = [CatalogNode]()
	@State private var isLoading = true
	@State private var couldNotLoadGenres = false
	@State private var storageUnavailable = false
	@State private var isSaving = false

	var body: some View {
		NavigationStack {
			Group {
				if isLoading {
					ProgressView("Chargement des genres")
				} else if storageUnavailable || couldNotLoadGenres || genres.isEmpty {
					ContentUnavailableView {
						Label(
							storageUnavailable ? "Enregistrement indisponible" : "Genres indisponibles",
							systemImage: "arrow.clockwise"
						)
					} description: {
						Text(
							storageUnavailable
								? "Vos goûts n’ont pas été enregistrés. Réessayez ou explorez la recherche sans créer de profil."
								: "Réessayez ou explorez la recherche sans créer de profil."
						)
						.accessibilityIdentifier(storageUnavailable ? "profile-storage-error" : "profile-genres-unavailable")
					} actions: {
						Button("Réessayer") { Task { await load() } }
						Button("Explorer sans profil", action: exploreWithoutProfile)
							.buttonStyle(.bordered)
					}
				} else {
					selection
				}
			}
			.navigationTitle(editingProfile == nil ? "Goûts musicaux" : "Modifier mes goûts")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Annuler") { cancelSelection() }
				}
			}
		}
		.task { await load() }
	}

	private var selection: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: Track1Theme.contentSpacing) {
				Text(editingProfile == nil ? "Quels sons vous parlent ?" : "Vos goûts musicaux")
					.font(.title)
					.bold()
				Text(ProfileSelection.selectionInstruction(available: genres.map(\.identity)))
					.foregroundStyle(.secondary)
				Text(selectionDescription)
					.font(.headline)
				LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
					ForEach(genres, id: \.identity) { genre in
						Button(genre.name) { toggle(genre.identity) }
							.buttonStyle(GenreChoiceStyle(selected: selectedGenreIDs.contains(genre.identity)))
							.accessibilityIdentifier("genre-\(genre.identity.rawValue)")
					}
				}
				Text("Votre sélection nourrit la recommandation du jour, sans enfermer l’exploration.")
					.font(.footnote)
					.foregroundStyle(.secondary)
				Button(editingProfile == nil ? "Continuer" : "Enregistrer") {
					Task { await commit() }
				}
				.buttonStyle(Track1PrimaryButtonStyle())
				.disabled(!canCommit || isSaving)
				.accessibilityIdentifier("profile-continue")
				Button("Explorer sans profil", action: exploreWithoutProfile)
					.buttonStyle(.borderless)
					.frame(maxWidth: .infinity, minHeight: Track1Theme.minimumHitTarget)
			}
			.padding()
		}
	}

	private var selectedGenreIDs: Set<NodeIdentity> {
		Set(draft?.genreIDs ?? [])
	}

	private var canCommit: Bool {
		ProfileSelection.isComplete(selected: Array(selectedGenreIDs), available: genres.map(\.identity))
	}

	private var selectionDescription: String {
		let count = selectedGenreIDs.count
		return count == 1 ? "1 genre sélectionné" : "\(count) genres sélectionnés"
	}

	private func load() async {
		isLoading = true
		couldNotLoadGenres = false
		storageUnavailable = false
		let result: Result<ProfileDraft, LocalStoreError>
		if let editingProfile {
			result = await profileStore.beginEditingDraft(from: editingProfile)
		} else {
			result = await profileStore.beginInitialDraft()
		}
		guard case .success(let savedDraft) = result else {
			storageUnavailable = true
			isLoading = false
			return
		}
		let catalogResult: APIResult<Catalog>
		if let catalogProvider {
			catalogResult = await catalogProvider()
		} else if let apiClient {
			catalogResult = await apiClient.catalog()
		} else {
			couldNotLoadGenres = true
			isLoading = false
			return
		}
		switch catalogResult {
		case .success(let catalog, _):
			genres = catalog.nodes
				.filter { $0.type == .genre }
				.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
			let reconciledGenreIDs = ProfileSelection.reconciled(
				selected: savedDraft.genreIDs,
				available: genres.map(\.identity)
			)
			let reconciledDraft = ProfileDraft(
				version: savedDraft.version,
				flowID: savedDraft.flowID,
				genreIDs: reconciledGenreIDs,
				onboardingStartedRecorded: savedDraft.onboardingStartedRecorded
			)
			if reconciledDraft != savedDraft {
				guard case .success(let persistedDraft) = await profileStore.saveDraft(reconciledDraft) else {
					storageUnavailable = true
					isLoading = false
					return
				}
				draft = persistedDraft
			} else {
				draft = savedDraft
			}
			if let draft { await recordOnboardingStartIfNeeded(draft) }
		case .failure, .notModified:
			couldNotLoadGenres = true
		}
		isLoading = false
	}

	private func toggle(_ identity: NodeIdentity) {
		guard let draft else { return }
		var genreIDs = draft.genreIDs
		if let index = genreIDs.firstIndex(of: identity) {
			genreIDs.remove(at: index)
		} else {
			genreIDs.append(identity)
		}
		let updatedDraft = ProfileDraft(
			version: draft.version,
			flowID: draft.flowID,
			genreIDs: genreIDs,
			onboardingStartedRecorded: draft.onboardingStartedRecorded
		)
		self.draft = updatedDraft
		Task { _ = await profileStore.saveDraft(updatedDraft) }
	}

	private func commit() async {
		guard let draft else { return }
		isSaving = true
		defer { isSaving = false }
		switch await profileStore.commit(draft, availableGenreIDs: genres.map(\.identity)) {
		case .saved(let profile):
			if analytics?.consent.status == .granted {
				if editingProfile == nil {
					analytics?.record(
						AnalyticsEvent(
							name: .onboardingCompleted,
							properties: [
								"flow_id": .string(profile.flowID.uuidString.lowercased()),
								"genres_count": .integer(profile.genreIDs.count),
							],
							source: .onboarding
						)
					)
				} else {
					analytics?.record(
						AnalyticsEvent(
							name: .preferencesUpdated,
							properties: ["genres_count": .integer(profile.genreIDs.count), "action": .string("updated")],
							source: .settings
						)
					)
				}
			}
			complete(profile)
		case .invalid, .invalidated, .unavailable:
			storageUnavailable = true
		}
	}

	private func cancelSelection() {
		if editingProfile != nil { Task { _ = await profileStore.discardEditingDraft() } }
		cancel()
	}

	private func recordOnboardingStartIfNeeded(_ draft: ProfileDraft) async {
		guard editingProfile == nil,
			!draft.onboardingStartedRecorded,
			analytics?.consent.status == .granted
		else { return }
		if case .success(let recordedDraft) = await profileStore.markOnboardingStarted(draft) {
			self.draft = recordedDraft
			analytics?.record(
				AnalyticsEvent(
					name: .onboardingStarted,
					properties: ["flow_id": .string(recordedDraft.flowID.uuidString.lowercased())],
					source: .onboarding
				)
			)
		}
	}
}

private struct GenreChoiceStyle: ButtonStyle {
	let selected: Bool

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.font(.headline)
			.frame(maxWidth: .infinity, minHeight: Track1Theme.minimumHitTarget)
			.padding(.horizontal, 8)
			.background(selected ? Track1Theme.actionTint : Color(.secondarySystemBackground), in: Capsule())
			.foregroundStyle(selected ? Color.white : Color.primary)
			.overlay {
				Capsule().stroke(selected ? Track1Theme.actionTint : Color(.separator), lineWidth: 1)
			}
			.opacity(configuration.isPressed ? 0.75 : 1)
	}
}
