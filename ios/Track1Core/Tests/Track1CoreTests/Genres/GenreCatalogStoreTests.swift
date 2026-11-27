import XCTest

@testable import Track1Core

final class GenreCatalogStoreTests: XCTestCase {
	private static let fileName = "genre-catalog.v1.json"

	private var directoryURL: URL!
	private var localStore: LocalStore!

	override func setUpWithError() throws {
		directoryURL = FileManager.default.temporaryDirectory.appending(
			path: UUID().uuidString, directoryHint: .isDirectory)
		try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
		localStore = LocalStore(directoryURL: directoryURL)
	}

	override func tearDownWithError() throws {
		try? FileManager.default.removeItem(at: directoryURL)
		localStore = nil
		directoryURL = nil
	}

	// MARK: - load()

	func testLoadOnAnEmptyDirectoryDownloadsReducesAndStoresTheSnapshot() async throws {
		let full = try Self.catalog()
		let probe = CatalogProbe(.success(full, etag: "e1"))

		let load = await makeStore(probe).load()

		guard case .ready(let snapshot, let source) = load else { return XCTFail("Expected a ready snapshot.") }
		XCTAssertEqual(source, .network)
		let calls = await probe.requestedETags
		XCTAssertEqual(calls, [nil], "One download, without an ETag.")
		XCTAssertEqual(snapshot.etag, "e1")
		XCTAssertEqual(
			snapshot.catalog.nodes.map(\.identity.rawValue), ["genre:house", "genre:techno", "genre:ambient"],
			"Only the genre nodes, in served order.")
		XCTAssertTrue(snapshot.catalog.edges.isEmpty)
		XCTAssertEqual(snapshot.catalog.revision, full.revision)
		XCTAssertEqual(snapshot.catalog.taxonomy, full.taxonomy)
		XCTAssertNotNil(snapshot.taxonomy)
		XCTAssertEqual(snapshot.genreIDs.map(\.rawValue), ["genre:house", "genre:techno", "genre:ambient"])
		let stored = try await localStore.read(named: Self.fileName).get()
		XCTAssertNotNil(stored, "The snapshot is written to `genre-catalog.v1.json`.")
	}

	func testLoadServesTheStoredSnapshotWithoutTheNetwork() async throws {
		let full = try Self.catalog()
		let first = await makeStore(CatalogProbe(.success(full, etag: "e1"))).load()
		guard case .ready(let downloaded, _) = first else { return XCTFail("Expected a ready snapshot.") }
		let probe = CatalogProbe(.failure(.network))

		let second = await makeStore(probe).load()

		guard case .ready(let snapshot, let source) = second else { return XCTFail("Expected a ready snapshot.") }
		XCTAssertEqual(source, .disk)
		XCTAssertEqual(snapshot, downloaded)
		let calls = await probe.requestedETags
		XCTAssertEqual(calls, [])
	}

	func testUnusableFilesAreTreatedAsAbsent() async throws {
		let validBytes = try await seed(try Self.catalog(), etag: "e1")
		let valid = String(decoding: validBytes, as: UTF8.self)
		let futureVersion = valid.replacingOccurrences(of: "\"version\":1}", with: "\"version\":2}")
		XCTAssertNotEqual(futureVersion, valid, "The fixture must really change the wrapper version.")
		let degradedCatalog = String(
			decoding: try JSONEncoder().encode(try Self.catalog(taxonomy: .degraded(available: true))), as: UTF8.self)
		let files: [(String, String)] = [
			("corrupt", "{"),
			("version 2", futureVersion),
			("degraded taxonomy", "{\"catalog\":\(degradedCatalog),\"etag\":\"e0\",\"version\":1}"),
		]

		for (label, contents) in files {
			if case .failure = await localStore.write(Data(contents.utf8), named: Self.fileName) {
				return XCTFail("Could not write the \(label) fixture.")
			}
			let probe = CatalogProbe(.success(try Self.catalog(), etag: "e2"))

			let load = await makeStore(probe).load()

			guard case .ready(_, let source) = load else { return XCTFail("\(label): expected a ready snapshot.") }
			XCTAssertEqual(source, .network, label)
			let calls = await probe.requestedETags
			XCTAssertEqual(calls, [nil], label)
		}
	}

	func testLoadWithoutSnapshotIsUnavailableAndWritesNothingWhenTheDownloadIsUnusable() async throws {
		let results: [APIResult<Catalog>] = [
			.failure(.network),
			.success(try Self.catalog(taxonomy: .degraded(available: true)), etag: "e1"),
			.notModified(etag: "e1"),
		]

		for result in results {
			let load = await makeStore(CatalogProbe(result)).load()

			guard case .unavailable = load else { return XCTFail("Expected an unavailable load.") }
			let stored = try await localStore.read(named: Self.fileName).get()
			XCTAssertNil(stored, "A download that cannot serve the tab is never stored.")
		}
	}

