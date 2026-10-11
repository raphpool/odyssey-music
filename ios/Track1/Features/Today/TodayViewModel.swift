import Foundation
import Observation

enum TodayState: Equatable {
	case loading
	case recommendation(DailyRecommendation)
	case emptyCatalog
	case unavailable
}

/// Computes the daily discovery, persists it before exposing it and serves it back unchanged for the same
/// local date and the same taste revision.
///
/// A recommendation that is already persisted is shown without reading the catalog (2026-10-11 V1 decision,
/// TRA-343): a network outage must not hide the work the person was already given today.
///
/// Calls are expected one after the other. The store serializes each of its own calls but not a caller's
/// read-then-write, so overlapping `load` and `recordImpressionIfNeeded` calls can lose a write; guarding
/// against that is tracked in TRA-379.
@MainActor
@Observable
final class TodayViewModel {
	private(set) var state: TodayState = .loading

	@ObservationIgnored private let readCatalog: @Sendable () async -> APIResult<Catalog>
	@ObservationIgnored private let store: DailyRecommendationStore
	@ObservationIgnored private let now: () -> Date
	@ObservationIgnored private let timeZone: () -> TimeZone
	@ObservationIgnored private let makeID: () -> UUID
	@ObservationIgnored private let recordEvent: NodeEventRecorder?

	init(
		readCatalog: @escaping @Sendable () async -> APIResult<Catalog>,
		store: DailyRecommendationStore,
		now: @escaping () -> Date = { .now },
		timeZone: @escaping () -> TimeZone = { .current },
		makeID: @escaping () -> UUID = UUID.init,
		recordEvent: NodeEventRecorder? = nil
	) {
		self.readCatalog = readCatalog
		self.store = store
		self.now = now
		self.timeZone = timeZone
		self.makeID = makeID
		self.recordEvent = recordEvent
	}

	func load(for profile: Profile) async {
		let localDate = DailySelection.localDate(for: now(), timeZone: timeZone())
		let history = await store.history()
		if let existing = history.last(where: { $0.localDate == localDate }),
			existing.profileRevision == profile.revision
		{
			state = .recommendation(existing)
			return
		}

		// `.notModified` carries no body: this reader has nothing to rank, like a failure.
		guard case .success(let catalog, _) = await readCatalog() else {
			if !Task.isCancelled { state = .unavailable }
			return
		}
		guard !Task.isCancelled else { return }

		let candidates = Affinity.rank(catalog: catalog, genreIDs: profile.genreIDs)
		guard
			let pick = DailySelection.pick(
				candidates: candidates, history: history, localID: profile.localID, localDate: localDate)
		else {
			state = .emptyCatalog
			return
		}
		let recommendation = DailyRecommendation(
			recommendationID: makeID(),
			localDate: localDate,
			profileRevision: profile.revision,
			nodeID: pick.identity,
			nodeType: pick.type,
			name: pick.name,
			teaser: pick.teaser,
			reasons: pick.reasons,
			viewRecorded: false)

		// The store does not deduplicate: dropping the current date here is what keeps one entry per date.
		let updated = history.filter { $0.localDate != localDate } + [recommendation]
		switch await store.save(updated) {
		case .success: state = .recommendation(recommendation)
		case .failure: state = .unavailable
		}
	}

	/// Emits `daily_recommendation_viewed` once per recommendation, then persists the marker. The marker is set
	/// even when analytics refuses the event: a consent granted later must not replay past impressions.
	func recordImpressionIfNeeded() async {
		guard case .recommendation(let current) = state, !current.viewRecorded else { return }
		recordEvent?(Self.event(.dailyRecommendationViewed, for: current, at: now()))
		var viewed = current
		viewed.viewRecorded = true
		state = .recommendation(viewed)
		_ = await store.markViewed(current.recommendationID)
	}

	func discover() async -> (identity: NodeIdentity, context: NavigationContext)? {
		guard case .recommendation(let current) = state else { return nil }
		recordEvent?(Self.event(.dailyRecommendationOpened, for: current, at: now()))
		return (
			current.nodeID,
			NavigationContext(source: .home, recommendationID: current.recommendationID)
		)
	}

	private static func event(
		_ name: AnalyticsEventName, for recommendation: DailyRecommendation, at date: Date
	) -> AnalyticsEvent {
		AnalyticsEvent(
			name: name,
			properties: [
				"recommendation_id": .string(recommendation.recommendationID.uuidString.lowercased()),
				"local_date": .string(recommendation.localDate),
				"node_id": .string(recommendation.nodeID.rawValue),
				"node_type": .string(recommendation.nodeType.rawValue),
			],
			source: .home,
			occurredAt: date)
	}
}
