import SwiftUI
import Track1Core
import UIKit

/// Gives the onboarding stack its edge swipe back.
///
/// 2026-10-14 (TRA-405, ios-check): with the navigation bar hidden, UIKit's interactive pop gesture refuses to
/// begin, so the edge swipe left step 1.4 in place (`testTheBackGestureToWelcomeKeepsTheSelection`, named
/// `testTheBackGestureOfTheSecondStepKeepsTheSelection` until TRA-639) and,
/// as Figma draws no back control, the person was stuck there. The gesture's delegate is replaced by one that
/// allows it whenever there is a screen to go back to. It sits on the root of the stack, which stays in it for
/// the whole flow, and is scoped to this flow rather than to every `UINavigationController` of the app.
private struct SwipeBackEnabler: UIViewControllerRepresentable {
	func makeUIViewController(context: Context) -> Host { Host() }

	func updateUIViewController(_ host: Host, context: Context) {}

	final class Host: UIViewController, UIGestureRecognizerDelegate {
		override func viewDidAppear(_ animated: Bool) {
			super.viewDidAppear(animated)
			guard let pop = navigationController?.interactivePopGestureRecognizer else { return }
			pop.delegate = self
			pop.isEnabled = true
		}

		func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
			(navigationController?.viewControllers.count ?? 0) > 1
		}
	}
}

/// The onboarding flow of Flow 1: Welcome, then the one genre screen, an accordion of the editorial families
/// whose genres are ticked as chips. A model built from a profile (`isEditing`) is the edit flow of the
/// Genres tab (K.1): it opens on that screen with no Welcome and ends on "Enregistrer".
/// `FirstLaunchOnboardingView` hosts the first launch.
///
/// The caller owns `model` (a `@State` in its host): a model created inside a parent's `body` would be
/// rebuilt on every render and drop the selection with it.
struct OnboardingFlowView: View {
	enum Step: Hashable {
		case genres
	}

	let model: GenreSelectionModel
	let onFinish: (ProfileDraft) -> Void
	@State private var path = [Step]()

	init(model: GenreSelectionModel, onFinish: @escaping (ProfileDraft) -> Void) {
		self.model = model
		self.onFinish = onFinish
	}

	var body: some View {
		NavigationStack(path: $path) {
			root
				.background(SwipeBackEnabler())
				.toolbar(.hidden, for: .navigationBar)
				.navigationDestination(for: Step.self) { _ in
					genresStep
						.toolbar(.hidden, for: .navigationBar)
						// The bar is hidden and Figma draws no back control: VoiceOver's two-finger scrub and
						// the edge swipe are the ways back, to Welcome.
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
			// The flow ends here. Only the genre step may finish, so a tap that lands once the screen has left
			// the path is ignored. The host must ignore a second `onFinish`: a double tap on the CTA sends two.
			if isOnGenresStep { onFinish(model.makeDraft()) }
		}
	}
}

/// The first launch (Flow 1, J.4): reads the editorial taxonomy from the catalog, opens the flow on the saved draft
/// and writes the profile when it ends. The host (`RootView`) shows it instead of the tabs while there is no
/// profile.
///
/// The model lives in the `@State` of the phase, not in a parent's `body`: a model built there would be
/// rebuilt on every render and drop the selection with it.
struct FirstLaunchOnboardingView: View {
	private struct Loaded {
		let model: GenreSelectionModel
		/// Every genre of the catalog: the profile keeps the ones that are still there.
		let genreIDs: [NodeIdentity]
	}

	private enum Phase {
		case loading
		case ready(Loaded)
		/// The catalog, the draft or the taxonomy is not there (a degraded catalog included): an empty list with
		/// a disabled CTA would say nothing.
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
			Text("Tes genres n'ont pas été enregistrés. Appuie de nouveau sur « Continuer ».")
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
		guard let taxonomy = EditorialGenreTaxonomy(catalog: catalog) else {
			phase = .unavailable
			return
		}
		phase = .ready(
			Loaded(
				model: GenreSelectionModel(taxonomy: taxonomy, draft: draft),
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

	/// A double tap on the CTA sends two `onFinish`: the second is ignored while the first one writes.
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
