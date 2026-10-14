import SwiftUI
import Track1Core

/// The Genres tab (Figma `3.3`, spec `178:776`, "not designed yet"), composed from the drawn components by the
/// default validated at the 2026-10-11 gate (Q3, D14): the parent genres of the profile as read-only selected
/// tiles, a Primary button that opens the edit flow in a sheet, and an icon button that opens the settings in
/// another. Touching a tile does nothing in V1, and the order of selection has no effect on the recommendation.
struct GenresTabView: View {
	/// What the catalog gave: the tree the tiles come from, and every genre a saved profile may keep.
	private struct LoadedCatalog {
		let taxonomy: GenreTaxonomy
		let genreIDs: [NodeIdentity]
	}

	private enum CatalogState {
		case loading
		case ready(LoadedCatalog)
		case failed
	}

	let profileState: ProfileRead
	let profileStore: ProfileStore
	let recentNodes: RecentNodesStore
	let analytics: AnalyticsClient
	/// nil when the app has neither a catalog fixture nor an API client: the tab then reads as unavailable.
	let loadCatalog: (@Sendable () async -> APIResult<Catalog>)?
	let profileWasSaved: (Profile) -> Void
	let profileWasCleared: () -> Void

	@State private var catalog = CatalogState.loading
	@State private var attempt = 0
	@State private var showingSettings = false
	@State private var showingEditor = false
	/// "Goûts musicaux" lives in the settings sheet: it closes first, and the flow opens once it is gone, as
	/// two sheets cannot be presented at once.
	@State private var editAfterSettings = false
	@State private var isSaving = false
	/// "Goûts musicaux" was tapped before the tree was there: the flow opens as soon as it is.
	@State private var openEditorWhenReady = false

