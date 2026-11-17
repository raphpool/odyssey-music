import SwiftUI
import Track1Core
import UIKit

/// Gives the onboarding stack its edge swipe back.
///
/// 2026-10-14 (TRA-405, ios-check): with the navigation bar hidden, UIKit's interactive pop gesture refuses to
/// begin, so the edge swipe left step 1.4 in place (`testTheBackGestureToWelcomeKeepsTheSelection`, named
/// `testTheBackGestureOfTheSecondStepKeepsTheSelection` until TRA-639) and,
/// as Figma draws no back control, the person was stuck there. The gesture's delegate is replaced by one that
/// allows it whenever there is a screen to go back to. It is scoped to this flow rather than to every
/// `UINavigationController` of the app. It sits on the root and on every pushed screen: a flow that reopens on
/// a later step (TRA-735) starts with the root already behind it, and a root that never appears sets nothing.
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

/// The answers of the first launch that the genre model does not hold: the pseudo and the disc. Like the
/// model, the host owns them, in the `@State` of its phase, and never in a parent's `body`: an object built
/// there would be rebuilt on every render and drop what the person typed with it. Nothing is persisted here:
/// the host saves the draft (`ProfileDraft`) the flow hands it.
@MainActor
@Observable
final class OnboardingAnswers {
	/// Already in its stored form (`PseudoRules.normalized`), as the pseudo screen hands it over.
	var displayName: String?
	var disc: ProfileDisc?

	init(displayName: String? = nil, disc: ProfileDisc? = nil) {
		self.displayName = displayName
		self.disc = disc
	}
}

/// The onboarding flow of Flow 1: Welcome, then the pseudo, the disc, the one genre screen, an accordion
/// of the editorial families whose genres are ticked as chips, and the notification opt-in (TRA-746). The
/// order is `OnboardingSteps.order`: Welcome is the root of the stack and the other steps are pushed on it. A
/// model built from a profile (`isEditing`) is the edit flow of the Genres tab (K.1): it opens on the genre
/// screen with no Welcome, pseudo, disc nor opt-in, and ends on "Enregistrer". `FirstLaunchOnboardingView`
/// hosts the first launch.
///
/// The caller owns `model` and `answers` (`@State` in its host): one created inside a parent's `body` would
/// be rebuilt on every render and drop what was chosen with it.
struct OnboardingFlowView: View {
	/// The screens pushed on Welcome, named as in `OnboardingStepID`. Welcome is the root, so it has no case.
	enum Step: Hashable {
		case pseudo, disc, genres, notifications

		init?(_ id: OnboardingStepID) {
			switch id {
			case .pseudo: self = .pseudo
			case .disc: self = .disc
			case .genres: self = .genres
			case .notifications: self = .notifications
			case .welcome: return nil
			}
		}

		var id: OnboardingStepID {
			switch self {
			case .pseudo: .pseudo
			case .disc: .disc
			case .genres: .genres
			case .notifications: .notifications
			}
		}
	}

	/// What a flow reopens on after the app was stopped: Welcome while the draft holds no answer, otherwise the
	/// first step whose answer is missing. The steps before it are pushed too, so that the back gesture goes
	/// through them as it did the first time. The genre step is never validated by the draft, so the flow never
	/// reopens on the opt-in: the profile is written when that step ends.
	static func resumePath(displayName: String?, disc: ProfileDisc?) -> [Step] {
		guard displayName != nil || disc != nil else { return [] }
		var path = [Step]()
		for id in OnboardingSteps.order(includesNotifications: true) {
			guard let step = Step(id) else { continue }
			path.append(step)
			if !OnboardingSteps.canLeave(id, pseudo: displayName, disc: disc, selectedGenres: 0) { break }
		}
		return path
	}

	let model: GenreSelectionModel
	private let answers: OnboardingAnswers?
	/// Nil in the edit flow, which has no opt-in step: it ends on the genre screen.
	private let reminderCenter: (any ReminderCenter)?
	private let onStepValidated: ((ProfileDraft) -> Void)?
	private let onFinish: (ProfileDraft) -> Void
	@State private var path: [Step]

