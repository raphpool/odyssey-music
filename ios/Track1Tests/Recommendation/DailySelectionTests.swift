import Foundation
import XCTest

@testable import Track1

final class DailySelectionTests: XCTestCase {
	private let localID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!

	private func identity(_ index: Int) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: "artist:artist-\(index)"))
	}

	private func candidates(_ count: Int) throws -> [AffinityCandidate] {
		try (0..<count).map { index in
			AffinityCandidate(
				identity: try identity(index), type: .artist, name: "Artist \(index)", teaser: "Teaser \(index)",
				score: 3, reasons: ["Lié à Ambient"])
		}
	}

	private func recommendation(_ index: Int, on localDate: String) throws -> DailyRecommendation {
		DailyRecommendation(
			recommendationID: UUID(), localDate: localDate, profileRevision: 1, nodeID: try identity(index),
			nodeType: .artist, name: "Artist \(index)", teaser: nil, reasons: ["Lié à Ambient"],
			viewRecorded: true)
	}

	func testFNV1aMatchesTheReactNativeClient() {
		XCTAssertEqual(DailySelection.fnv1a32(""), 0x811c_9dc5)
		XCTAssertEqual(DailySelection.fnv1a32("a"), 0xe40c_292c)
		XCTAssertEqual(
			DailySelection.fnv1a32("00000000-0000-4000-8000-000000000000:2026-10-10"), 0x0e4f_82cb)
		XCTAssertEqual(DailySelection.fnv1a32("Sigur Rós"), 0x3471_c54a)
	}

	func testFNV1aHashesUTF8BytesNotCharacters() {
		// Precomposed and decomposed "é" are the same character but different bytes.
		XCTAssertNotEqual(DailySelection.fnv1a32("\u{00E9}"), DailySelection.fnv1a32("e\u{0301}"))
	}

	func testLocalDateFollowsTheTimeZone() throws {
		let instant = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-10T23:30:00Z"))
		let paris = try XCTUnwrap(TimeZone(identifier: "Europe/Paris"))
		let losAngeles = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
		XCTAssertEqual(DailySelection.localDate(for: instant, timeZone: paris), "2026-10-11")
		XCTAssertEqual(DailySelection.localDate(for: instant, timeZone: losAngeles), "2026-10-10")
	}

	func testPickReturnsNilWithoutCandidates() {
		XCTAssertNil(DailySelection.pick(candidates: [], history: [], localID: localID, localDate: "2026-11-03"))
	}

	func testPickIsStableForTheSamePersonAndDate() throws {
		let pool = try candidates(10)
		let first = DailySelection.pick(candidates: pool, history: [], localID: localID, localDate: "2026-11-03")
		let second = DailySelection.pick(candidates: pool, history: [], localID: localID, localDate: "2026-11-03")
		XCTAssertNotNil(first)
		XCTAssertEqual(first, second)
	}

	func testPickHashesTheLowercasedLocalID() throws {
		// uuidString is uppercase; the RN client hashes the lowercase form. Expected indexes come from the
		// RN implementation: the uppercase key would give 23 and 9 instead.
		let letters = try XCTUnwrap(UUID(uuidString: "ABCDEF01-AAAA-4BBB-8CCC-DDDDDDDDDDDD"))
		let pool = try candidates(41)
		let first = DailySelection.pick(candidates: pool, history: [], localID: letters, localDate: "2026-11-04")
		let second = DailySelection.pick(candidates: pool, history: [], localID: letters, localDate: "2026-11-03")
		XCTAssertEqual(first?.identity, try identity(12))
		XCTAssertEqual(second?.identity, try identity(39))
	}

	// Mirrors "hashes within the unseen candidates" in mobile/test/daily.test.ts.
	func testPickHashesWithinTheUnseenCandidates() throws {
		let history = [try recommendation(3, on: "2026-11-02")]
		let picked = DailySelection.pick(
			candidates: try candidates(4), history: history, localID: localID, localDate: "2026-11-03")
		XCTAssertEqual(picked?.identity, try identity(1))
	}

	func testPickIgnoresTheCurrentDateWhenCollectingSeenWorks() throws {
		// artist-2 was already picked for the date being recomputed, so it must stay eligible.
		let history = [try recommendation(2, on: "2026-11-05")]
		let picked = DailySelection.pick(
			candidates: try candidates(4), history: history, localID: localID, localDate: "2026-11-05")
		XCTAssertEqual(picked?.identity, try identity(2))
	}

	func testPickRecyclesTheWholePoolOnceEverythingHasBeenSeen() throws {
		let history = try (0..<4).map { try recommendation($0, on: "2026-10-0\($0 + 1)") }
		let picked = DailySelection.pick(
			candidates: try candidates(4), history: history, localID: localID, localDate: "2026-11-04")
		XCTAssertEqual(picked?.identity, try identity(1))
	}

	// Mirrors "excludes the forty latest candidates" in mobile/test/daily.test.ts.
	// The 40-entry cap belongs to the history owner; here the test trims it as that owner will.
	func testFortyOneDaysCoverFortyOneWorksWithAFortyEntryHistory() throws {
		let pool = try candidates(41)
		var history: [DailyRecommendation] = []
		var chosen = Set<NodeIdentity>()
		for day in 1...41 {
			let localDate = "2026-10-\(String(format: "%02d", day))"
			let picked = try XCTUnwrap(
				DailySelection.pick(candidates: pool, history: history, localID: localID, localDate: localDate))
			chosen.insert(picked.identity)
			let index = try XCTUnwrap(pool.firstIndex(of: picked))
			history = Array((history + [try recommendation(index, on: localDate)]).suffix(40))
		}
		XCTAssertEqual(chosen.count, 41)
	}

	func testRecommendationRoundTripKeepsSnakeCaseKeys() throws {
		let original = DailyRecommendation(
			recommendationID: try XCTUnwrap(UUID(uuidString: "33333333-3333-4333-8333-333333333333")),
			localDate: "2026-11-03", profileRevision: 2, nodeID: try identity(1), nodeType: .artist,
			name: "Artist 1", teaser: nil, reasons: ["Lié à Ambient"], viewRecorded: false)
		let data = try JSONEncoder().encode(original)
		let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		XCTAssertEqual(
			Set(object.keys),
			[
				"recommendation_id", "local_date", "profile_revision", "node_id", "node_type", "name", "teaser",
				"reasons", "view_recorded",
			])
		XCTAssertEqual(object["recommendation_id"] as? String, "33333333-3333-4333-8333-333333333333")
		XCTAssertEqual(object["node_id"] as? String, "artist:artist-1")
		XCTAssertEqual(object["node_type"] as? String, "artist")
		XCTAssertTrue(object["teaser"] is NSNull)
		XCTAssertEqual(try JSONDecoder().decode(DailyRecommendation.self, from: data), original)
	}

	func testDecodesTheReactNativeShape() throws {
		let json = """
			{"recommendation_id":"33333333-3333-4333-8333-333333333333","local_date":"2026-09-27",
			"profile_revision":1,"node_id":"artist:artist-0","node_type":"artist","name":"Artist 0",
			"teaser":null,"reasons":["Lié à Ambient"],"view_recorded":true}
			"""
		let decoded = try JSONDecoder().decode(DailyRecommendation.self, from: Data(json.utf8))
		XCTAssertEqual(decoded.localDate, "2026-09-27")
		XCTAssertEqual(decoded.nodeID, try identity(0))
		XCTAssertNil(decoded.teaser)
		XCTAssertTrue(decoded.viewRecorded)
	}
}
