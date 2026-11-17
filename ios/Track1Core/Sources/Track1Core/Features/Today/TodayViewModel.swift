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
///
/// A new pick also plans the next days (2026-11-17, TRA-743, plan D4): those picks are saved in the same
/// history, as ordinary entries with a future date, so the day that comes serves the very work its reminder
/// named even if the catalog changed meanwhile.
@MainActor
@Observable
public final class TodayViewModel {
	public private(set) var state: TodayState = .loading
	/// The reminders planned by the last `load` that picked and saved a work, or by an `extendPlanIfNeeded` that
	/// saved its plan: always the whole plan, today excluded, never only its new days. Empty whenever `state`
	/// changes without a plan: that includes a load that served the persisted entry of the day, which reads no
	/// catalog to plan from, so empty means "nothing new to schedule", not "cancel what is scheduled".
	public private(set) var upcoming: [PlannedReminder] = []

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
		// An artist persisted before TRA-713 (2026-11-16) is no longer a valid pick: it is ignored here, which
		// means the catalog is read again, so a failed read shows `.unavailable` instead of that artist. A new
		// pick below drops it from the history because it replaces the entry of the current date; when no
		// candidate remains, nothing is written and the artist stays on disk, unserved.
		if let existing = stored.last(where: { $0.localDate == localDate }),
			existing.profileRevision == profile.revision,
			Affinity.isRecommendable(existing.nodeType)
		{
			publish(.recommendation(existing))
			return
		}

		// `.notModified` carries no body: this reader has nothing to rank, like a failure.
		guard case .success(let catalog, _) = await readCatalog() else {
			if !Task.isCancelled, latestRequestedProfile == profile { publish(.unavailable) }
			return
		}
		guard !Task.isCancelled, latestRequestedProfile == profile else { return }

		let candidates = Affinity.rank(catalog: catalog, genreIDs: profile.genreIDs)
		guard !candidates.isEmpty else {
			publish(.emptyCatalog)
			return
		}

		// The catalog read can take seconds: re-read right before saving so a `markViewed` that landed in
		// the meantime is kept instead of overwritten by the snapshot taken above.
		let others = await store.history().filter { $0.localDate != localDate }
		// Entries dated after today are plans, not works the person has been given: `pick` counts every other
		// date as seen, so they would change today's work depending on whether a plan happens to be on disk.
		let past = others.filter { $0.localDate < localDate }.sorted { $0.localDate < $1.localDate }
		guard
			let pick = DailySelection.pick(
				candidates: candidates, history: past, localID: profile.localID, localDate: localDate)
		else {
			publish(.emptyCatalog)
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

		// A stored plan of the current revision is kept by the plan itself, the others are picked again. One that
		// names today's work (a clock or time zone that moved back) is left out too, so it is picked again and
		// today's work is not announced a second time.
		let keptPlan = others.filter { $0.localDate > localDate && $0.nodeID != recommendation.nodeID }
		let reminders = ReminderPlan.plan(
			candidates: candidates, history: past + [recommendation] + keptPlan,
			profile: profile, catalog: catalog, today: localDate, profileGenreNames: genreNames, makeID: makeID)

		// The store neither deduplicates nor sorts, and keeps the last entries: past days in date order, then
		// today, then the plan, so the oldest days are the ones to go. Rebuilding every date after today from the
		// plan is what replaces the plan of an older revision, and what bounds the future dates a clock that went
		// back could have left behind: they never push today's entry out of the last forty.
		let updated = past + [recommendation] + reminders.map(\.recommendation)
		switch await store.save(updated) {
		case .success: publish(.recommendation(recommendation), plan: reminders)
		case .failure: publish(.unavailable)
		}
	}

	/// Completes the plan of the next days when the day was served from disk (2026-11-17, TRA-783). `load` reads
	/// no catalog on that path, so a person who opens the app every day would never move the plan's horizon and
	/// the reminders would stop on the eighth day; the same goes for an app update, where today's entry exists
	/// and no plan is on disk. To be called after `load` has shown today's work: it does not change `state`.
	///
	/// It acts only when the plan does not reach today + `ReminderPlan.horizonDays`, so a day with a complete
	/// plan reads nothing. A catalog that cannot be read or ranked has no effect at all: no write, `state` and
	/// `upcoming` as they were. The days already planned keep their entries, and the whole plan is saved
	/// together with the history of `load`, so the file holds one entry per date.
	public func extendPlanIfNeeded(for profile: Profile) async {
		await acquire()
		defer { release() }
		guard !Task.isCancelled, latestRequestedProfile == profile else { return }
		// Read only once the lock is held: a `load` queued before this call may have replaced the state. A shown
		// work from another day or another taste is not an anchor to plan from.
		let localDate = DailySelection.localDate(for: now(), timeZone: timeZone())
		guard case .recommendation(let shown) = state, shown.localDate == localDate,
			shown.profileRevision == profile.revision,
			let horizon = ReminderPlan.horizonDate(after: localDate)
		else { return }
		let isCurrentPlan = { (entry: DailyRecommendation) in
			entry.profileRevision == profile.revision && Affinity.isRecommendable(entry.nodeType)
		}
		let planned = await store.history()
		guard !planned.contains(where: { $0.localDate == horizon && isCurrentPlan($0) }) else { return }

		// `.notModified` carries no body: this reader has nothing to rank, like a failure.
		guard case .success(let catalog, _) = await readCatalog() else { return }
		guard !Task.isCancelled, latestRequestedProfile == profile else { return }
		let candidates = Affinity.rank(catalog: catalog, genreIDs: profile.genreIDs)
		guard !candidates.isEmpty else { return }

		// Re-read right before saving, like `load`: the entry of the day is taken from the disk, not from `state`,
		// so a marker written since is kept.
		let stored = await store.history()
		guard let today = stored.last(where: { $0.localDate == localDate && isCurrentPlan($0) }) else { return }
		let past = stored.filter { $0.localDate < localDate }.sorted { $0.localDate < $1.localDate }
		let keptPlan = stored.filter { $0.localDate > localDate && $0.nodeID != today.nodeID }
		let genreNames = TodayReason.genreNames(
			selection: profile.selection, taxonomy: EditorialGenreTaxonomy(catalog: catalog))
		let reminders = ReminderPlan.plan(
			candidates: candidates, history: past + [today] + keptPlan,
			profile: profile, catalog: catalog, today: localDate, profileGenreNames: genreNames, makeID: makeID)
		guard !reminders.isEmpty, !Task.isCancelled, latestRequestedProfile == profile else { return }

		guard case .success = await store.save(past + [today] + reminders.map(\.recommendation)) else { return }
		// Other tastes may have been requested during the save: their `load` publishes its own plan.
		guard !Task.isCancelled, latestRequestedProfile == profile else { return }
		// Not assigned when unchanged: an observer of `upcoming` must not run again for the same plan.
		if upcoming != reminders { upcoming = reminders }
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

	/// The plan always changes together with the state it was computed for, so a load that returns early
	/// (cancelled or superseded) leaves both as they were, and one that ends without a plan shows none.
	private func publish(_ newState: TodayState, plan: [PlannedReminder] = []) {
		state = newState
		// Not assigned when unchanged: an observer of `upcoming` must not run again for the same plan.
		if upcoming != plan { upcoming = plan }
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
