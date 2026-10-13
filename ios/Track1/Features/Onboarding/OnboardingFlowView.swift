import SwiftUI
import Track1Core

/// The onboarding flow of Flow 1: Welcome, the parent genres, then one subgenre step per selected parent.
/// A model built from a profile (`isEditing`) is the edit flow of the Genres tab (K.1): it opens on the genre
/// step with no Welcome and ends on "Enregistrer". `FirstLaunchOnboardingView` hosts the first launch.
///
/// The caller owns `model` (a `@State` in its host): a model created inside a parent's `body` would be
/// rebuilt on every render and drop the selection with it.
struct OnboardingFlowView: View {
	enum Step: Hashable {
		case genres
		/// One step per selected parent, identified by the parent so that a step keeps its place in the path.
		case subgenres(NodeIdentity)
	}

	let model: OnboardingFlowModel
	let onFinish: (ProfileDraft) -> Void
	@State private var path = [Step]()

	init(model: OnboardingFlowModel, onFinish: @escaping (ProfileDraft) -> Void) {
		self.model = model
		self.onFinish = onFinish
	}

	var body: some View {
		NavigationStack(path: $path) {
			root
				.toolbar(.hidden, for: .navigationBar)
				.navigationDestination(for: Step.self) { step in
					destination(for: step)
						.toolbar(.hidden, for: .navigationBar)
						// The bar is hidden and Figma draws no back control: VoiceOver's two-finger scrub and
						// the edge swipe are the ways back, to the previous step or to Welcome.
						.accessibilityAction(.escape) {
							if !path.isEmpty { path.removeLast() }
						}
				}
		}
	}

	/// Editing starts on the genre step: Welcome presents the app, and the person is already in it.
	@ViewBuilder
	private var root: some View {
		if model.isEditing {
			genresStep
		} else {
			WelcomeView {
				// A second tap before the push animation ends must not stack a second Genres screen.
				if path.isEmpty { path.append(.genres) }
			}
		}
	}

	/// The genre step is the root of the edit flow, and the first pushed screen of the first launch.
	private var isOnGenresStep: Bool {
		model.isEditing ? path.isEmpty : path.last == .genres
	}

	private var genresStep: some View {
		GenresStepView(model: model) {
			// Parents are chosen: the first subgenre step follows, in selection order. Only the genre step
			// may advance, so a second tap before the push animation ends is ignored.
			if isOnGenresStep, let first = model.subgenreSteps.first {
				path.append(.subgenres(first))
			}
		}
	}

	@ViewBuilder
	private func destination(for step: Step) -> some View {
		switch step {
		case .genres:
			genresStep
		case .subgenres(let parentID):
			// A parent that is no longer selected has no step; the path cannot hold one, since the parents
			// only change on the genre step, below it.
			if let parent = model.parentChoices.first(where: { $0.identity == parentID }) {
				SubgenresStepView(parent: parent, model: model) { advance(from: parentID) }
			}
		}
	}

	/// The next selected parent, or the end of the flow after the last one. The host must ignore a second
	/// `onFinish`: a double tap on the last CTA sends two.
	private func advance(from parentID: NodeIdentity) {
		guard path.last == .subgenres(parentID) else { return }
		if let next = model.subgenreStep(after: parentID) {
			path.append(.subgenres(next))
		} else {
			onFinish(model.makeDraft())
		}
	}
}

/// The first launch (Flow 1, J.4): reads the genre tree from the catalog, opens the flow on the saved draft
/// and writes the profile when it ends. The host (`RootView`) shows it instead of the tabs while there is no
/// profile.
///
/// The model lives in the `@State` of the phase, not in a parent's `body`: a model built there would be
/// rebuilt on every render and drop the selection with it.
struct FirstLaunchOnboardingView: View {
	private struct Loaded {
		let model: OnboardingFlowModel
		/// Every genre of the catalog: the profile keeps the ones that are still there.
		let genreIDs: [NodeIdentity]
	}

	private enum Phase {
		case loading
		case ready(Loaded)
		/// The catalog, the draft or the tree is not there: an empty grid with a disabled CTA would say nothing.
		case unavailable
	}

	let profileStore: ProfileStore
	let analytics: AnalyticsClient
	let loadCatalog: (@Sendable () async -> APIResult<Catalog>)?
	let finished: (Profile) -> Void

	@State private var phase = Phase.loading
	@State private var attempt = 0
	@State private var isSaving = false
	@State private var saveFailed = false

	var body: some View {
		Group {
			switch phase {
			case .loading:
				Track1Tokens.colorBackgroundBase.ignoresSafeArea()
			case .ready(let loaded):
				OnboardingFlowView(model: loaded.model) { draft in
					save(draft, available: loaded.genreIDs)
				}
			case .unavailable:
				Track1StatusView(.todayUnavailable) {
					phase = .loading
					attempt += 1
				}
				.todayBackdrop()
			}
		}
		.task(id: attempt) { await load() }
		.alert("Enregistrement indisponible", isPresented: $saveFailed) {
			Button("OK") {}
		} message: {
			Text("Tes genres n'ont pas été enregistrés. Appuie de nouveau sur « Terminer ».")
		}
	}

	private func load() async {
		// The view can appear again (a fade, a scene change): the flow in progress is not read again.
		if case .ready = phase { return }
		guard let loadCatalog, case .success(let draft) = await profileStore.beginInitialDraft(),
			case .success(let catalog, _) = await loadCatalog()
		else {
			phase = .unavailable
			return
		}
		let taxonomy = GenreTaxonomy(catalog: catalog)
		guard !taxonomy.parents.isEmpty else {
			phase = .unavailable
			return
		}
		phase = .ready(
			Loaded(
				model: OnboardingFlowModel(taxonomy: taxonomy, draft: draft),
				genreIDs: catalog.nodes.filter { $0.type == .genre }.map(\.identity)))
		await recordStartIfNeeded(draft)
	}

	/// Same event as the flat onboarding sent, once per flow and only with consent.
	private func recordStartIfNeeded(_ draft: ProfileDraft) async {
		guard !draft.onboardingStartedRecorded, analytics.consent.status == .granted,
			case .success(let recorded) = await profileStore.markOnboardingStarted(draft)
		else { return }
		analytics.record(
			AnalyticsEvent(
				name: .onboardingStarted,
				properties: ["flow_id": .string(recorded.flowID.uuidString.lowercased())],
				source: .onboarding
			)
		)
	}

	/// A double tap on the last CTA sends two `onFinish`: the second is ignored while the first one writes.
	private func save(_ draft: ProfileDraft, available: [NodeIdentity]) {
		guard !isSaving else { return }
		isSaving = true
		Task {
			defer { isSaving = false }
			switch await profileStore.commit(draft, availableGenreIDs: available) {
			case .saved(let profile):
				// Same event, name and properties as the flat onboarding sent (J.4): nothing new.
				if analytics.consent.status == .granted {
					analytics.record(
						AnalyticsEvent(
							name: .onboardingCompleted,
							properties: [
								"flow_id": .string(profile.flowID.uuidString.lowercased()),
								"genres_count": .integer(profile.genreIDs.count),
							],
							source: .onboarding
						)
					)
				}
				finished(profile)
			case .invalid, .invalidated, .unavailable:
				saveFailed = true
			}
		}
	}
}
