import Foundation

/// What the Genres tab keeps on disk. 2026-11-25: the tab downloaded the whole mobile catalog (1 600 nodes,
/// edges, taxonomy) on every launch and showed a spinner for seconds, while it only needs the editorial
/// taxonomy and the ~316 `genre` nodes (plan D1).
public struct GenreCatalogSnapshot: Codable, Equatable, Sendable {
	public let etag: String?
	/// Same version, revision and taxonomy as the catalog it derives from; only its `type == .genre` nodes,
	/// in served order; no edges. `EditorialGenreTaxonomy(catalog:)` is never nil on a stored snapshot.
	public let catalog: Catalog

	public var taxonomy: EditorialGenreTaxonomy? { EditorialGenreTaxonomy(catalog: catalog) }

	public var genreIDs: [NodeIdentity] { catalog.nodes.filter { $0.type == .genre }.map(\.identity) }
}

public enum GenreCatalogSource: Equatable, Sendable {
	case disk
	case network
}

public enum GenreCatalogLoad: Sendable {
	case ready(GenreCatalogSnapshot, source: GenreCatalogSource)
	case unavailable
}

public enum GenreCatalogRefresh: Equatable, Sendable {
	case updated
	case unchanged
	case failed
}

/// Keeps a genre-only snapshot of the catalog in `genre-catalog.v1.json`, serves it without the network and
/// revalidates it by ETag (plan D2, D3).
///
/// The file is derived data: anything unreadable, of another version or without an editorial taxonomy reads
/// as absent and is overwritten by the next successful download. Everything on disk is untrusted, so the
/// catalog goes through its validating decoder again on every read.
public actor GenreCatalogStore {
	private static let fileName = "genre-catalog.v1.json"
	private static let fileVersion = 1

	// Computed: `JSONDecoder` and `JSONEncoder` are not `Sendable`, so Swift 6 refuses them as `static let`.
	private static var decoder: JSONDecoder { JSONDecoder() }

	/// Sorted keys give the same bytes for the same snapshot, so "unchanged" can be checked byte for byte.
	private static var encoder: JSONEncoder {
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys]
		return encoder
	}

	private let localStore: LocalStore
	private let readCatalog: @Sendable (_ etag: String?) async -> APIResult<Catalog>
	private var shouldResetBeforeUse: Bool
	/// Shared by concurrent `load()` calls: while a cold load is running, the others await it instead of
	/// starting a second download (plan D3).
	private var inFlightLoad: Task<GenreCatalogLoad, Never>?

	public init(
		localStore: LocalStore,
		readCatalog: @escaping @Sendable (_ etag: String?) async -> APIResult<Catalog>,
		resetBeforeUse: Bool = false
	) {
		self.localStore = localStore
		self.readCatalog = readCatalog
		shouldResetBeforeUse = resetBeforeUse
	}

	/// The stored snapshot when there is a usable one, without any request; otherwise a download of the full
	/// catalog (no ETag), reduced to its genres and stored. A download that cannot be stored still serves.
	public func load() async -> GenreCatalogLoad {
		if let inFlightLoad { return await inFlightLoad.value }
		let task = Task { await self.performLoad() }
		inFlightLoad = task
		let result = await task.value
		inFlightLoad = nil
		return result
	}

	/// Revalidates the stored snapshot with its ETag and replaces it when the server has another revision.
	/// The file is left untouched in every other case, so a failed refresh never costs the snapshot.
	public func refresh() async -> GenreCatalogRefresh {
		await resetIfNeeded()
		let stored = await storedSnapshot()
		switch await readCatalog(stored?.etag) {
		case .failure:
			return .failed
		case .notModified:
			// A 304 answers an ETag that was sent; with no snapshot there is nothing it could confirm.
			return stored == nil ? .failed : .unchanged
		case .success(let catalog, let etag):
			guard let fresh = Self.snapshot(from: catalog, etag: etag) else { return .failed }
			// Read again: `load()` or `remember` may have stored a snapshot while the request was in flight.
			if await storedSnapshot()?.catalog.revision == fresh.catalog.revision { return .unchanged }
			// `.updated` promises that `load()` now serves the new revision, so a failed write is `.failed`.
			return await write(fresh) ? .updated : .failed
		}
	}

	/// Stores the genre subset of a catalog another reader already downloaded. A catalog without an editorial
	/// taxonomy changes nothing: an existing snapshot stays.
	public func remember(_ catalog: Catalog, etag: String?) async {
		await resetIfNeeded()
		guard let snapshot = Self.snapshot(from: catalog, etag: etag) else { return }
		_ = await write(snapshot)
	}

	/// Wraps a catalog reader so that every successful read also feeds the snapshot. The result is returned
	/// as is, `.failure` and `.notModified` included, after `remember` has finished.
	public nonisolated func remembering(
		_ read: @escaping @Sendable () async -> APIResult<Catalog>
	) -> @Sendable () async -> APIResult<Catalog> {
		{ [self] in
			let result = await read()
			if case .success(let catalog, let etag) = result { await self.remember(catalog, etag: etag) }
			return result
		}
	}

	private func performLoad() async -> GenreCatalogLoad {
		await resetIfNeeded()
		if let snapshot = await storedSnapshot() { return .ready(snapshot, source: .disk) }
		guard case .success(let catalog, let etag) = await readCatalog(nil),
			let snapshot = Self.snapshot(from: catalog, etag: etag)
		else { return .unavailable }
		_ = await write(snapshot)
		return .ready(snapshot, source: .network)
	}

	/// The genre subset of `catalog`, or nil when its taxonomy is not editorial (or shows no genre): such a
	/// catalog cannot serve the tab, so it is never stored.
	private static func snapshot(from catalog: Catalog, etag: String?) -> GenreCatalogSnapshot? {
		let reduced = Catalog(
			version: catalog.version, revision: catalog.revision, taxonomy: catalog.taxonomy,
			nodes: catalog.nodes.filter { $0.type == .genre }, edges: [])
		let snapshot = GenreCatalogSnapshot(etag: etag, catalog: reduced)
		return snapshot.taxonomy == nil ? nil : snapshot
	}

	private func storedSnapshot() async -> GenreCatalogSnapshot? {
		guard case .success(let data?) = await localStore.read(named: Self.fileName),
			let stored = try? Self.decoder.decode(StoredGenreCatalog.self, from: data),
			stored.version == Self.fileVersion
		else { return nil }
		let snapshot = GenreCatalogSnapshot(etag: stored.etag, catalog: stored.catalog)
		return snapshot.taxonomy == nil ? nil : snapshot
	}

	private func write(_ snapshot: GenreCatalogSnapshot) async -> Bool {
		guard
			let data = try? Self.encoder.encode(
				StoredGenreCatalog(version: Self.fileVersion, etag: snapshot.etag, catalog: snapshot.catalog))
		else { return false }
		if case .success = await localStore.write(data, named: Self.fileName) { return true }
		return false
	}

	private func resetIfNeeded() async {
		guard shouldResetBeforeUse else { return }
		shouldResetBeforeUse = false
		_ = await localStore.remove(named: Self.fileName)
	}
}

/// On-disk shape of `genre-catalog.v1.json`.
private struct StoredGenreCatalog: Codable {
	let version: Int
	let etag: String?
	let catalog: Catalog
}
