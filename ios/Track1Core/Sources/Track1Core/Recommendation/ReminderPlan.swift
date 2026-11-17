import Foundation

/// One local notification to schedule: the work of a future day, worded for the lock screen.
public struct PlannedReminder: Equatable, Sendable {
	public let localDate: String
	public let hour: Int
	public let title: String
	public let body: String
	public let recommendation: DailyRecommendation

	public init(localDate: String, hour: Int, title: String, body: String, recommendation: DailyRecommendation) {
		self.localDate = localDate
		self.hour = hour
		self.title = title
		self.body = body
		self.recommendation = recommendation
	}
}

/// The picks of the next days, computed ahead of time (2026-11-17, TRA-739, plan D4). The daily reminder is a
/// local notification that names the work of the day, and that work is chosen on the device, so the app has
/// to know the following days' picks before the person opens it. Pure: the caller owns the clock, the
/// identifiers and the storage.
public enum ReminderPlan {
	public static let horizonDays = 7
	public static let hour = 9
	public static let title = "Ta recommandation du jour"

	/// The dates after `today` come from the same Gregorian calendar and POSIX locale as `DailySelection`, so a
	/// planned date is always the key `DailySelection.pick` would use on that day. A `today` that is not a real
	/// `yyyy-MM-dd` date plans nothing: guessing a day would schedule a reminder for the wrong one.
	///
	/// A stored entry is kept only under the conditions `TodayViewModel` serves one: it must belong to the
	/// current profile revision and still be a project or a track. Everything else is picked again with the days
	/// already planned in this call counted as seen. The caller's history is not edited, so an entry that is
	/// replaced still counts as seen for the later days: no work lands twice between the history and the plan.
	public static func plan(
		candidates: [AffinityCandidate], history: [DailyRecommendation], profile: Profile, catalog: Catalog,
		today: String, profileGenreNames: [String], makeID: () -> UUID
	) -> [PlannedReminder] {
		guard !candidates.isEmpty, let dates = upcomingDates(after: today) else { return [] }
		let nodes = nodeIndex(of: catalog)
		var seen = history
		var reminders: [PlannedReminder] = []
		for localDate in dates {
			let recommendation: DailyRecommendation
			if let existing = history.last(where: {
				$0.localDate == localDate && $0.profileRevision == profile.revision
					&& Affinity.isRecommendable($0.nodeType)
			}) {
				recommendation = existing
			} else {
				guard
					let pick = DailySelection.pick(
						candidates: candidates, history: seen, localID: profile.localID, localDate: localDate)
				else { continue }
				recommendation = DailyRecommendation(
					recommendationID: makeID(), localDate: localDate, profileRevision: profile.revision,
					nodeID: pick.identity, nodeType: pick.type, name: pick.name, teaser: pick.teaser,
					reasons: pick.reasons, profileGenreNames: profileGenreNames, viewRecorded: false)
				seen.append(recommendation)
			}
			reminders.append(
				PlannedReminder(
					localDate: localDate, hour: hour, title: title,
					body: body(for: recommendation, edges: catalog.edges, nodes: nodes), recommendation: recommendation))
		}
		return reminders
	}

	/// "Artist, album Name" or "Artist, morceau Name"; with no credited artist, "Album Name" or "Morceau Name".
	/// Artists are the targets of the node's `artists` edges, once each, in the order of `catalog.edges`. That
	/// order is the catalog's (edges are sorted by source then target identity, so artists come out
	/// alphabetically by identity), not the order of the credits, which the catalog does not carry. Every
	/// string comes from the network, so it is cleaned like the headers of the node page and never
	/// interpreted. A name that is blank once cleaned leaves the artists alone, or the bare kind when there is
	/// none. Only projects and tracks are recommended: any other type gets its cleaned name alone, with no
	/// kind and no artists.
	public static func body(for recommendation: DailyRecommendation, catalog: Catalog) -> String {
		body(for: recommendation, edges: catalog.edges, nodes: nodeIndex(of: catalog))
	}

	/// The last node wins on duplicate identities, like `Affinity.rank`. Built once per plan, not once per day.
	private static func nodeIndex(of catalog: Catalog) -> [NodeIdentity: CatalogNode] {
		Dictionary(catalog.nodes.map { ($0.identity, $0) }, uniquingKeysWith: { _, last in last })
	}

	private static func body(
		for recommendation: DailyRecommendation, edges: [CatalogEdge], nodes: [NodeIdentity: CatalogNode]
	) -> String {
		let name = NodePageHeader.clean(recommendation.name)
		let kind: String
		switch recommendation.nodeType {
		case .project: kind = "album"
		case .track: kind = "morceau"
		case .artist, .genre, .label: return name ?? ""
		}
		// Edge targets are untrusted: a target missing from the catalog, or that is not an artist, is ignored.
		var seen = Set<String>()
		let artists =
			edges
			.filter { $0.type == "artists" && $0.source == recommendation.nodeID }
			.compactMap { nodes[$0.target] }
			.filter { $0.type == .artist }
			.compactMap { NodePageHeader.clean($0.name) }
			.filter { seen.insert($0).inserted }
			.joined(separator: ", ")
		if artists.isEmpty { return [kind.capitalized, name].compactMap { $0 }.joined(separator: " ") }
		let work = name.map { "\(kind) \($0)" }
		return [artists, work].compactMap { $0 }.joined(separator: ", ")
	}

	/// The last date `plan` covers, `horizonDays` after `today`: what a caller checks, before reading the catalog,
	/// to know whether a stored plan already reaches it (2026-11-17, TRA-783). `nil` for a `today` that is not a
	/// real date, like `plan`, which then plans nothing.
	static func horizonDate(after today: String) -> String? {
		upcomingDates(after: today)?.last
	}

	/// UTC carries the calendar arithmetic only: it has no daylight saving jump that could skip or repeat a
	/// day, and the result is formatted back in the same zone. The round trip rejects `2026-02-30`, which
	/// `Calendar` would otherwise read as March 2nd.
	private static func upcomingDates(after today: String) -> [String]? {
		let parts = today.split(separator: "-", omittingEmptySubsequences: false)
		guard parts.count == 3, today.utf8.count == 10,
			let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2])
		else { return nil }
		var calendar = Calendar(identifier: .gregorian)
		let utc = TimeZone(identifier: "UTC") ?? TimeZone(secondsFromGMT: 0) ?? .current
		calendar.timeZone = utc
		guard let start = calendar.date(from: DateComponents(year: year, month: month, day: day)),
			DailySelection.localDate(for: start, timeZone: utc) == today
		else { return nil }
		return (1...horizonDays).compactMap { offset in
			calendar.date(byAdding: .day, value: offset, to: start).map {
				DailySelection.localDate(for: $0, timeZone: utc)
			}
		}
	}
}
