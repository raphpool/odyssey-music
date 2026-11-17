import SwiftUI
import Track1Core

/// Measures of the v1 Genres tab (TRA-737, 393 x 844 reference frame): the profile page, the genres edited
/// in place with the cards of the onboarding, and the tenure at the foot. The ticket's measures are the
/// reference.
enum GenresTabMetrics {
	/// The column starts at y 78 of the 393 x 844 frame, whose status bar takes 59 pt. The scroll content
	/// starts under the safe area, so the column is pushed down by the difference (same rule as the genre
	/// screen, `GenresStepLayout.headerTop`).
	static let columnTop: CGFloat = 78
	static let referenceTopInset: CGFloat = 59
	static var columnTopPadding: CGFloat { columnTop - referenceTopInset }
	/// Between the profile header, the list and the tenure.
	static let columnSpacing = Track1Tokens.spacing16

	/// The list is drawn by `GenreSelectionList`, which owns these three measures: 16 from the screen edges, 12
	/// above and below, 12 between two cards. They are forwarded here so that a test keeps the tab and the list
	/// in line, and the section title takes the same side inset.
	static let listInset = GenreSelectionListMetrics.listInset
	static let listVerticalInset = GenreSelectionListMetrics.listVerticalInset
	static let listCardSpacing = GenreSelectionListMetrics.cardSpacing

	static let sectionTitle = "Tes genres"
	static let sectionTitleRole: Track1TextRole = .monoItem
	static let sectionTitleColor = Track1Tokens.colorTextPrimary

	/// Between the two lines of the tenure, and between "Tu explores" and the logotype.
	static let footSpacing = Track1Tokens.spacing2
	static let wordmarkSpacing = Track1Tokens.spacing4
	/// `Brand/Wordmark` is the "track1" logotype, the same asset as the Welcome screen.
	static let wordmarkImageName = "Brand/Wordmark"
	static let wordmarkSize = CGSize(width: 40.81, height: 8.88)
	static let wordmarkColor = Track1Tokens.colorTextPrimary
	static let footRole: Track1TextRole = .monoMicro
	static let footColor = Track1Tokens.colorTextTertiary
	static let tenureIdentifier = "profile-tenure"

	/// Under the button of the bar. The bar of `BottomActionBar` keeps 32 pt there; the tab draws it with none.
	static let barBottomInset: CGFloat = 0
	/// From the bottom of the button to the top of the tab bar (Figma: y 749 on the 844 frame).
	static let barAboveTabBar: CGFloat = 17
	/// Room under the last line of the tenure, so that it ends above the fade of the bar and not under it. The
	/// fade goes from transparent to opaque over 44.103 - 22.821 % of 195 pt, about 41.5 pt, and the scroll view
	/// ends where it is opaque.
	static let contentBottomInset = Track1Tokens.spacing48
	/// Trailing inset of the settings button.
	static let settingsTrailingInset = Track1Tokens.spacing16

	static let saveTitle = "Sauvegarder"

	/// `screen/gradient-top` (`#3D3429`) at the top, `background/elevated` (`#1A110E`) from 30.746 % of the
	/// height down, as on the root node of the tab.
	static let backgroundStops: [Gradient.Stop] = [
		.init(color: Track1Tokens.colorScreenGradientTop, location: 0),
		.init(color: Track1Tokens.colorBackgroundElevated, location: 0.30746),
	]
}

/// When "Sauvegarder" is active: the ticked genres differ from the saved ones, and there is at least one. The
/// order of ticking has no effect on the recommendation, so two orders of the same genres are not a change.
enum GenresTabSaveRule {
	static func isEnabled(selected: [String], saved: [String]) -> Bool {
		!selected.isEmpty && Set(selected) != Set(saved)
	}
}

/// The Genres tab (v1): the profile disc and pseudo, the genres edited in place with the cards of the
/// onboarding, and how long the profile has existed. Nothing is written when a card is ticked: the sticky
/// "Sauvegarder" bar commits the selection (arbitration Q10), and stays off while it equals the saved one.
/// The icon button at the top right opens the settings in a sheet.
struct GenresTabView: View {
	/// What the catalog gave: the selection in progress, built on its taxonomy, and every genre a saved profile
	/// may keep. The model is a `@State` of the tab (through `catalog`), not a value of its `body`: a model
	/// built in `body` would be rebuilt on every render and drop the ticks with it. It lives as long as the tab
	/// does, so leaving the tab keeps what was ticked; a relaunch starts again from the saved profile.
	private struct LoadedCatalog {
		let model: GenreSelectionModel
		let genreIDs: [NodeIdentity]
	}