	/// The tree is only read for a saved profile, and read again when one appears (a first selection).
	private struct LoadKey: Equatable {
		let attempt: Int
		let hasProfile: Bool
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: Track1Tokens.spacing24) {
				header
				content
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, GenresStepLayout.contentInset)
			.padding(.top, Track1Tokens.spacing16)
			.padding(.bottom, Track1Tokens.spacing24)
		}
		.safeAreaInset(edge: .bottom, spacing: 0) { action }
		// Order matters: each `.background` sits behind the previous one, so the glow goes first and the
		// opaque base color last. The other way round, the base color hides the glow.
		.background(alignment: .top) {
			AmbientGlow(tone: .ember).ignoresSafeArea(edges: .top)
		}
		.background {
			Track1Tokens.colorBackgroundBase.ignoresSafeArea()
		}
		// The title is drawn in the page, with the settings button at its trailing edge.
		.toolbar(.hidden, for: .navigationBar)
		.task(id: LoadKey(attempt: attempt, hasProfile: profileState.profile != nil)) { await loadTaxonomy() }
		.sheet(isPresented: $showingSettings, onDismiss: openEditorIfRequested) { settingsSheet }
		.sheet(isPresented: $showingEditor) { editorSheet }
	}

	private var header: some View {
		HStack(alignment: .center, spacing: Track1Tokens.spacing12) {
			Track1Text("Mes genres", role: .title1)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
				.frame(maxWidth: .infinity, alignment: .leading)
				.accessibilityAddTraits(.isHeader)
			Track1IconButton(.more, accessibilityLabel: "Réglages", kind: .ghost, size: .medium) {
				showingSettings = true
			}
			.accessibilityIdentifier("genres-settings")
		}
	}

	@ViewBuilder
	private var content: some View {
		switch profileState {
		case .profile(let profile):
			switch catalog {
			case .loading:
				ProgressView().frame(maxWidth: .infinity).padding(.top, Track1Tokens.spacing40)
			case .failed:
				unavailable
			case .ready(let loaded):
				grid(of: profile, in: loaded.taxonomy)
			}
		case .missing:
			// Only seen while the tabs fade into the onboarding after the profile is deleted (J.4): a first
			// selection is not this tab's flow.
			EmptyView()
		case .unavailable:
			// The profile may exist and be unreadable for now: not an invitation to write a new one.
			note("Ton profil est illisible pour le moment. Réessaie plus tard.")
		case .corrupt, .unsupportedVersion:
			note("\(profileState.recoveryDescription) Supprimez-le depuis les réglages avant de recommencer.")
				.accessibilityIdentifier("genres-recovery-message")
		}
	}

	@ViewBuilder
	private func grid(of profile: Profile, in taxonomy: GenreTaxonomy) -> some View {
		// The model already normalizes a stored profile for the edit flow: the tab shows what the flow will.
		let parents = OnboardingFlowModel(taxonomy: taxonomy, editing: profile).selectedParentChoices
		if parents.isEmpty {
			// Every stored genre left the taxonomy (TRA-442): the flow lets the person choose again.
			note("Aucun de tes genres n'est dans la liste actuelle. Modifie-les pour en choisir.")
		} else {
			parentGrid(parents)
		}
	}

	private func parentGrid(_ parents: [GenreChoice]) -> some View {
		let columns = Array(
			repeating: GridItem(.flexible(), spacing: GenresStepLayout.gutter),
			count: GenresStepLayout.columnCount)
		return LazyVGrid(columns: columns, spacing: GenresStepLayout.gutter) {
			ForEach(parents, id: \.identity) { choice in
				// No genre image exists yet (Q5): every tile shows the placeholder gradient.
				GenreTile(name: choice.name, isSelected: true, artwork: nil) {}
					// Read-only in V1: the tile neither reacts to a touch nor reads as a button.
					.allowsHitTesting(false)
					.accessibilityRemoveTraits(.isButton)
					.accessibilityIdentifier(GenreTile.identifier(for: choice.identity))
			}
		}
	}

	private var unavailable: some View {
		VStack(alignment: .leading, spacing: Track1Tokens.spacing12) {
			note("Genres indisponibles pour le moment.")
			Track1Button("Réessayer", kind: .secondary, size: .medium) {
				catalog = .loading
				attempt += 1
			}
			.accessibilityIdentifier("genres-retry")
		}
	}

	private func note(_ text: String) -> some View {
		Track1Text(text, role: .bodyMedium)
			.foregroundStyle(Track1Tokens.colorTextSecondary)
	}

	private var action: some View {
		Track1Button("Modifier mes genres", kind: .primary, size: .large) { showingEditor = true }
			.disabled(!canAct)
			.accessibilityIdentifier("genres-edit")
			.frame(maxWidth: .infinity)
			.padding(.vertical, Track1Tokens.spacing12)
	}

	/// The edit flow needs the tree; a corrupt profile can only be deleted from the settings.
	private var canAct: Bool {
		switch profileState {
		case .profile:
			if case .ready = catalog { true } else { false }
		case .missing, .unavailable, .corrupt, .unsupportedVersion: false
		}
	}

	private var settingsSheet: some View {
		NavigationStack {
			SettingsView(
				profileState: profileState,
				profileStore: profileStore,
				recentNodes: recentNodes,
				analytics: analytics,
				editProfile: {
					editAfterSettings = true
					showingSettings = false
				},
				profileWasCleared: profileWasCleared
			)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					Button("Fermer") { showingSettings = false }
				}
			}
		}
	}

	@ViewBuilder
	private var editorSheet: some View {
		if case .profile(let profile) = profileState, case .ready(let loaded) = catalog {
			ProfileEditorSheet(profile: profile, taxonomy: loaded.taxonomy) { draft in
				await save(draft, available: loaded.genreIDs)
			}
		}
	}

	private func openEditorIfRequested() {
		guard editAfterSettings else { return }
		editAfterSettings = false
		switch (profileState.profile, catalog) {
		case (.some, .ready): showingEditor = true
		case (.some, _):
			// The tree is missing: load it again, and open the flow once it is there.
			openEditorWhenReady = true
			catalog = .loading
			attempt += 1
		case (nil, _): break
		}
	}

	private func loadTaxonomy() async {
		// Coming back to the tab must neither fetch again nor lose the tree already held to a failed request.
		if case .ready = catalog { return }
		guard profileState.profile != nil else { return }
		guard let loadCatalog else {
			catalog = .failed
			return
		}
		switch await loadCatalog() {
		case .success(let loaded, _):
			catalog = .ready(
				LoadedCatalog(
					taxonomy: GenreTaxonomy(catalog: loaded),
					genreIDs: loaded.nodes.filter { $0.type == .genre }.map(\.identity)))
			if openEditorWhenReady { showingEditor = true }
		case .failure, .notModified:
			catalog = .failed
		}
		openEditorWhenReady = false
	}

	/// True when the profile is saved, or when a save is already running: a double tap on the last CTA sends
	/// two `onFinish`, and the second must not raise an error.
	private func save(_ draft: ProfileDraft, available: [NodeIdentity]) async -> Bool {
		guard !isSaving else { return true }
		isSaving = true
		defer { isSaving = false }
		switch await profileStore.commit(draft, availableGenreIDs: available) {
		case .saved(let profile):
			// Same event as the old edit screen sent: the names and properties do not change (J.4).
			if analytics.consent.status == .granted {
				analytics.record(
					AnalyticsEvent(
						name: .preferencesUpdated,
						properties: ["genres_count": .integer(profile.genreIDs.count), "action": .string("updated")],
						source: .settings
					)
				)
			}
			showingEditor = false
			profileWasSaved(profile)
			return true
		case .invalid, .invalidated, .unavailable:
			return false
		}
	}
}

/// The host of the edit flow. The model is a `@State` here, not a value of the tab's `body`: a model built in a
/// parent's `body` would be rebuilt on every render and drop the selection with it.
private struct ProfileEditorSheet: View {
	@State private var model: OnboardingFlowModel
	@State private var saveFailed = false
	private let save: (ProfileDraft) async -> Bool

	init(profile: Profile, taxonomy: GenreTaxonomy, save: @escaping (ProfileDraft) async -> Bool) {
		_model = State(initialValue: OnboardingFlowModel(taxonomy: taxonomy, editing: profile))
		self.save = save
	}

	var body: some View {
		OnboardingFlowView(model: model) { draft in
			Task {
				let saved = await save(draft)
				saveFailed = !saved
			}
		}
		.alert("Enregistrement indisponible", isPresented: $saveFailed) {
			Button("OK") {}
		} message: {
			Text("Tes genres n'ont pas été enregistrés. Appuie de nouveau sur « Enregistrer ».")
		}
	}
}

extension ProfileRead {
	fileprivate var profile: Profile? {
		guard case .profile(let profile) = self else { return nil }
		return profile
	}
}
