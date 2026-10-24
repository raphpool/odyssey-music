import Foundation

/// The work chosen for one local date. JSON keys are snake_case for readability only: this record lives in the
/// native client's own `daily-recommendation.v1.json` and is never read by the React Native client, so it
/// deliberately omits RN-only fields such as `view_event_id` (2026-10-10 V1 plan, TRA-343: no Segment
/// transport, no storage shared with the Expo build).
public struct DailyRecommendation: Codable, Equatable, Sendable {
	public let recommendationID: UUID
	public let localDate: String
	public let profileRevision: Int
	public let nodeID: NodeIdentity
	public let nodeType: NodeType
	public let name: String
	public let teaser: String?
	public let reasons: [String]
	/// Editorial names of the genres ticked in the profile, in tick order, resolved when the pick was made so
	/// that the Today line is the same on every launch of the day without reading the catalog (2026-10-24,
	/// TRA-698). Empty when the profile has no editorial selection or the taxonomy was unavailable.
	public let profileGenreNames: [String]
	public var viewRecorded: Bool

	public init(
		recommendationID: UUID, localDate: String, profileRevision: Int, nodeID: NodeIdentity, nodeType: NodeType,
		name: String, teaser: String?, reasons: [String], profileGenreNames: [String] = [], viewRecorded: Bool
	) {
		self.recommendationID = recommendationID
		self.localDate = localDate
		self.profileRevision = profileRevision
		self.nodeID = nodeID
		self.nodeType = nodeType
		self.name = name
		self.teaser = teaser
		self.reasons = reasons
		self.profileGenreNames = profileGenreNames
		self.viewRecorded = viewRecorded
	}

	// Explicit keys: the wire format must not depend on a decoder's key strategy.
	enum CodingKeys: String, CodingKey {
		case recommendationID = "recommendation_id"
		case localDate = "local_date"
		case profileRevision = "profile_revision"
		case nodeID = "node_id"
		case nodeType = "node_type"
		case name, teaser, reasons
		case profileGenreNames = "profile_genre_names"
		case viewRecorded = "view_recorded"
	}

	/// Explicit so that `profile_genre_names` can be absent: `StoredHistory.Entry` drops every entry that fails
	/// to decode, so a synthesized initializer would empty the history of every existing install and re-pick
	/// today's work (2026-10-24, TRA-698, plan R8). The other keys stay required.
	public init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		recommendationID = try container.decode(UUID.self, forKey: .recommendationID)
		localDate = try container.decode(String.self, forKey: .localDate)
		profileRevision = try container.decode(Int.self, forKey: .profileRevision)
		nodeID = try container.decode(NodeIdentity.self, forKey: .nodeID)
		nodeType = try container.decode(NodeType.self, forKey: .nodeType)
		name = try container.decode(String.self, forKey: .name)
		teaser = try container.decodeIfPresent(String.self, forKey: .teaser)
		reasons = try container.decode([String].self, forKey: .reasons)
		profileGenreNames = try container.decodeIfPresent([String].self, forKey: .profileGenreNames) ?? []
		viewRecorded = try container.decode(Bool.self, forKey: .viewRecorded)
	}

	/// A missing teaser is written as `null` and no genre names as `[]`, not omitted, so every stored record
	/// carries the same key set.
	public func encode(to encoder: Encoder) throws {
		var container = encoder.container(keyedBy: CodingKeys.self)
		try container.encode(recommendationID, forKey: .recommendationID)
		try container.encode(localDate, forKey: .localDate)
		try container.encode(profileRevision, forKey: .profileRevision)
		try container.encode(nodeID, forKey: .nodeID)
		try container.encode(nodeType, forKey: .nodeType)
		try container.encode(name, forKey: .name)
		try container.encode(teaser, forKey: .teaser)
		try container.encode(reasons, forKey: .reasons)
		try container.encode(profileGenreNames, forKey: .profileGenreNames)
		try container.encode(viewRecorded, forKey: .viewRecorded)
	}
}

/// Swift port of the daily pick in `mobile/src/recommendation/daily.ts`: the same person and the same
/// date must choose the same work on both clients.
public enum DailySelection {
	/// FNV-1a 32 over UTF-8 keeps the pick stable across runtimes, unlike `Hasher`, which is seeded per run.
	static func fnv1a32(_ value: String) -> UInt32 {
		var hash: UInt32 = 0x811c_9dc5
		for byte in value.utf8 {
			hash ^= UInt32(byte)
			hash = hash &* 0x0100_0193
		}
		return hash
	}

	/// The calendar day in `timeZone` as `yyyy-MM-dd`. The Gregorian calendar and POSIX locale are pinned
	/// so a device set to another calendar or numbering system never changes the key.
	public static func localDate(for date: Date, timeZone: TimeZone) -> String {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = timeZone
		let formatter = DateFormatter()
		formatter.calendar = calendar
		formatter.timeZone = timeZone
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.dateFormat = "yyyy-MM-dd"
		return formatter.string(from: date)
	}

	/// Candidates are expected in `Affinity.rank` order. The hash indexes the eligible group itself:
	/// filtering after the modulo would skew a partially seen cycle.
	public static func pick(
		candidates: [AffinityCandidate], history: [DailyRecommendation], localID: UUID, localDate: String
	) -> AffinityCandidate? {
		guard !candidates.isEmpty else { return nil }
		let seen = Set(history.filter { $0.localDate != localDate }.map(\.nodeID))
		let unseen = candidates.filter { !seen.contains($0.identity) }
		let eligible = unseen.isEmpty ? candidates : unseen
		let key = "\(localID.uuidString.lowercased()):\(localDate)"
		// The modulo stays unsigned, like `>>> 0` in the RN client, so no platform's `Int` width matters.
		return eligible[Int(fnv1a32(key) % UInt32(eligible.count))]
	}
}
