import Foundation
import Track1Core

/// Keeps the last `historyLimit` daily recommendations in `daily-recommendation.v1.json`.
///
/// The history is derived data: an unreadable, corrupt or unsupported file reads as empty and is overwritten
/// by the next save instead of blocking the daily pick. Everything on disk is untrusted, so entries are
/// validated while decoding and an invalid one is dropped on its own.
actor DailyRecommendationStore {
	static let historyLimit = 40

	private static let fileName = "daily-recommendation.v1.json"
	private static let fileVersion = 1

	private let localStore: LocalStore
	private var shouldResetBeforeUse: Bool
	private var isLocked = false
	private var waiters: [CheckedContinuation<Void, Never>] = []

	init(localStore: LocalStore, resetBeforeUse: Bool = false) {
		self.localStore = localStore
		shouldResetBeforeUse = resetBeforeUse
	}

	/// The stored history, oldest first. Empty when the file cannot be read as a version 1 history, including
	/// when the read itself fails: the contract has no error channel here, unlike `markViewed`.
	func history() async -> [DailyRecommendation] {
		await acquire()
		defer { release() }
		await resetIfNeeded()
		if case .success(let history) = await load() { return history }
		return []
	}

	/// Replaces the history with the last `historyLimit` entries of `recommendations`. Nothing is written when
	/// an entry would not survive a reload, and a failed write leaves the previous file untouched
	/// (`LocalStore` writes atomically).
	func save(_ recommendations: [DailyRecommendation]) async -> Result<Void, LocalStoreError> {
		await acquire()
		defer { release() }
		await resetIfNeeded()
		guard recommendations.allSatisfy(\.isStorable) else { return .failure(.unavailable) }
		return await persist(Array(recommendations.suffix(Self.historyLimit)))
	}

	/// Marks the matching entry as viewed and leaves every other entry as it was. An unknown or already
	/// viewed identifier is a successful no-op.
	func markViewed(_ recommendationID: UUID) async -> Result<Void, LocalStoreError> {
		await acquire()
		defer { release() }
		await resetIfNeeded()
		switch await load() {
		case .failure(let error):
			return .failure(error)
		case .success(var history):
			guard let index = history.firstIndex(where: { $0.recommendationID == recommendationID }),
				!history[index].viewRecorded
			else { return .success(()) }
			history[index].viewRecorded = true
			return await persist(history)
		}
	}

	/// Every public method reads, awaits, then writes. Without this lock the actor would interleave two
	/// of them at the awaits and the later write would silently discard the earlier one.
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

	private func load() async -> Result<[DailyRecommendation], LocalStoreError> {
		switch await localStore.read(named: Self.fileName) {
		case .failure(let error): return .failure(error)
		case .success(nil): return .success([])
		case .success(let data?):
			guard let stored = try? JSONDecoder().decode(StoredHistory.self, from: data),
				stored.version == Self.fileVersion
			else { return .success([]) }
			let valid = stored.history.compactMap(\.recommendation).filter(\.isStorable)
			return .success(Array(valid.suffix(Self.historyLimit)))
		}
	}

	private func persist(_ history: [DailyRecommendation]) async -> Result<Void, LocalStoreError> {
		do {
			let encoder = JSONEncoder()
			encoder.outputFormatting = [.sortedKeys]
			let data = try encoder.encode(StoredHistory(version: Self.fileVersion, history: history))
			return await localStore.write(data, named: Self.fileName)
		} catch {
			return .failure(.unavailable)
		}
	}

	private func resetIfNeeded() async {
		guard shouldResetBeforeUse else { return }
		shouldResetBeforeUse = false
		_ = await localStore.remove(named: Self.fileName)
	}
}

/// On-disk shape. `history` entries decode one by one so a single bad record does not discard the others.
private struct StoredHistory: Codable {
	let version: Int
	let history: [Entry]

	init(version: Int, history: [DailyRecommendation]) {
		self.version = version
		self.history = history.map(Entry.init)
	}

	struct Entry: Codable {
		let recommendation: DailyRecommendation?

		init(_ recommendation: DailyRecommendation) {
			self.recommendation = recommendation
		}

		init(from decoder: Decoder) throws {
			recommendation = try? DailyRecommendation(from: decoder)
		}

		func encode(to encoder: Encoder) throws {
			try recommendation?.encode(to: encoder)
		}
	}
}

extension DailyRecommendation {
	/// The checks of `isRecommendation` in `mobile/src/recommendation/daily.ts` for the fields this record
	/// shares with it: a date shaped like `yyyy-MM-dd`, a positive profile revision and a recommendable node
	/// type. It also requires `nodeType` to agree with the prefix of `nodeID`, which the RN check does not.
	fileprivate var isStorable: Bool {
		Self.isLocalDate(localDate) && profileRevision > 0 && nodeID.type == nodeType
			&& (nodeType == .artist || nodeType == .project || nodeType == .track)
	}

	/// `yyyy-MM-dd` checked byte by byte: a regular expression's `$` also accepts a trailing newline.
	private static func isLocalDate(_ value: String) -> Bool {
		let digits = UInt8(ascii: "0")...UInt8(ascii: "9")
		let bytes = Array(value.utf8)
		guard bytes.count == 10 else { return false }
		return bytes.enumerated().allSatisfy { index, byte in
			index == 4 || index == 7 ? byte == UInt8(ascii: "-") : digits.contains(byte)
		}
	}
}
