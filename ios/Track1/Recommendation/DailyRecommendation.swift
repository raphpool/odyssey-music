import Foundation

/// The work chosen for one local date. JSON keys are snake_case, like the React Native client.
struct DailyRecommendation: Codable, Equatable, Sendable {
	let recommendationID: UUID
	let localDate: String
	let profileRevision: Int
	let nodeID: NodeIdentity
	let nodeType: NodeType
	let name: String
	let teaser: String?
	let reasons: [String]
	var viewRecorded: Bool

	// Explicit keys: the wire format must not depend on a decoder's key strategy.
	enum CodingKeys: String, CodingKey {
		case recommendationID = "recommendation_id"
		case localDate = "local_date"
		case profileRevision = "profile_revision"
		case nodeID = "node_id"
		case nodeType = "node_type"
		case name, teaser, reasons
		case viewRecorded = "view_recorded"
	}

	/// A missing teaser is written as `null`, not omitted: the React Native client rejects a record without
	/// the key.
	func encode(to encoder: Encoder) throws {
		var container = encoder.container(keyedBy: CodingKeys.self)
		try container.encode(recommendationID, forKey: .recommendationID)
		try container.encode(localDate, forKey: .localDate)
		try container.encode(profileRevision, forKey: .profileRevision)
		try container.encode(nodeID, forKey: .nodeID)
		try container.encode(nodeType, forKey: .nodeType)
		try container.encode(name, forKey: .name)
		try container.encode(teaser, forKey: .teaser)
		try container.encode(reasons, forKey: .reasons)
		try container.encode(viewRecorded, forKey: .viewRecorded)
	}
}

/// Swift port of the daily pick in `mobile/src/recommendation/daily.ts`: the same person and the same
/// date must choose the same work on both clients.
enum DailySelection {
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
	static func localDate(for date: Date, timeZone: TimeZone) -> String {
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
	static func pick(
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
