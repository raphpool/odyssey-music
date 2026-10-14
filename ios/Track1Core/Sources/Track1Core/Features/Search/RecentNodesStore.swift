import Foundation

/// A card the user opened, kept so the search sheet can offer it again while the query is empty.
public struct RecentNode: Codable, Equatable, Sendable {
	public let identity: NodeIdentity
	public let name: String
	public let type: NodeType

	public init(identity: NodeIdentity, name: String, type: NodeType) {
		self.identity = identity
		self.name = name
		self.type = type
	}

	/// What the sheet offers again once `node` has been read: its identity, name and type.
	public init(node: NodeDetail) {
		self.init(identity: node.id, name: node.name, type: node.type)
	}

	/// The name comes from the API and the file from disk, both untrusted: the type must agree with the
	/// identity prefix, and the name must be readable single-line text of bounded length.
	var isStorable: Bool {
		identity.type == type
			&& !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& name.utf16.count <= RecentNodesStore.maximumNameLength
			&& name.rangeOfCharacter(from: .controlCharacters) == nil
	}
}

/// Keeps the last `limit` opened cards, most recent first, in `recent-nodes.v1.json`.
///
/// The list is a convenience, not a source of truth: an unreadable, corrupt or unsupported file reads as
/// empty and is overwritten by the next `record`. Entries are validated while decoding and an invalid one
/// is dropped on its own. There is no error channel: a failed write only loses a shortcut.
public actor RecentNodesStore {
	public static let limit = 10
	static let maximumNameLength = 200

	private static let fileName = "recent-nodes.v1.json"
	private static let fileVersion = 1

	private let localStore: LocalStore
	private var resetPending: Bool
	private var isLocked = false
	private var waiters: [CheckedContinuation<Void, Never>] = []

	/// `resetBeforeUse` (the UI tests' reset) empties the file inside the first call, under the lock, so that
	/// no `list` or `record` can run before it.
	public init(store: LocalStore, resetBeforeUse: Bool = false) {
		localStore = store
		resetPending = resetBeforeUse
	}

	/// Puts `node` first, removing any earlier entry with the same identity, and keeps `limit` entries.
	/// A node that would not survive a reload is ignored.
	public func record(_ node: RecentNode) async {
		await acquire()
		defer { release() }
		await applyPendingReset()
		guard node.isStorable else { return }
		var entries = await load().filter { $0.identity != node.identity }
		entries.insert(node, at: 0)
		await persist(Array(entries.prefix(Self.limit)))
	}

	public func list() async -> [RecentNode] {
		await acquire()
		defer { release() }
		await applyPendingReset()
		return await load()
	}

	public func clear() async {
		await acquire()
		defer { release() }
		resetPending = false
		_ = await localStore.remove(named: Self.fileName)
	}

	private func applyPendingReset() async {
		guard resetPending else { return }
		resetPending = false
		_ = await localStore.remove(named: Self.fileName)
	}

	/// `record` reads, awaits, then writes. Without this lock the actor would interleave two of them at the
	/// awaits and the later write would silently discard the earlier one.
	private func acquire() async {
		if isLocked {
			await withCheckedContinuation { waiters.append($0) }
		} else {
			isLocked = true
		}
	}

	/// Hands the lock straight to the next waiter so a newcomer cannot overtake it.
	private func release() {
		if waiters.isEmpty {
			isLocked = false
		} else {
			waiters.removeFirst().resume()
		}
	}

	private func load() async -> [RecentNode] {
		guard case .success(let data?) = await localStore.read(named: Self.fileName),
			let stored = try? JSONDecoder().decode(StoredRecents.self, from: data),
			stored.version == Self.fileVersion
		else { return [] }
		var seen = Set<NodeIdentity>()
		let valid = stored.recents.compactMap(\.node).filter { $0.isStorable && seen.insert($0.identity).inserted }
		return Array(valid.prefix(Self.limit))
	}

	private func persist(_ entries: [RecentNode]) async {
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys]
		guard let data = try? encoder.encode(StoredRecents(version: Self.fileVersion, recents: entries))
		else { return }
		_ = await localStore.write(data, named: Self.fileName)
	}
}

/// On-disk shape. Entries decode one by one so a single bad record does not discard the others.
private struct StoredRecents: Codable {
	let version: Int
	let recents: [Entry]

	init(version: Int, recents: [RecentNode]) {
		self.version = version
		self.recents = recents.map(Entry.init)
	}

	struct Entry: Codable {
		let node: RecentNode?

		init(_ node: RecentNode) {
			self.node = node
		}

		init(from decoder: Decoder) throws {
			node = try? RecentNode(from: decoder)
		}

		func encode(to encoder: Encoder) throws {
			try node?.encode(to: encoder)
		}
	}
}