	private enum CatalogState {
		case loading
		case ready(LoadedCatalog)
		case failed
	}

	/// Kept from the "Modifier mes genres" button this bar replaces: `NavigationTests` and `TodayFlowTests`,
	/// which TRA-737 does not own, read it as the proof that the Genres tab is up, even with the catalog
	/// unavailable. The bar is shown, and disabled, in every state of the tab, as the button was.
	static let saveIdentifier = "genres-edit"

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
	@State private var isSaving = false
	@State private var saveFailed = false
	/// The genres of the saved profile, as the model read them, to tell whether the selection has changed.
	@State private var savedGenres = [String]()

	/// The taxonomy is only read for a saved profile, and read again when one appears.
	private struct LoadKey: Equatable {
		let attempt: Int
		let hasProfile: Bool
	}

	/// The bar sits at the foot of the screen with no margin under its button, and 17 pt above the tab bar.
	/// `BottomActionBar` keeps 32 pt under its button and cannot be told otherwise, so the difference is taken
	/// back with a negative padding: the bar then ends 15 pt lower than its own frame, where the fade, which
	/// ends on that edge, is plain color.
	static var barBottomPadding: CGFloat {
		GenresTabMetrics.barBottomInset + GenresTabMetrics.barAboveTabBar - BottomActionBar.bottomInset
	}

	var body: some View {
		ScrollView {
			column
		}
		.safeAreaInset(edge: .bottom, spacing: 0) { saveBar }
		.background {
			LinearGradient(stops: GenresTabMetrics.backgroundStops, startPoint: .top, endPoint: .bottom)
				.ignoresSafeArea()
		}
		// The page draws its own header, with the settings button at its trailing edge.
		.toolbar(.hidden, for: .navigationBar)
		.task(id: LoadKey(attempt: attempt, hasProfile: profileState.profile != nil)) { await loadTaxonomy() }
		.sheet(isPresented: $showingSettings) { settingsSheet }
		.alert("Enregistrement indisponible", isPresented: $saveFailed) {
			Button("OK") {}
		} message: {
			Text("Tes genres n'ont pas été enregistrés. Appuie de nouveau sur « Sauvegarder ».")
		}
	}

	private var column: some View {
		VStack(spacing: GenresTabMetrics.columnSpacing) {
			top
			content
		}
		.frame(maxWidth: .infinity)
		.padding(.top, GenresTabMetrics.columnTopPadding)
		.padding(.bottom, GenresTabMetrics.contentBottomInset)
	}

	/// The header, centred, with the settings button at the trailing edge. Both are in one row, so that without
	/// a header (an unreadable profile) the button keeps a row of its own and covers nothing under it.
	private var top: some View {
		ZStack(alignment: .topTrailing) {
			header
				.frame(maxWidth: .infinity)
			Track1IconButton(.more, accessibilityLabel: "Réglages", kind: .ghost, size: .medium) {
				showingSettings = true
			}
			.accessibilityIdentifier("genres-settings")
			.padding(.trailing, GenresTabMetrics.settingsTrailingInset)
		}
	}

