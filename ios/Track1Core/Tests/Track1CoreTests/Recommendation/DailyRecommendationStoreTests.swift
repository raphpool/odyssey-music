import Foundation
import XCTest

@testable import Track1Core

final class DailyRecommendationStoreTests: XCTestCase {
	private static let fileName = "daily-recommendation.v1.json"
	private var directoryURL: URL!

	override func setUpWithError() throws {
		directoryURL = FileManager.default.temporaryDirectory.appending(
			path: UUID().uuidString,
			directoryHint: .isDirectory
		)
		try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
	}

	override func tearDownWithError() throws {
		try? FileManager.default.removeItem(at: directoryURL)
		directoryURL = nil
	}

	func testHistoryIsEmptyWithoutAFile() async {
		let history = await makeStore().history()
		XCTAssertEqual(history, [])
	}

	func testSavedHistoryIsIdenticalWhenReadByANewStore() async throws {
		let saved = try (1...3).map { try recommendation($0, teaser: $0 == 2 ? nil : "Teaser \($0)") }
		let result = await makeStore().save(saved)
		assertSucceeded(result)
		let reread = await makeStore().history()
		XCTAssertEqual(reread, saved)
	}

	func testTheFileUsesTheVersionedFormatWithoutRNOnlyFields() async throws {
		_ = await makeStore().save([try recommendation(1)])
		let data = try Data(contentsOf: directoryURL.appending(path: Self.fileName))
		let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		XCTAssertEqual(object["version"] as? Int, 1)
		let entries = try XCTUnwrap(object["history"] as? [[String: Any]])
		XCTAssertEqual(entries.count, 1)
		XCTAssertNil(entries[0]["view_event_id"])
		XCTAssertNotNil(entries[0]["recommendation_id"])
		XCTAssertTrue(entries[0]["teaser"] is NSNull)
		XCTAssertEqual(entries[0]["profile_genre_names"] as? [String], [])
	}

	func testGenreNamesAreWrittenUnderTheirKeyAndSurviveARoundTrip() async throws {
		let saved = [try recommendation(1, profileGenreNames: ["IDM", "Glitch", "Ambient"])]
		assertSucceeded(await makeStore().save(saved))
		let data = try Data(contentsOf: directoryURL.appending(path: Self.fileName))
		let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		let entries = try XCTUnwrap(object["history"] as? [[String: Any]])
		XCTAssertEqual(entries.first?["profile_genre_names"] as? [String], ["IDM", "Glitch", "Ambient"])

		let reread = await makeStore().history()
		XCTAssertEqual(reread, saved)
		XCTAssertEqual(reread.first?.profileGenreNames, ["IDM", "Glitch", "Ambient"])
	}

	func testSavingMoreThanFortyKeepsTheLastFortyInOrder() async throws {
		let saved = try (1...41).map { try recommendation($0) }
		let result = await makeStore().save(saved)
		assertSucceeded(result)
		let reread = await makeStore().history()
		XCTAssertEqual(reread.count, 40)
		XCTAssertEqual(reread, Array(saved.dropFirst()))
		XCTAssertFalse(reread.contains(saved[0]))
	}

	func testCorruptFileReadsAsEmptyAndTheNextSaveSucceeds() async throws {
		for corrupt in [
			"not json",
			"",
			#"{"version":2,"history":[]}"#,
			#"{"history":[]}"#,
			#"{"version":1}"#,
			#"{"version":1,"history":{}}"#,
			#"[]"#,
		] {
			try await writeRaw(corrupt)
			let store = makeStore()
			let history = await store.history()
			XCTAssertEqual(history, [], corrupt)
			let entry = try recommendation(1)
			let saveResult = await store.save([entry])
			assertSucceeded(saveResult, corrupt)
			let reread = await makeStore().history()
			XCTAssertEqual(reread, [entry], corrupt)
		}
	}