	/// The edit flow: no pseudo, no disc, and nothing to save before the end.
	init(model: GenreSelectionModel, onFinish: @escaping (ProfileDraft) -> Void) {
		self.model = model
		answers = nil
		reminderCenter = nil
		onStepValidated = nil
		self.onFinish = onFinish
		_path = State(initialValue: [])
	}

	/// The first launch. `onStepValidated` receives the draft each time a step is left, with every answer given
	/// so far, to be saved: it is what a relaunch resumes from. `reminderCenter` is what the last step asks.
	init(
		model: GenreSelectionModel,
		answers: OnboardingAnswers,
		reminderCenter: any ReminderCenter,
		onStepValidated: @escaping (ProfileDraft) -> Void,
		onFinish: @escaping (ProfileDraft) -> Void
	) {
		self.model = model
		self.answers = answers
		self.reminderCenter = reminderCenter
		self.onStepValidated = onStepValidated
		self.onFinish = onFinish
		_path = State(initialValue: Self.resumePath(displayName: answers.displayName, disc: answers.disc))
	}

	var body: some View {
		NavigationStack(path: $path) {
			root
				.background(SwipeBackEnabler())
				.toolbar(.hidden, for: .navigationBar)
				.navigationDestination(for: Step.self) { step in
					destination(for: step)
						.background(SwipeBackEnabler())
						.toolbar(.hidden, for: .navigationBar)
						// The bar is hidden and Figma draws no back control: VoiceOver's two-finger scrub and
						// the edge swipe are the ways back, one step at a time. What was chosen stays in the
						// model and in `answers`.
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
			WelcomeView { leave(.welcome) }
		}
	}

	@ViewBuilder
	private func destination(for step: Step) -> some View {
		switch step {
		case .pseudo:
			PseudoStepView(initial: answers?.displayName) { pseudo in
				answers?.displayName = pseudo
				leave(.pseudo)
			}
		case .disc:
			if let answers {
				DiscStep(answers: answers) { leave(.disc) }
			}
		case .genres:
			genresStep
		case .notifications:
			if let reminderCenter {
				// The answer is not the flow's business: the profile is written either way, and Today plans
				// the reminders once it loads.
				NotificationOptInView(center: reminderCenter) { _ in leave(.notifications) }
			}
		}
	}

	private var genresStep: some View {
		GenresStepView(model: model) { leave(.genres) }
	}

	/// Only the first launch asks, and ends on the opt-in; the edit flow has no center and ends on the genres.
	private var includesNotifications: Bool { reminderCenter != nil }

	/// The step on screen: the root until something is pushed, which is the genre step in the edit flow.
	private var current: OnboardingStepID {
		path.last?.id ?? (model.isEditing ? .genres : .welcome)
	}

	/// Leaves `step` for the next one, or ends the flow after the last. Nothing happens unless `step` is the one
	/// on screen and `OnboardingSteps.canLeave` allows it: a second tap on a button before the push animation
	/// ends would otherwise stack a screen twice, and a tap that lands once its screen left the path would end
	/// the flow. The host must still ignore a second `onFinish`: a double tap on the last button sends two.
	private func leave(_ step: OnboardingStepID) {
		guard current == step, canLeave(step) else { return }
		let draft = model.makeDraft(displayName: answers?.displayName, disc: answers?.disc)
		let next = OnboardingSteps.next(after: step, includesNotifications: includesNotifications)
		guard let nextStep = next.flatMap({ Step($0) }) else {
			onFinish(draft)
			return
		}
		if step != .welcome { onStepValidated?(draft) }
		path.append(nextStep)
	}

	private func canLeave(_ step: OnboardingStepID) -> Bool {
		OnboardingSteps.canLeave(
			step, pseudo: answers?.displayName, disc: answers?.disc, selectedGenres: model.selectedSubgenreCount)
	}
}

/// The disc step. It reads the choice in its own `body`, so that the screen follows `answers`: a read made in
/// the destination closure of the stack would not be tracked by the screen.
private struct DiscStep: View {
	let answers: OnboardingAnswers
	let onContinue: () -> Void

