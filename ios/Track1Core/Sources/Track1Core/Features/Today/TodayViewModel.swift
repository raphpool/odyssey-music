import Foundation
import Observation

public enum TodayState: Equatable, Sendable {
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
/// `DailyRecommendationStore` serializes each of its own calls but not a caller's read-then-write sequence.
/// Every sequence that writes (`load`, the marker in `recordImpressionIfNeeded`) therefore runs inside one
/// FIFO section of this view model, and `load` re-reads the history right before saving it.
@MainActor
@Observable
public final class TodayViewModel {
	public private(set) var state: TodayState = .loading

	@ObservationIgnored private let readCatalog: @Sendable () async -> APIResult<Catalog>
	@ObservationIgnored private let store: DailyRecommendationStore
	@ObservationIgnored private let now: () -> Date
	@ObservationIgnored private let timeZone: () -> TimeZone
	@ObservationIgnored private let makeID: () -> UUID
	@ObservationIgnored private let recordEvent: NodeEventRecorder?

	@ObservationIgnored private var latestRequestedProfile: Profile?
	@ObservationIgnored private var emittedViewIDs = Set<UUID>()
	@ObservationIgnored private var isBusy = false
	@ObservationIgnored private var waiters: [CheckedContinuation<Void, Never>] = []

	public init(
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

	public func load(for profile: Profile) async {
		latestRequestedProfile = profile
		await acquire()
		defer { release() }
		// A waiter is resumed even when its task was cancelled meanwhile (the continuation is not
		// cancellable), so the lock always travels on. A cancelled `.task` has nobody left to show the result to.
		guard !Task.isCancelled else { return }
		// A newer request for other tastes was queued behind this one: computing and saving this pick would
		// only write an entry that the next load replaces.
		guard latestRequestedProfile == profile else { return }

		let localDate = DailySelection.localDate(for: now(), timeZone: timeZone())
		let stored = await store.history()
		if let existing = stored.last(where: { $0.localDate == localDate }),
			existing.profileRevision == profile.revision
		{
			state = .recommendation(existing)
			return
		}

		// `.notModified` carries no body: this reader has nothing to rank, like a failure.
		guard case .success(let catalog, _) = await readCatalog() else {
			if !Task.isCancelled, latestRequestedProfile == profile { state = .unavailable }
			return
		}
		guard !Task.isCancelled, latestRequestedProfile == profile else { return }

		let candidates = Affinity.rank(catalog: catalog, genreIDs: profile.genreIDs)
		guard !candidates.isEmpty else {
			state = .emptyCatalog
			return
		}

		// The catalog read can take seconds: re-read right before saving so a `markViewed` that landed in
		// the meantime is kept instead of overwritten by the snapshot taken above.
		let fresh = await store.history()
		guard
			let pick = DailySelection.pick(
				candidates: candidates, history: fresh, localID: profile.localID, localDate: localDate)
		else {
			state = .emptyCatalog
			return
		}
		// Resolved here, with the catalog already in hand, because a persisted recommendation is served without
		// reading it again (2026-10-24, TRA-698, plan D8).
		let genreNames = TodayReason.genreNames(
			selection: profile.selection, taxonomy: EditorialGenreTaxonomy(catalog: catalog))
		let recommendation = DailyRecommendation(
			recommendationID: makeID(),
			localDate: localDate,
			profileRevision: profile.revision,
			nodeID: pick.identity,
			nodeType: pick.type,
			name: pick.name,
			teaser: pick.teaser,
			reasons: pick.reasons,
			profileGenreNames: genreNames,
			viewRecorded: false)

		// The store does not deduplicate: dropping the current date here is what keeps one entry per date.
		let updated = fresh.filter { $0.localDate != localDate } + [recommendation]
		switch await store.save(updated) {
		case .success: state = .recommendation(recommendation)
		case .failure: state = .unavailable
		}
	}

	/// Emits `daily_recommendation_viewed` once per recommendation, then persists the marker. The marker is set
	/// even when analytics refuses the event: a consent granted later must not replay past impressions.
	public func recordImpressionIfNeeded() async {
		await acquire()
		defer { release() }
		// Read the state only once the lock is held: a `load` queued before this call may have replaced it.
		guard case .recommendation(let current) = state, !current.viewRecorded,
			!emittedViewIDs.contains(current.recommendationID)
		else { return }
		guard
			let stored = await store.history().last(where: { $0.recommendationID == current.recommendationID })
		else { return }
		guard !stored.viewRecorded else {
			state = .recommendation(stored)
			return
		}

		recordEvent?(Self.event(.dailyRecommendationViewed, for: current, at: now()))
		// Remembered before the write is attempted: if it fails, the marker on disk stays unset and a reload
		// would offer this recommendation again, but this session must not emit the event a second time.
		// A restart after a failed write can replay it, which no code here can prevent.
		emittedViewIDs.insert(current.recommendationID)
		var viewed = current
		viewed.viewRecorded = true
		state = .recommendation(viewed)
		_ = await store.markViewed(current.recommendationID)
	}

	public func discover() async -> (identity: NodeIdentity, context: NavigationContext)? {
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

	/// First come, first served, and the lock is handed straight to the next waiter so a newcomer cannot
	/// overtake it.
	private func acquire() async {
		if isBusy {
			await withCheckedContinuation { waiters.append($0) }
		} else {
			isBusy = true
		}
	}

	private func release() {
		if waiters.isEmpty {
			isBusy = false
		} else {
			waiters.removeFirst().resume()
		}
	}
}
