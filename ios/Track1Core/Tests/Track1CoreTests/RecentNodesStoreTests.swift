import Foundation
import XCTest

@testable import Track1Core

final class RecentNodesStoreTests: XCTestCase {
	private static let fileName = "recent-nodes.v1.json"
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

	func testListIsEmptyWithoutAFile() async {
		let list = await makeStore().list()
		XCTAssertEqual(list, [])
	}

	func testTwelveRecordsKeepTheLastTenMostRecentFirst() async throws {
		let store = makeStore()
		let nodes = try (1...12).map { try node($0) }
		for node in nodes { await store.record(node) }

		let list = await store.list()
		XCTAssertEqual(list, Array(nodes.suffix(10).reversed()))
		XCTAssertFalse(list.contains(nodes[0]))
		XCTAssertFalse(list.contains(nodes[1]))
	}

	func testRecordingAnIdentityAlreadyPresentMovesItFirstWithoutDuplicate() async throws {
		let store = makeStore()
		let nodes = try (1...3).map { try node($0) }
		for node in nodes { await store.record(node) }
		let renamed = RecentNode(identity: nodes[0].identity, name: "Renamed", type: .artist)
		await store.record(renamed)

		let list = await store.list()
		XCTAssertEqual(list, [renamed, nodes[2], nodes[1]])
	}

	func testANewStoreOnTheSameDirectoryRereadsTheListAndClearEmptiesIt() async throws {
		let nodes = try (1...3).map { try node($0) }
		let first = makeStore()
		for node in nodes { await first.record(node) }

		let second = makeStore()
		let reread = await second.list()
		XCTAssertEqual(reread, Array(nodes.reversed()))

		let cleared = await second.clear()
		XCTAssertEqual(cleared, .cleared)
		let afterClear = await second.list()
		XCTAssertEqual(afterClear, [])
		let fromThird = await makeStore().list()
		XCTAssertEqual(fromThird, [])
		XCTAssertFalse(FileManager.default.fileExists(atPath: directoryURL.appending(path: Self.fileName).path))
	}

	func testClearWithoutAFileIsANoOp() async {
		let store = makeStore()
		let cleared = await store.clear()
		XCTAssertEqual(cleared, .cleared)
		let list = await store.list()
		XCTAssertEqual(list, [])
	}

	/// TRA-444: `clear()` used to ignore the result of `LocalStore.remove`, so "Effacer le profil" could
	/// report nothing while the recents stayed on the device.
	func testClearReportsAFailureWhenTheStorageRefusesTheRemoval() async throws {
		let kept = try node(1)
		await makeStore().record(kept)

		let refusing = RecentNodesStore(
			store: LocalStore(directoryURL: directoryURL, fileManager: RemovalRefusingFileManager()))
		let cleared = await refusing.clear()
		XCTAssertEqual(cleared, .unavailable)

		let list = await makeStore().list()
		XCTAssertEqual(list, [kept], "The refused removal leaves the recents where they were.")
	}

	func testTheFileUsesTheVersionedFormat() async throws {
		await makeStore().record(try node(1))
		let data = try Data(contentsOf: directoryURL.appending(path: Self.fileName))
		let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		XCTAssertEqual(object["version"] as? Int, 1)
		let entries = try XCTUnwrap(object["recents"] as? [[String: Any]])
		XCTAssertEqual(entries.count, 1)
		XCTAssertEqual(entries[0]["identity"] as? String, "artist:artist-1")
		XCTAssertEqual(entries[0]["name"] as? String, "Artist 1")
		XCTAssertEqual(entries[0]["type"] as? String, "artist")
	}

