import SwiftUI
import Track1Core
import UIKit

/// The Today tab (Flow 2): the node of the day is the root of the stack, under the date of the Top bar. The
/// choice of the recommendation and the choice of the screen live in `Track1Core` (`TodayViewModel`,
/// `TodayPresentation`); this view only wires them to the router and to the node page.
struct TodayView: View {
	/// Restarts the load for the same tastes (a retry) without waiting for a new revision.
	private struct LoadKey: Hashable {
		let revision: Int
		let attempt: Int
	}

	private struct OpenKey: Hashable {
		let recommendationID: UUID?
		let attempt: Int
	}

	private let profile: Profile
	private let router: AppRouter
	private let readers: ContentReaders
	private let imageStore: NodeImageStore<UIImage>
	private let analytics: AnalyticsClient
	@Binding private var rootTitle: String?
	@State private var model: TodayViewModel
	@State private var opening: TodayOpening?
	/// The recommendation whose opening is under way. Read and written before the first `await`, so that a task
	/// restarted by a tab change cannot start it twice; cleared when it ends, so a failed one can run again.
	@State private var openingRecommendationID: UUID?
	@State private var attempt = 0
	@State private var isRetrying = false

	init(
		profile: Profile,
		router: AppRouter,
		readers: ContentReaders,
		imageStore: NodeImageStore<UIImage>,
		store: DailyRecommendationStore,
		analytics: AnalyticsClient,
		rootTitle: Binding<String?>
	) {
		self.profile = profile
		self.router = router
		self.readers = readers
		self.imageStore = imageStore
		self.analytics = analytics
		_rootTitle = rootTitle
		_model = State(
			initialValue: TodayViewModel(
				readCatalog: readers.catalog, store: store, recordEvent: { analytics.record($0) }))
	}

	var body: some View {
		screen
			// The Top bar replaces the system bar on every screen of the tab.
			.toolbar(.hidden, for: .navigationBar)
			.task(id: LoadKey(revision: profile.revision, attempt: attempt)) {
				await model.load(for: profile)
				// A cancelled load belongs to a newer one, which will clear the flag itself.
				if !Task.isCancelled { isRetrying = false }
			}
			.task(id: openKey) { await openRecommendation() }
	}

	private var openKey: OpenKey {
		OpenKey(recommendationID: TodayPresentation.recommendationID(of: model.state), attempt: attempt)
	}

	@ViewBuilder
	private var screen: some View {
		switch TodayPresentation.screen(state: model.state, opening: opening, isRetrying: isRetrying) {
		case .loading:
			RecommendationLoadingView(retry: retry)
		case .page(let opening):
			page(opening)
		case .emptyCatalog:
			Track1StatusView(.todayEmpty, action: { router.select(.genres) })
				.todayBackdrop()
		case .unavailable:
			Track1StatusView(.todayUnavailable, action: retry)
				.todayBackdrop()
		}
	}

	private func page(_ opening: TodayOpening) -> some View {
		NodeView(
			model: NodeViewModel(
				identity: opening.identity,
				context: opening.context,
				readNode: readers.node,
				readLinks: readers.links,
				recordEvent: { analytics.record($0) }
			),
			imageStore: imageStore,
			topBar: .date(.now, reason: TodayPresentation.reasonLine(of: model.state)),
			isRoot: true,
			openRelation: { relation, relationContext in
				router.openNode(relation.slug, context: relationContext, title: relation.name, in: .today)
			},
			selectCrumb: { crumb in router.popTo(index: crumb.index, in: .today) }
		)
		// A new recommendation (other tastes) is another page, not an update of this one.
		.id(opening.recommendationID)
	}

	private func retry() {
		isRetrying = true
		attempt += 1
	}

	/// Once per recommendation: the impression, then the one `discover()` that gives the page its context.
	/// The task id changes with the recommendation (or a retry), so a recomposition calls nothing.
	private func openRecommendation() async {
		rootTitle = TodayPresentation.rootTitle(of: model.state)
		guard let id = TodayPresentation.recommendationID(of: model.state),
			opening?.recommendationID != id, openingRecommendationID != id
		else { return }
		openingRecommendationID = id
		defer { openingRecommendationID = nil }
		await model.recordImpressionIfNeeded()
		guard let discovered = await model.discover() else { return }
		opening = TodayOpening(
			recommendationID: id, identity: discovered.identity, context: discovered.context)
	}
}
