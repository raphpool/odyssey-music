import SwiftUI
import Track1Core
import UIKit

/// The Today tab (Flow 2): the root of the stack is the home of the day (`TodayHomeView`), and "Découvrir"
/// pushes the reader. The choice of the recommendation lives in `Track1Core` (`TodayViewModel`), the choice
/// of the screen in `TodayHomeScreen`; this view only wires them to the router and to the node it reads.
struct TodayView: View {
	/// Restarts the load for the same tastes (a retry) without waiting for a new revision.
	private struct LoadKey: Hashable {
		let revision: Int
		let attempt: Int
	}

	private struct PageKey: Hashable {
		let recommendationID: UUID?
		let attempt: Int
	}

	/// The home of one recommendation, once its node and its cover are read.
	private struct Page {
		let recommendationID: UUID
		let home: TodayHome
		let tint: CoverTint?
		let cover: Image?
	}

	private let profile: Profile
	private let router: AppRouter
	private let readers: ContentReaders
	private let imageStore: NodeImageStore<UIImage>
	@Environment(\.reminderSync) private var reminders
	@State private var model: TodayViewModel
	@State private var page: Page?
	/// The recommendation whose node could not be read: the retry status, never an empty card.
	@State private var failedRecommendationID: UUID?
	/// The recommendation being read. Written before the first `await`, so that a task restarted by a tab
	/// change (or by the return from the reader) cannot start it twice; cleared when it ends, so that a failed
	/// one can run again.
	@State private var readingRecommendationID: UUID?
	@State private var isOpening = false
	@State private var attempt = 0
	@State private var isRetrying = false

	init(
		profile: Profile,
		router: AppRouter,
		readers: ContentReaders,
		imageStore: NodeImageStore<UIImage>,
		store: DailyRecommendationStore,
		analytics: AnalyticsClient
	) {
		self.profile = profile
		self.router = router
		self.readers = readers
		self.imageStore = imageStore
		_model = State(
			initialValue: TodayViewModel(
				readCatalog: readers.catalog, store: store, recordEvent: { analytics.record($0) }))
	}

	var body: some View {
		screen
			// The home draws its own date; no system bar on any screen of the tab.
			.toolbar(.hidden, for: .navigationBar)
			.task(id: LoadKey(revision: profile.revision, attempt: attempt)) {
				await model.load(for: profile)
				// A cancelled load belongs to a newer one, which will clear the flag itself.
				if !Task.isCancelled { isRetrying = false }
				// After the home is on screen: the reminders of the next days follow what this load planned.
				await reminders?.sync(model, for: profile)
			}
			.task(id: pageKey) { await readPage() }
	}

	private var pageKey: PageKey {
		PageKey(recommendationID: TodayPresentation.recommendationID(of: model.state), attempt: attempt)
	}

	private var outcome: TodayHomeScreen.NodeOutcome? {
		if let page { return .ready(page.recommendationID) }
		return failedRecommendationID.map { .failed($0) }
	}

	@ViewBuilder
	private var screen: some View {
		switch TodayHomeScreen.choose(state: model.state, outcome: outcome, isRetrying: isRetrying) {
		case .loading:
			RecommendationLoadingView(retry: retry)
		case .home:
			if let page {
				TodayHomeView(
					home: page.home, tint: page.tint, cover: page.cover, isOpening: isOpening,
					discover: { Task { await discover() } }
				)
				// A new recommendation (other tastes) is another home, not an update of this one.
				.id(page.recommendationID)
			}
		case .emptyCatalog:
			Track1StatusView(.todayEmpty, action: { router.select(.genres) })
				.todayBackdrop()
		case .unavailable:
			Track1StatusView(.todayUnavailable, action: retry)
				.todayBackdrop()
		}
	}

	private func retry() {
		isRetrying = true
		failedRecommendationID = nil
		attempt += 1
	}

	/// Once per recommendation: reads its node and its cover, then, as the home appears, records the impression.
	/// The task id changes with the recommendation (or a retry), so a recomposition, a tab change or a return
	/// from the reader calls nothing.
	private func readPage() async {
		guard case .recommendation(let recommendation) = model.state,
			page?.recommendationID != recommendation.recommendationID,
			readingRecommendationID != recommendation.recommendationID
		else { return }
		readingRecommendationID = recommendation.recommendationID
		// Only its own marker: a newer read of other tastes may have taken the place by the time this one ends.
		defer {
			if readingRecommendationID == recommendation.recommendationID { readingRecommendationID = nil }
		}
		page = nil
		failedRecommendationID = nil
		// Unstructured: the cover of a read that the view's task abandons would stay `loading` for good, so a
		// tab change lets the read end and publish instead of cancelling it.
		await Task { await read(recommendation) }.value
	}

	private func read(_ recommendation: DailyRecommendation) async {
		let result = await readers.node(recommendation.nodeID)
		// A read that another recommendation has superseded publishes nothing: its page or its failure would
		// stand in for the current one, which never re-runs (same task id) and would stay on the loading screen.
		guard isCurrent(recommendation) else { return }
		guard case .success(let response, _) = result else {
			failedRecommendationID = recommendation.recommendationID
			return
		}
		let hero = NodeHeroModel(node: response.node, store: imageStore)
		await hero.load()
		guard isCurrent(recommendation) else { return }
		var cover: Image?
		if case .loaded(let image, _, _) = hero.state { cover = Image(uiImage: image) }
		page = Page(
			recommendationID: recommendation.recommendationID,
			// The day of the recommendation, not the clock: a read after midnight must not relabel yesterday's node.
			home: TodayHome(node: response.node, date: Self.date(of: recommendation), timeZone: .current),
			tint: NodePageView.coverTint(for: hero.state), cover: cover)
		await model.recordImpressionIfNeeded()
	}

	private func isCurrent(_ recommendation: DailyRecommendation) -> Bool {
		TodayPresentation.recommendationID(of: model.state) == recommendation.recommendationID
	}

	/// `localDate` is "yyyy-MM-dd" in the device's time zone (`DailySelection.localDate`); `TodayHome` reads the
	/// day back in that same zone. The clock only stands in for a value that does not parse.
	private static func date(of recommendation: DailyRecommendation) -> Date {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = .current
		formatter.dateFormat = "yyyy-MM-dd"
		return formatter.date(from: recommendation.localDate) ?? .now
	}

	/// One tap, one `discover()`: the button is disabled while it runs, and a second tap that gets in anyway
	/// stops here.
	private func discover() async {
		guard !isOpening else { return }
		isOpening = true
		defer { isOpening = false }
		guard let opening = await model.discover() else { return }
		router.openPlayer(opening.identity, context: opening.context, in: .today)
	}
}

private struct ReminderSyncKey: EnvironmentKey {
	static let defaultValue: ReminderSync? = nil
}

extension EnvironmentValues {
	var reminderSync: ReminderSync? {
		get { self[ReminderSyncKey.self] }
		set { self[ReminderSyncKey.self] = newValue }
	}
}