	func testConcurrentLoadsShareOneDownload() async throws {
		let probe = CatalogProbe(.success(try Self.catalog(), etag: "e1"), hold: true)
		let store = makeStore(probe)

		let first = Task { await store.load() }
		let second = Task { await store.load() }
		await Self.waitUntil { await probe.requestedETags.count == 1 }
		// Gives the second call time to join the download in flight; it is not observable from outside.
		try await Task.sleep(nanoseconds: 100_000_000)
		await probe.release()
		let loads = [await first.value, await second.value]

		let calls = await probe.requestedETags
		XCTAssertEqual(calls.count, 1)
		for load in loads {
			guard case .ready(_, let source) = load else { return XCTFail("Expected a ready snapshot.") }
			XCTAssertEqual(source, .network)
		}
	}

	func testAFailedWriteStillServesTheDownloadButStoresNothing() async throws {
		let failing = LocalStore(directoryURL: directoryURL, failNextWriteNamed: Self.fileName)
		let probe = CatalogProbe(.success(try Self.catalog(), etag: "e1"))
		let store = GenreCatalogStore(localStore: failing, readCatalog: { await probe.read(etag: $0) })

		let first = await store.load()
		let second = await store.load()

		guard case .ready(_, let firstSource) = first, case .ready(_, let secondSource) = second else {
			return XCTFail("Expected two ready snapshots.")
		}
		XCTAssertEqual(firstSource, .network)
		XCTAssertEqual(secondSource, .network, "Nothing was written, so the second load downloads again.")
		let calls = await probe.requestedETags
		XCTAssertEqual(calls.count, 2)
	}

	func testResetBeforeUseDropsTheStoredFileOnFirstUse() async throws {
		_ = try await seed(try Self.catalog(), etag: "e1")
		let probe = CatalogProbe(.success(try Self.catalog(), etag: "e2"))

		let store = makeStore(probe, resetBeforeUse: true)
		let first = await store.load()
		let second = await store.load()

		guard case .ready(let snapshot, let firstSource) = first, case .ready(_, let secondSource) = second else {
			return XCTFail("Expected two ready snapshots.")
		}
		XCTAssertEqual(firstSource, .network, "The file left by an earlier run is not read.")
		XCTAssertEqual(snapshot.etag, "e2")
		XCTAssertEqual(secondSource, .disk, "The reset happens once: the snapshot written since is kept.")
		let calls = await probe.requestedETags
		XCTAssertEqual(calls.count, 1)
	}

	// MARK: - Helpers

	private func makeStore(_ probe: CatalogProbe, resetBeforeUse: Bool = false) -> GenreCatalogStore {
		GenreCatalogStore(
			localStore: localStore, readCatalog: { etag in await probe.read(etag: etag) },
			resetBeforeUse: resetBeforeUse)
	}

	/// Stores `catalog` through a store of its own and returns the bytes it wrote.
	private func seed(_ catalog: Catalog, etag: String?) async throws -> Data {
		let seeding = makeStore(CatalogProbe(.success(catalog, etag: etag)))
		guard case .ready(_, .network) = await seeding.load() else { throw SeedFailure() }
		let bytes = try await localStore.read(named: Self.fileName).get()
		return try XCTUnwrap(bytes)
	}

	private struct SeedFailure: Error {}

	/// A full catalog: editorial taxonomy over three genre nodes, plus an artist and an edge that the snapshot
	/// must drop.
	private static func catalog(taxonomy: CatalogTaxonomy? = nil) throws -> Catalog {
		let editorial = try EditorialFixture.catalog(
			nodes: [
				("genre:house", "House"), ("artist:massive-attack", "Massive Attack"), ("genre:techno", "Techno"),
				("genre:ambient", "Ambient"),
			],
			edges: [("artist:massive-attack", "genre:house", "genre")],
			teasers: ["genre:house": "Four on the floor."],
			families: [(key: "electronic", label: "Electronic", order: 1)],
			genres: [
				(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house"]),
				(id: "Q11399", name: "Techno", family: "electronic", slugs: ["genre:techno"]),
				(id: "Q8071", name: "Ambient", family: "electronic", slugs: ["genre:ambient"]),
			],
			legacy: ["genre:house": ["Q10413"]]
		)
		return Catalog(
			version: editorial.version, revision: editorial.revision,
			taxonomy: taxonomy ?? editorial.taxonomy, nodes: editorial.nodes, edges: editorial.edges)
	}

	private static func waitUntil(
		_ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line
	) async {
		for _ in 0..<400 {
			if await condition() { return }
			try? await Task.sleep(nanoseconds: 5_000_000)
		}
		XCTFail("The awaited condition never became true.", file: file, line: line)
	}
}

/// Stands in for the network: counts the requests, records the ETag of each, and can hold its answer.
private actor CatalogProbe {
	private(set) var requestedETags = [String?]()
	private let response: APIResult<Catalog>
	private let hold: Bool
	private var gate: CheckedContinuation<Void, Never>?

	init(_ response: APIResult<Catalog>, hold: Bool = false) {
		self.response = response
		self.hold = hold
	}

	func read(etag: String?) async -> APIResult<Catalog> {
		requestedETags.append(etag)
		if hold { await withCheckedContinuation { gate = $0 } }
		return response
	}

	func release() {
		gate?.resume()
		gate = nil
	}
}