	func testNodesThatWouldNotSurviveAReloadAreIgnored() async throws {
		let store = makeStore()
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "artist:miles-davis"))
		await store.record(RecentNode(identity: identity, name: "Miles", type: .track))
		await store.record(RecentNode(identity: identity, name: "  \n ", type: .artist))
		await store.record(RecentNode(identity: identity, name: "Two\nlines", type: .artist))
		await store.record(
			RecentNode(
				identity: identity, name: String(repeating: "a", count: RecentNodesStore.maximumNameLength + 1),
				type: .artist))
		let list = await store.list()
		XCTAssertEqual(list, [])
		XCTAssertFalse(FileManager.default.fileExists(atPath: directoryURL.appending(path: Self.fileName).path))
	}

	func testCorruptOrUnsupportedFilesReadAsEmptyAndTheNextRecordOverwritesThem() async throws {
		let fileURL = directoryURL.appending(path: Self.fileName)
		for corrupt in [
			"not json", "[]", "{\"version\":2,\"recents\":[]}", "{\"version\":1}",
			"{\"version\":1,\"recents\":\"x\"}",
		] {
			try Data(corrupt.utf8).write(to: fileURL)
			let store = makeStore()
			let before = await store.list()
			XCTAssertEqual(before, [], corrupt)

			let recorded = try node(1)
			await store.record(recorded)
			let after = await makeStore().list()
			XCTAssertEqual(after, [recorded], corrupt)
		}
	}

	func testAnInvalidEntryOnDiskIsDroppedAloneAndDuplicatesCollapse() async throws {
		let json = """
			{"version":1,"recents":[
			{"identity":"artist:a","name":"A","type":"artist"},
			{"identity":"not an identity","name":"B","type":"artist"},
			{"identity":"track:c","name":"C","type":"artist"},
			{"identity":"genre:d","name":"","type":"genre"},
			{"identity":"artist:a","name":"A again","type":"artist"},
			{"identity":"label:e","name":"E","type":"label"},
			42]}
			"""
		try Data(json.utf8).write(to: directoryURL.appending(path: Self.fileName))

		let list = await makeStore().list()
		XCTAssertEqual(
			list.map(\.identity.rawValue), ["artist:a", "label:e"])
		XCTAssertEqual(list.map(\.name), ["A", "E"])
	}

	func testMoreThanTenEntriesOnDiskAreTruncatedWhenRead() async throws {
		let entries = (1...14).map { "{\"identity\":\"artist:a\($0)\",\"name\":\"A\($0)\",\"type\":\"artist\"}" }
		let json = "{\"version\":1,\"recents\":[\(entries.joined(separator: ","))]}"
		try Data(json.utf8).write(to: directoryURL.appending(path: Self.fileName))

		let list = await makeStore().list()
		XCTAssertEqual(list.count, 10)
		XCTAssertEqual(list.first?.identity.rawValue, "artist:a1")
	}

	func testConcurrentRecordsAreAllKept() async throws {
		let store = makeStore()
		let nodes = try (1...8).map { try node($0) }
		await withTaskGroup(of: Void.self) { group in
			for node in nodes { group.addTask { await store.record(node) } }
		}
		let list = await store.list()
		XCTAssertEqual(Set(list.map(\.identity)), Set(nodes.map(\.identity)))
		XCTAssertEqual(list.count, 8)
	}

	func testAFailingWriteKeepsThePreviousListAndDoesNotThrow() async throws {
		let first = try node(1)
		await makeStore().record(first)

		let failing = RecentNodesStore(
			store: LocalStore(directoryURL: directoryURL, failNextWriteNamed: Self.fileName))
		await failing.record(try node(2))
		let list = await failing.list()
		XCTAssertEqual(list, [first])
	}

	func testResetBeforeUseEmptiesTheFileBeforeTheFirstCallWhateverItIs() async throws {
		let previous = makeStore()
		await previous.record(try node(1))

		let reset = RecentNodesStore(store: LocalStore(directoryURL: directoryURL), resetBeforeUse: true)
		// `record` is the first call: the old list must be gone, not merged with the new entry.
		await reset.record(try node(2))
		let afterRecord = await reset.list()
		XCTAssertEqual(afterRecord, [try node(2)])

		// The reset happens once: a later record is kept by a store that has already reset.
		await reset.record(try node(3))
		let afterSecond = await reset.list()
		XCTAssertEqual(afterSecond, [try node(3), try node(2)])

		let again = RecentNodesStore(store: LocalStore(directoryURL: directoryURL), resetBeforeUse: true)
		let first = await again.list()
		XCTAssertEqual(first, [], "A reset store reads empty as its very first call.")
	}

	/// A file system that lists and reads like the real one but refuses to delete.
	private final class RemovalRefusingFileManager: FileManager, @unchecked Sendable {
		override func removeItem(at URL: URL) throws {
			throw CocoaError(.fileWriteNoPermission)
		}
	}

	private func makeStore() -> RecentNodesStore {
		RecentNodesStore(store: LocalStore(directoryURL: directoryURL))
	}

	private func node(_ number: Int) throws -> RecentNode {
		RecentNode(
			identity: try XCTUnwrap(NodeIdentity(rawValue: "artist:artist-\(number)")),
			name: "Artist \(number)",
			type: .artist
		)
	}
}
