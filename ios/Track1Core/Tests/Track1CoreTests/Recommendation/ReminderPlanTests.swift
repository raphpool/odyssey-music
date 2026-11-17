import Foundation
import XCTest

@testable import Track1Core

final class ReminderPlanTests: XCTestCase {
	private let localID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
	private let revision = "sha256:" + String(repeating: "0123456789abcdef", count: 4)

	// MARK: - Fixtures

	private func identity(_ rawValue: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: rawValue))
	}

	private func profile(revision: Int = 1) -> Profile {
		Profile(
			version: Profile.version, localID: localID, genreIDs: [], revision: revision, onboardingCompleted: true,
			flowID: UUID(), createdAt: Date(timeIntervalSince1970: 0))
	}

	/// Sequential, so two calls that make the same decisions also get the same identifiers.
	private func idMaker() -> () -> UUID {
		var next = 0
		return {
			next += 1
			return UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", next))!
		}
	}

	private func candidates(_ count: Int) throws -> [AffinityCandidate] {
		try (0..<count).map { index in
			AffinityCandidate(
				identity: try identity("project:project-\(index)"), type: .project, name: "Project \(index)",
				teaser: nil, score: 3, reasons: ["Lié à Ambient"])
		}
	}

	/// A stored pick of `candidates(_:)[index]`, so that it counts as seen when the same work is a candidate.
	private func stored(
		_ index: Int, on localDate: String, revision: Int = 1, type: NodeType = .project
	) throws -> DailyRecommendation {
		DailyRecommendation(
			recommendationID: UUID(), localDate: localDate, profileRevision: revision,
			nodeID: try identity("\(type.rawValue):project-\(index)"), nodeType: type, name: "Work \(index)",
			teaser: nil, reasons: ["Stocké"], viewRecorded: true)
	}

	private func catalog(
		_ nodes: [(String, String)] = [], _ edges: [(String, String, String)] = []
	) throws -> Catalog {
		let nodesJSON = nodes.map { identity, name -> [String: Any] in
			[
				"identity": identity, "type": String(identity.prefix { $0 != ":" }), "name": name,
				"teaser": NSNull(),
			]
		}
		let edgesJSON = edges.map { ["source": $0.0, "target": $0.1, "type": $0.2] }
		let payload: [String: Any] = [
			"version": "v1", "revision": revision, "taxonomy": ["mode": "degraded", "available": true],
			"nodes": nodesJSON, "edges": edgesJSON,
		]
		return try JSONDecoder().decode(Catalog.self, from: JSONSerialization.data(withJSONObject: payload))
	}

	private func plan(
		candidates: [AffinityCandidate], history: [DailyRecommendation] = [], revision: Int = 1,
		today: String = "2026-11-17", catalog: Catalog? = nil
	) throws -> [PlannedReminder] {
		ReminderPlan.plan(
			candidates: candidates, history: history, profile: profile(revision: revision),
			catalog: try catalog ?? self.catalog(), today: today, profileGenreNames: ["Ambient"], makeID: idMaker())
	}

	private func recommendation(_ type: NodeType, name: String, id: String) throws -> DailyRecommendation {
		DailyRecommendation(
			recommendationID: UUID(), localDate: "2026-11-18", profileRevision: 1, nodeID: try identity(id),
			nodeType: type, name: name, teaser: nil, reasons: [], viewRecorded: false)
	}

	// MARK: - plan

	func testConstantsMatchTheContract() {
		XCTAssertEqual(ReminderPlan.horizonDays, 7)
		XCTAssertEqual(ReminderPlan.hour, 9)
		XCTAssertEqual(ReminderPlan.title, "Ta recommandation du jour")
	}

	func testTheSameInputsGiveTheSamePlan() throws {
		let pool = try candidates(12)
		let history = [try stored(3, on: "2026-11-16")]
		XCTAssertEqual(try plan(candidates: pool, history: history), try plan(candidates: pool, history: history))
	}

	func testThePlanCoversTheSevenDaysAfterToday() throws {
		let reminders = try plan(candidates: try candidates(12))
		XCTAssertEqual(
			reminders.map(\.localDate),
			["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24"])
		XCTAssertTrue(reminders.allSatisfy { $0.hour == 9 && $0.title == "Ta recommandation du jour" })
		XCTAssertEqual(reminders.map(\.recommendation.localDate), reminders.map(\.localDate))
	}

	func testThePlanCrossesTheEndOfAMonthAndOfALeapFebruary() throws {
		XCTAssertEqual(
			try plan(candidates: try candidates(12), today: "2026-11-27").map(\.localDate),
			["2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"])
		XCTAssertEqual(
			try plan(candidates: try candidates(12), today: "2028-02-27").map(\.localDate),
			["2028-02-28", "2028-02-29", "2028-03-01", "2028-03-02", "2028-03-03", "2028-03-04", "2028-03-05"])
		XCTAssertEqual(
			try plan(candidates: try candidates(12), today: "2026-12-29").map(\.localDate),
			["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04", "2027-01-05"])
	}

	func testAnInvalidTodayPlansNothing() throws {
		let pool = try candidates(12)
		XCTAssertEqual(try plan(candidates: pool, today: "2026-02-30"), [])
		XCTAssertEqual(try plan(candidates: pool, today: "17/11/2026"), [])
		XCTAssertEqual(try plan(candidates: pool, today: ""), [])
	}

	func testNoWorkAppearsTwiceWhileUnseenCandidatesRemain() throws {
		let pool = try candidates(10)
		let history = [try stored(0, on: "2026-11-16"), try stored(1, on: "2026-11-17")]
		let reminders = try plan(candidates: pool, history: history)
		let planned = reminders.map(\.recommendation.nodeID)
		XCTAssertEqual(planned.count, 7)
		XCTAssertEqual(Set(planned).count, 7)
		XCTAssertTrue(Set(planned).isDisjoint(with: Set(history.map(\.nodeID))))
	}

	func testSevenCandidatesAreAllUsedOnceAndAShorterPoolIsRecycled() throws {
		let exact = try plan(candidates: try candidates(7))
		XCTAssertEqual(Set(exact.map(\.recommendation.nodeID)).count, 7)
		let recycled = try plan(candidates: try candidates(3))
		XCTAssertEqual(recycled.count, 7)
		XCTAssertEqual(Set(recycled.prefix(3).map(\.recommendation.nodeID)).count, 3)
	}

	func testAPlannedPickCarriesTheCandidateAndTheProfile() throws {
		let reminder = try XCTUnwrap(try plan(candidates: try candidates(12), revision: 4).first)
		let recommendation = reminder.recommendation
		XCTAssertEqual(recommendation.profileRevision, 4)
		XCTAssertEqual(recommendation.profileGenreNames, ["Ambient"])
		XCTAssertEqual(recommendation.reasons, ["Lié à Ambient"])
		XCTAssertEqual(recommendation.nodeType, .project)
		XCTAssertFalse(recommendation.viewRecorded)
		XCTAssertEqual(recommendation.recommendationID, UUID(uuidString: "00000000-0000-4000-8000-000000000001"))
	}

	func testAStoredEntryWithTheCurrentRevisionIsKeptAsIs() throws {
		let entry = try stored(99, on: "2026-11-19")
		let reminders = try plan(candidates: try candidates(12), history: [entry])
		XCTAssertEqual(reminders[1].recommendation, entry)
		XCTAssertEqual(reminders[1].body, "Album Work 99")
		XCTAssertEqual(reminders.count, 7)
		// Only the six other days draw an identifier.
		XCTAssertEqual(
			reminders.last?.recommendation.recommendationID, UUID(uuidString: "00000000-0000-4000-8000-000000000006"))
	}

	func testAStoredEntryFromAnotherRevisionIsRecomputed() throws {
		let entry = try stored(99, on: "2026-11-19", revision: 1)
		let reminders = try plan(candidates: try candidates(12), history: [entry], revision: 2)
		XCTAssertNotEqual(reminders[1].recommendation, entry)
		XCTAssertEqual(reminders[1].recommendation.profileRevision, 2)
		XCTAssertEqual(reminders[1].recommendation.localDate, "2026-11-19")
	}

	func testAStoredEntryThatIsNotAProjectOrATrackIsRecomputed() throws {
		// Entries written before TRA-713 may still be an artist: Today refuses to serve them, so the plan must too.
		let entry = try stored(5, on: "2026-11-19", type: .artist)
		let reminders = try plan(candidates: try candidates(12), history: [entry])
		XCTAssertNotEqual(reminders[1].recommendation, entry)
		XCTAssertEqual(reminders[1].recommendation.nodeType, .project)
	}

	func testWithoutCandidatesThereIsNoReminder() throws {
		XCTAssertEqual(try plan(candidates: []), [])
		XCTAssertEqual(try plan(candidates: [], history: [try stored(1, on: "2026-11-19")]), [])
	}

	func testTheBodyOfAReminderComesFromTheCatalog() throws {
		let pool = [
			AffinityCandidate(
				identity: try identity("project:selected-ambient-works"), type: .project,
				name: "Selected Ambient Works 85-92", teaser: nil, score: 3, reasons: [])
		]
		let catalog = try catalog(
			[("project:selected-ambient-works", "Selected Ambient Works 85-92"), ("artist:aphex-twin", "Aphex Twin")],
			[("project:selected-ambient-works", "artist:aphex-twin", "artists")])
		let reminders = try plan(candidates: pool, catalog: catalog)
		XCTAssertEqual(reminders.first?.body, "Aphex Twin, album Selected Ambient Works 85-92")
	}

	// MARK: - body

	private func bodyCatalog() throws -> Catalog {
		try catalog(
			[
				("project:saw", "Selected Ambient Works 85-92"), ("track:xtal", "Xtal"), ("track:lonely", "Lonely"),
				("artist:aphex-twin", "Aphex Twin"), ("artist:polygon-window", "Polygon Window"),
				("genre:ambient", "Ambient"),
			],
			[
				("project:saw", "artist:aphex-twin", "artists"),
				("track:xtal", "artist:aphex-twin", "artists"),
				("track:xtal", "artist:polygon-window", "artists"),
				("track:xtal", "artist:aphex-twin", "artists"),
				("track:xtal", "genre:ambient", "artists"),
				("track:xtal", "artist:polygon-window", "genres"),
				("project:saw", "track:xtal", "tracklist"),
			])
	}

	func testBodyOfAProjectWithAnArtist() throws {
		let work = try recommendation(.project, name: "Selected Ambient Works 85-92", id: "project:saw")
		XCTAssertEqual(
			ReminderPlan.body(for: work, catalog: try bodyCatalog()),
			"Aphex Twin, album Selected Ambient Works 85-92")
	}

	func testBodyOfATrackJoinsEachArtistOnceInEdgeOrder() throws {
		let work = try recommendation(.track, name: "Xtal", id: "track:xtal")
		// The repeated edge, the edge toward a genre and the edge of another type add nothing.
		XCTAssertEqual(
			ReminderPlan.body(for: work, catalog: try bodyCatalog()), "Aphex Twin, Polygon Window, morceau Xtal")
	}

	func testBodyWithoutArtistStartsWithTheCapitalisedKind() throws {
		let track = try recommendation(.track, name: "Lonely", id: "track:lonely")
		XCTAssertEqual(ReminderPlan.body(for: track, catalog: try bodyCatalog()), "Morceau Lonely")
		let project = try recommendation(.project, name: "Lonely", id: "project:unknown")
		XCTAssertEqual(ReminderPlan.body(for: project, catalog: try bodyCatalog()), "Album Lonely")
	}

	func testBodyCleansNetworkNamesWithoutInterpretingThem() throws {
		let catalog = try catalog(
			[("project:odd", "x"), ("artist:odd-artist", "  Odd\n\u{202E}Artist  ")],
			[("project:odd", "artist:odd-artist", "artists")])
		let work = try recommendation(.project, name: "A\t\u{202E}Name\nTwo", id: "project:odd")
		XCTAssertEqual(ReminderPlan.body(for: work, catalog: catalog), "Odd Artist, album A Name Two")
	}

	func testBodyIgnoresAnArtistEdgeThatPointsOutsideTheCatalog() throws {
		let catalog = try catalog([("project:saw", "x")], [("project:saw", "artist:ghost", "artists")])
		let work = try recommendation(.project, name: "Saw", id: "project:saw")
		XCTAssertEqual(ReminderPlan.body(for: work, catalog: catalog), "Album Saw")
	}

	func testBodyOfATypeThatIsNotRecommendedIsItsCleanedNameAlone() throws {
		let legacy = try recommendation(.artist, name: " Aphex\nTwin ", id: "artist:aphex-twin")
		XCTAssertEqual(ReminderPlan.body(for: legacy, catalog: try bodyCatalog()), "Aphex Twin")
	}

	func testBodyOfAWorkWhoseNameIsBlankFallsBackToTheKind() throws {
		let work = try recommendation(.project, name: " \n ", id: "project:saw")
		XCTAssertEqual(ReminderPlan.body(for: work, catalog: try bodyCatalog()), "Aphex Twin")
		let alone = try recommendation(.track, name: "\t", id: "track:lonely")
		XCTAssertEqual(ReminderPlan.body(for: alone, catalog: try bodyCatalog()), "Morceau")
	}
}