	func testFutureVersionIsNotMistakenForVersionOne() async throws {
		let valid = try recommendation(1)
		try await writeRaw(
			#"{"version":2,"history":[\#(try json(of: valid))]}"#)
		let history = await makeStore().history()
		XCTAssertEqual(history, [])
	}

	func testFailedWriteReportsUnavailableAndKeepsThePreviousHistory() async throws {
		let previous = try (1...3).map { try recommendation($0) }
		let seeded = await makeStore().save(previous)
		assertSucceeded(seeded)

		let failing = DailyRecommendationStore(
			localStore: LocalStore(directoryURL: directoryURL, failNextWriteNamed: Self.fileName)
		)
		let failed = await failing.save([try recommendation(9)])
		assertUnavailable(failed)
		let afterFailure = await failing.history()
		XCTAssertEqual(afterFailure, previous)
		let reread = await makeStore().history()
		XCTAssertEqual(reread, previous)

		let retried = await failing.save([try recommendation(9)])
		assertSucceeded(retried)
	}

	func testFailedMarkViewedKeepsThePreviousHistory() async throws {
		let previous = try (1...2).map { try recommendation($0) }
		_ = await makeStore().save(previous)
		let failing = DailyRecommendationStore(
			localStore: LocalStore(directoryURL: directoryURL, failNextWriteNamed: Self.fileName)
		)
		let failed = await failing.markViewed(previous[0].recommendationID)
		assertUnavailable(failed)
		let reread = await makeStore().history()
		XCTAssertEqual(reread, previous)
	}

	func testMarkViewedOnlyChangesTheTargetedEntry() async throws {
		let saved = try (1...3).map { try recommendation($0) }
		let store = makeStore()
		_ = await store.save(saved)
		let result = await store.markViewed(saved[1].recommendationID)
		assertSucceeded(result)

		var expected = saved
		expected[1].viewRecorded = true
		let reread = await makeStore().history()
		XCTAssertEqual(reread, expected)
		XCTAssertEqual(reread.map(\.viewRecorded), [false, true, false])
	}

	func testMarkViewedWithAnUnknownIdentifierChangesNothing() async throws {
		let saved = try (1...2).map { try recommendation($0) }
		let store = makeStore()
		_ = await store.save(saved)
		let result = await store.markViewed(UUID())
		assertSucceeded(result)
		let reread = await makeStore().history()
		XCTAssertEqual(reread, saved)
	}

	func testMarkViewedFailsWhenTheFileCannotBeRead() async throws {
		let notADirectory = directoryURL.appending(path: "not-a-directory")
		try Data().write(to: notADirectory)
		let store = DailyRecommendationStore(localStore: LocalStore(directoryURL: notADirectory))
		let result = await store.markViewed(UUID())
		assertUnavailable(result)
		let history = await store.history()
		XCTAssertEqual(history, [])
	}

	func testConcurrentMarkViewedCallsDoNotLoseUpdates() async throws {
		let saved = try (1...6).map { try recommendation($0) }
		let store = makeStore()
		_ = await store.save(saved)
		await withTaskGroup(of: Void.self) { group in
			for entry in saved {
				group.addTask { _ = await store.markViewed(entry.recommendationID) }
			}
		}
		let reread = await makeStore().history()
		XCTAssertEqual(reread.map(\.viewRecorded), Array(repeating: true, count: 6))
	}

	func testResetBeforeUseEmptiesTheHistoryOnFirstAccessOnly() async throws {
		_ = await makeStore().save([try recommendation(1)])
		let store = makeStore(resetBeforeUse: true)
		let afterReset = await store.history()
		XCTAssertEqual(afterReset, [])
		let kept = try recommendation(2)
		_ = await store.save([kept])
		let afterSave = await store.history()
		XCTAssertEqual(afterSave, [kept])
		let reread = await makeStore().history()
		XCTAssertEqual(reread, [kept])
	}

	func testResetBeforeUseRunsBeforeASave() async throws {
		_ = await makeStore().save([try recommendation(1)])
		let store = makeStore(resetBeforeUse: true)
		let kept = try recommendation(2)
		_ = await store.save([kept])
		let reread = await makeStore().history()
		XCTAssertEqual(reread, [kept])
	}

	// MARK: Decoding validation

	func testInvalidEntriesAreIgnoredAndValidOnesKept() async throws {
		let first = try recommendation(1)
		let last = try recommendation(2)
		let invalid = [
			try rawEntry(localDate: "2026-1-05"),
			try rawEntry(localDate: "2026/10/05"),
			try rawEntry(localDate: "2026-10-05\n"),
			try rawEntry(localDate: "20261005"),
			try rawEntry(localDate: "２０２６-10-05"),
			try rawEntry(localDate: ""),
			try rawEntry(profileRevision: "0"),
			try rawEntry(profileRevision: "-3"),
			try rawEntry(profileRevision: "1.5"),
			try rawEntry(profileRevision: #""1""#),
			try rawEntry(nodeType: "genre"),
			try rawEntry(nodeType: "label"),
			try rawEntry(nodeType: "festival"),
			try rawEntry(nodeID: "not-an-identity"),
			try rawEntry(nodeType: "artist", nodeID: "track:track-1"),
			try rawEntry(removing: "reasons"),
			try rawEntry(removing: "recommendation_id"),
			"null",
			"42",
			#""text""#,
		]
		let entries = ([try json(of: first)] + invalid + [try json(of: last)]).joined(separator: ",")
		try await writeRaw(#"{"version":1,"history":[\#(entries)]}"#)

		let history = await makeStore().history()
		XCTAssertEqual(history, [first, last])
	}

	func testAWellFormedRawEntryIsAccepted() async throws {
		try await writeRaw(#"{"version":1,"history":[\#(try rawEntry())]}"#)
		let history = await makeStore().history()
		XCTAssertEqual(history.count, 1)
		XCTAssertEqual(history.first?.localDate, "2026-10-05")
		XCTAssertEqual(history.first?.nodeType, .artist)
		// `rawEntry` has no `profile_genre_names`, like every file written before TRA-698: the entry must
		// still be read, with no names, or the whole history of an existing install would be dropped (R8).
		XCTAssertEqual(history.first?.profileGenreNames, [])
	}

	func testARawEntryWithGenreNamesKeepsThem() async throws {
		try await writeRaw(
			#"{"version":1,"history":[\#(try rawEntry(extra: #","profile_genre_names":["IDM","Ambient"]"#))]}"#)
		let history = await makeStore().history()
		XCTAssertEqual(history.first?.profileGenreNames, ["IDM", "Ambient"])
	}

	func testARawEntryWithMalformedGenreNamesIsIgnored() async throws {
		let valid = try recommendation(1)
		let malformed = try rawEntry(extra: #","profile_genre_names":"IDM""#)
		try await writeRaw(#"{"version":1,"history":[\#(malformed),\#(try json(of: valid))]}"#)
		let history = await makeStore().history()
		XCTAssertEqual(history, [valid])
	}

	func testEntriesWithAForeignViewEventIDAreReadButTheFieldIsNotWrittenBack() async throws {
		try await writeRaw(
			#"{"version":1,"history":[\#(try rawEntry(extra: #","view_event_id":"4f6c1ab2-0000-4000-8000-000000000000""#))]}"#
		)
		let store = makeStore()
		let history = await store.history()
		XCTAssertEqual(history.count, 1)
		_ = await store.markViewed(try XCTUnwrap(history.first).recommendationID)
		let text = try String(contentsOf: directoryURL.appending(path: Self.fileName), encoding: .utf8)
		XCTAssertFalse(text.contains("view_event_id"))
	}

	func testReadingAnOversizedFileKeepsTheLastFortyValidEntries() async throws {
		let entries = try (1...45).map { try recommendation($0) }
		let raw = try entries.map { try json(of: $0) }.joined(separator: ",")
		try await writeRaw(#"{"version":1,"history":[\#(raw)]}"#)
		let history = await makeStore().history()
		XCTAssertEqual(history, Array(entries.suffix(40)))
	}

	func testSaveRejectsAnInvalidEntryWithoutTouchingTheFile() async throws {
		let previous = [try recommendation(1)]
		_ = await makeStore().save(previous)
		let invalidDate = try recommendation(2, localDate: "2026-1-5")
		let invalidRevision = try recommendation(3, profileRevision: 0)
		for invalid in [invalidDate, invalidRevision] {
			let result = await makeStore().save([try recommendation(4), invalid])
			assertUnavailable(result)
		}
		let reread = await makeStore().history()
		XCTAssertEqual(reread, previous)
	}

	// MARK: Helpers

	// `Result<Void, _>` is not `Equatable`, so the two outcomes get their own assertions.
	private func assertSucceeded(
		_ result: Result<Void, LocalStoreError>,
		_ message: String = "",
		file: StaticString = #filePath,
		line: UInt = #line
	) {
		guard case .failure(let error) = result else { return }
		XCTFail("Expected success, got \(error). \(message)", file: file, line: line)
	}

	private func assertUnavailable(
		_ result: Result<Void, LocalStoreError>,
		file: StaticString = #filePath,
		line: UInt = #line
	) {
		guard case .failure(.unavailable) = result else {
			return XCTFail("Expected .failure(.unavailable), got \(result).", file: file, line: line)
		}
	}

	private func makeStore(resetBeforeUse: Bool = false) -> DailyRecommendationStore {
		DailyRecommendationStore(
			localStore: LocalStore(directoryURL: directoryURL),
			resetBeforeUse: resetBeforeUse
		)
	}

	private func writeRaw(_ text: String) async throws {
		let result = await LocalStore(directoryURL: directoryURL).write(Data(text.utf8), named: Self.fileName)
		guard case .success = result else { throw NSError(domain: "DailyRecommendationStoreTests", code: 1) }
	}

	private func identity(_ index: Int) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: "artist:artist-\(index)"))
	}

	private func recommendation(
		_ index: Int,
		teaser: String? = nil,
		localDate: String = "2026-10-05",
		profileRevision: Int = 1,
		profileGenreNames: [String] = []
	) throws -> DailyRecommendation {
		DailyRecommendation(
			recommendationID: UUID(),
			localDate: localDate,
			profileRevision: profileRevision,
			nodeID: try identity(index),
			nodeType: .artist,
			name: "Artist \(index)",
			teaser: teaser,
			reasons: ["Lié à Ambient"],
			profileGenreNames: profileGenreNames,
			viewRecorded: false
		)
	}

	private func json(of recommendation: DailyRecommendation) throws -> String {
		String(decoding: try JSONEncoder().encode(recommendation), as: UTF8.self)
	}

	/// One stored entry written by hand, so a single field can be made invalid.
	private func rawEntry(
		localDate: String = "2026-10-05",
		profileRevision: String = "1",
		nodeType: String = "artist",
		nodeID: String = "artist:artist-1",
		removing missingKey: String? = nil,
		extra: String = ""
	) throws -> String {
		var fields: [(String, String)] = [
			("recommendation_id", #""\#(UUID().uuidString)""#),
			("local_date", try quoted(localDate)),
			("profile_revision", profileRevision),
			("node_id", try quoted(nodeID)),
			("node_type", try quoted(nodeType)),
			("name", #""Artist 1""#),
			("teaser", "null"),
			("reasons", #"["Lié à Ambient"]"#),
			("view_recorded", "false"),
		]
		fields.removeAll { $0.0 == missingKey }
		return "{" + fields.map { #""\#($0.0)":\#($0.1)"# }.joined(separator: ",") + extra + "}"
	}

	private func quoted(_ value: String) throws -> String {
		String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
	}
}