	var body: some View {
		DiscStepView(selected: answers.disc, onSelect: { answers.disc = $0 }, onContinue: onContinue)
	}
}

/// The first launch (Flow 1, J.4): reads the editorial taxonomy from the catalog, opens the flow on the saved
/// draft and writes the profile when it ends. The host (`RootView`) shows it instead of the tabs while there
/// is no profile.
///
/// The model and the answers live in the `@State` of the phase, not in a parent's `body`: ones built there
/// would be rebuilt on every render and drop what was chosen with them.
struct FirstLaunchOnboardingView: View {
	private struct Loaded {
		let model: GenreSelectionModel
		let answers: OnboardingAnswers
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
	let reminderCenter: any ReminderCenter
	let loadCatalog: (@Sendable () async -> APIResult<Catalog>)?
	let finished: (Profile) -> Void

	@State private var phase = Phase.loading
	@State private var attempt = 0
	@State private var isSaving = false
	@State private var saveFailed = false
	/// The last write of a draft. Each one waits for the one before it, so that an older draft never lands after
	/// a newer one, and the commit waits for the last, so that none lands after the draft file was removed.
	@State private var draftSave: Task<Void, Never>?

	var body: some View {
		Group {
			switch phase {
			case .loading:
				Track1Tokens.colorBackgroundBase.ignoresSafeArea()
			case .ready(let loaded):
				OnboardingFlowView(
					model: loaded.model,
					answers: loaded.answers,
					reminderCenter: reminderCenter,
					onStepValidated: { draft in saveDraft(draft) },
					onFinish: { draft in save(draft, available: loaded.genreIDs) }
				)
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
		guard let loadCatalog, case .success(let saved) = await profileStore.beginInitialDraft(),
			case .success(let catalog, _) = await loadCatalog()
		else {
			phase = .unavailable
			return
		}
		guard let taxonomy = EditorialGenreTaxonomy(catalog: catalog) else {
			phase = .unavailable
			return
		}
		// Before the model is built, not after: the model hands its draft back whole, flag included, and every
		// step now saves that draft. A model built on the draft without the flag would write it back unset, and a
		// resumed flow would send `onboarding_started` twice.
		let draft = await recordStartIfNeeded(saved)
		phase = .ready(
			Loaded(
				model: GenreSelectionModel(taxonomy: taxonomy, draft: draft),
				answers: OnboardingAnswers(displayName: draft.displayName, disc: draft.disc),
				genreIDs: catalog.nodes.filter { $0.type == .genre }.map(\.identity)))
	}

	/// Same event as the flat onboarding sent, once per flow and only with consent. Returns the draft the flow
	/// goes on with: the one that holds the "sent" flag once the event was recorded.
	private func recordStartIfNeeded(_ draft: ProfileDraft) async -> ProfileDraft {
		guard !draft.onboardingStartedRecorded, analytics.consent.status == .granted,
			case .success(let recorded) = await profileStore.markOnboardingStarted(draft)
		else { return draft }
		analytics.record(
			AnalyticsEvent(
				name: .onboardingStarted,
				properties: ["flow_id": .string(recorded.flowID.uuidString.lowercased())],
				source: .onboarding
			)
		)
		return recorded
	}

	/// A step was validated: the draft is written so that a relaunch resumes on the next one. A write that fails
	/// only costs that resume, the answers are still in the flow, and the profile is written from them at the
	/// end.
	private func saveDraft(_ draft: ProfileDraft) {
		let previous = draftSave
		draftSave = Task {
			await previous?.value
			_ = await profileStore.saveDraft(draft)
		}
	}

	/// A double tap on the CTA sends two `onFinish`: the second is ignored from the first until the write fails.
	/// After a write that succeeds the flag stays up, so that a tap during the fade to the tabs cannot finish
	/// the flow a second time.
	private func save(_ draft: ProfileDraft, available: [NodeIdentity]) {
		guard !isSaving else { return }
		isSaving = true
		let lastDraftSave = draftSave
		Task {
			await lastDraftSave?.value
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
				isSaving = false
				saveFailed = true
			}
		}
	}
}