	/// The pseudo and the disc are required by the profile since TRA-758, so a readable profile always has
	/// both. Without a profile (unreadable, being deleted) there is nothing to draw.
	@ViewBuilder
	private var header: some View {
		if let profile = profileState.profile {
			ProfileHeader(disc: profile.disc, name: profile.displayName)
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
				editor(model: loaded.model, profile: profile)
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

	private func editor(model: GenreSelectionModel, profile: Profile) -> some View {
		VStack(spacing: GenresTabMetrics.columnSpacing) {
			// The list adds its own 12 pt above its first card, which is the gap under the title.
			VStack(alignment: .leading, spacing: 0) {
				Track1Text(GenresTabMetrics.sectionTitle, role: GenresTabMetrics.sectionTitleRole)
					.foregroundStyle(GenresTabMetrics.sectionTitleColor)
					.padding(.horizontal, GenresTabMetrics.listInset)
					.accessibilityAddTraits(.isHeader)
				GenreSelectionList(model: model)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			ProfileTenureFoot(days: tenureDays(of: profile))
		}
	}

	private func tenureDays(of profile: Profile) -> Int {
		ProfileTenure.days(since: profile.createdAt, now: Date(), calendar: Calendar.current)
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
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal, GenresTabMetrics.listInset)
	}

	private func note(_ text: String) -> some View {
		Track1Text(text, role: .bodyMedium)
			.foregroundStyle(Track1Tokens.colorTextSecondary)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, GenresTabMetrics.listInset)
	}

	private var saveBar: some View {
		BottomActionBar(
			title: GenresTabMetrics.saveTitle, isEnabled: canSave, counter: nil, identifier: Self.saveIdentifier
		) {
			Task { await save() }
		}
		.padding(.bottom, Self.barBottomPadding)
	}

	/// Needs the taxonomy (a model), a selection that differs from the saved one and is not empty, and no write
	/// already running: a double tap must not send two commits.
	private var canSave: Bool {
		guard !isSaving, case .profile = profileState, case .ready(let loaded) = catalog else { return false }
		return GenresTabSaveRule.isEnabled(selected: loaded.model.selectedGenres, saved: savedGenres)
	}

	private var settingsSheet: some View {
		NavigationStack {
			SettingsView(
				profileState: profileState,
				profileStore: profileStore,
				recentNodes: recentNodes,
				analytics: analytics,
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

	private func loadTaxonomy() async {
		// Coming back to the tab must neither fetch again nor lose the tree already held to a failed request.
		if case .ready = catalog { return }
		guard let profile = profileState.profile else { return }
		guard let loadCatalog else {
			catalog = .failed
			return
		}
		switch await loadCatalog() {
		case .success(let loaded, _):
			// A degraded catalog has no editorial taxonomy: the tab reads as unavailable, like a failed request.
			if let taxonomy = EditorialGenreTaxonomy(catalog: loaded) {
				let model = GenreSelectionModel(taxonomy: taxonomy, editing: profile)
				savedGenres = model.selectedGenres
				catalog = .ready(
					LoadedCatalog(
						model: model, genreIDs: loaded.nodes.filter { $0.type == .genre }.map(\.identity)))
			} else {
				catalog = .failed
			}
		case .failure, .notModified:
			catalog = .failed
		}
	}

	/// Writes the selection in progress, with the pseudo and the disc of the saved profile. On success the page
	/// stays where it is: the profile of the app is the new one (Today reads it again), and the bar goes off
	/// because the saved genres are now the ticked ones. On failure the ticks are kept and the alert offers to
	/// try again.
	private func save() async {
		guard canSave, case .profile(let profile) = profileState, case .ready(let loaded) = catalog else { return }
		isSaving = true
		defer { isSaving = false }
		// Read before the write: a card ticked while it runs is a new change, not part of this save.
		let submitted = loaded.model.selectedGenres
		let draft = loaded.model.makeDraft(displayName: profile.displayName, disc: profile.disc)
		switch await profileStore.commit(draft, availableGenreIDs: loaded.genreIDs) {
		case .saved(let saved):
			// Same event as the old edit screen sent: the names and properties do not change (J.4).
			if analytics.consent.status == .granted {
				analytics.record(
					AnalyticsEvent(
						name: .preferencesUpdated,
						properties: ["genres_count": .integer(saved.genreIDs.count), "action": .string("updated")],
						source: .settings
					)
				)
			}
			savedGenres = submitted
			profileWasSaved(saved)
		case .invalid, .invalidated, .unavailable:
			saveFailed = true
		}
	}
}

/// The two lines at the foot of the page (Figma `318:7039`): "Tu explores track1" with the logotype drawn as
/// an image, then "depuis 145 jours". VoiceOver reads one sentence, since the logotype has no text.
private struct ProfileTenureFoot: View {
	let days: Int

	var body: some View {
		VStack(spacing: GenresTabMetrics.footSpacing) {
			HStack(spacing: GenresTabMetrics.wordmarkSpacing) {
				Track1Text(ProfileTenure.prefix, role: GenresTabMetrics.footRole, verbatim: true)
					.foregroundStyle(GenresTabMetrics.footColor)
				Image(GenresTabMetrics.wordmarkImageName)
					.renderingMode(.template)
					.resizable()
					.frame(width: GenresTabMetrics.wordmarkSize.width, height: GenresTabMetrics.wordmarkSize.height)
					.foregroundStyle(GenresTabMetrics.wordmarkColor)
			}
			Track1Text(ProfileTenure.suffix(days: days), role: GenresTabMetrics.footRole, verbatim: true)
				.foregroundStyle(GenresTabMetrics.footColor)
		}
		.multilineTextAlignment(.center)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Text(verbatim: ProfileTenure.spoken(days: days)))
		.accessibilityIdentifier(GenresTabMetrics.tenureIdentifier)
	}
}

extension ProfileRead {
	fileprivate var profile: Profile? {
		guard case .profile(let profile) = self else { return nil }
		return profile
	}
}
