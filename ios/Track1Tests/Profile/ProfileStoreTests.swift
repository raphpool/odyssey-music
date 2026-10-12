import Foundation
import XCTest

@testable import Track1

final class ProfileStoreTests: XCTestCase {
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

	func testThreeGenreThresholdAndSmallCatalogExceptions() async throws {
		let store = makeStore()
		let initial = try await initialDraft(from: store)
		let threeGenres = genres(3)
		let incomplete = ProfileDraft(
			version: Profile.version,
			flowID: initial.flowID,
			genreIDs: Array(threeGenres.prefix(2)),
			onboardingStartedRecorded: false
		)
		let incompleteResult = await store.commit(incomplete, availableGenreIDs: threeGenres)
		XCTAssertEqual(incompleteResult, .invalid)

		let complete = ProfileDraft(
			version: Profile.version,
			flowID: initial.flowID,
			genreIDs: threeGenres,
			onboardingStartedRecorded: false
		)
		guard case .saved(let profile) = await store.commit(complete, availableGenreIDs: threeGenres) else {
			return XCTFail("Expected a saved profile.")
		}
		XCTAssertEqual(profile.revision, 1)

		let oneGenreStore = makeStore(suffix: "one")
		let oneDraft = try await initialDraft(from: oneGenreStore)
		let oneGenre = genres(1)
		let oneSelection = ProfileDraft(
			version: Profile.version,
			flowID: oneDraft.flowID,
			genreIDs: oneGenre,
			onboardingStartedRecorded: false
		)
		let oneGenreResult = await oneGenreStore.commit(oneSelection, availableGenreIDs: oneGenre)
		XCTAssertNotEqual(oneGenreResult, .invalid)

		let twoGenreStore = makeStore(suffix: "two")
		let twoDraft = try await initialDraft(from: twoGenreStore)
		let twoGenres = genres(2)
		let incompleteSmallCatalog = ProfileDraft(
			version: Profile.version,
			flowID: twoDraft.flowID,
			genreIDs: [twoGenres[0]],
			onboardingStartedRecorded: false
		)
		let incompleteSmallCatalogResult = await twoGenreStore.commit(
			incompleteSmallCatalog,
			availableGenreIDs: twoGenres
		)
		XCTAssertEqual(incompleteSmallCatalogResult, .invalid)
		let fullSmallCatalog = ProfileDraft(
			version: Profile.version,
			flowID: twoDraft.flowID,
			genreIDs: twoGenres,
			onboardingStartedRecorded: false
		)
		let fullSmallCatalogResult = await twoGenreStore.commit(fullSmallCatalog, availableGenreIDs: twoGenres)
		XCTAssertNotEqual(fullSmallCatalogResult, .invalid)
		XCTAssertFalse(ProfileSelection.isComplete(selected: [], available: []))
		XCTAssertEqual(
			ProfileSelection.selectionInstruction(available: oneGenre),
			"Choisissez le genre disponible. Vos choix restent sur cet iPhone."
		)
		XCTAssertEqual(
			ProfileSelection.selectionInstruction(available: twoGenres),
			"Choisissez les deux genres disponibles. Vos choix restent sur cet iPhone."
		)
	}

	func testDraftAndProfilePersistAcrossStoreInstances() async throws {
		let store = makeStore()
		let draft = try await initialDraft(from: store)
		let choices = genres(3)
		let selected = ProfileDraft(
			version: Profile.version,
			flowID: draft.flowID,
			genreIDs: choices,
			onboardingStartedRecorded: true
		)
		let saveResult = await store.saveDraft(selected)
		XCTAssertEqual(saveResult, .success(selected))
		let resumedStore = makeStore()
		let resumedDraft = await resumedStore.readDraft()
		XCTAssertEqual(resumedDraft, .draft(selected))
		guard case .saved(let saved) = await resumedStore.commit(selected, availableGenreIDs: choices) else {
			return XCTFail("Expected the profile to be saved.")
		}
		let persistedProfile = await makeStore().read()
		let persistedDraft = await makeStore().readDraft()
		XCTAssertEqual(persistedProfile, .profile(saved))
		XCTAssertEqual(persistedDraft, .missing)
	}

	func testCatalogEvolutionReconcilesAResumedDraftAtEveryThreshold() async throws {
		let originalChoices = genres(3)
		for availableChoices in [
			[originalChoices[0]],
			Array(originalChoices.prefix(2)),
			originalChoices,
		] {
			let store = makeStore(suffix: "catalog-\(availableChoices.count)")
			let initial = try await initialDraft(from: store)
			let savedDraft = ProfileDraft(
				version: Profile.version,
				flowID: initial.flowID,
				genreIDs: originalChoices,
				onboardingStartedRecorded: false
			)
			let saveResult = await store.saveDraft(savedDraft)
			XCTAssertEqual(saveResult, .success(savedDraft))

			let resumed = await makeStore(suffix: "catalog-\(availableChoices.count)").readDraft()
			guard case .draft(let resumedDraft) = resumed else {
				return XCTFail("Expected the persisted draft to resume before commit.")
			}
			XCTAssertTrue(ProfileSelection.isComplete(selected: resumedDraft.genreIDs, available: availableChoices))
			guard case .saved(let profile) = await store.commit(resumedDraft, availableGenreIDs: availableChoices)
			else {
				return XCTFail("Expected the reconciled profile to be saved.")
			}
			XCTAssertEqual(profile.genreIDs, availableChoices)
		}
	}

	func testCorruptionAndWriteFailureDoNotCompleteOnboarding() async throws {
		let localStore = LocalStore(directoryURL: directoryURL)
		if case .failure = await localStore.write(Data("not json".utf8), named: "profile.v1.json") {
			XCTFail("Expected the corrupt fixture to be written.")
		}
		let store = ProfileStore(localStore: localStore)
		let corruptRead = await store.read()
		XCTAssertEqual(corruptRead, .corrupt)
		let futureVersionJSON = """
			{"version":2,"local_id":"00000000-0000-0000-0000-000000000000","genre_ids":[],"revision":1,"onboarding_completed":true,"flow_id":"00000000-0000-0000-0000-000000000000"}
			"""
		if case .failure = await localStore.write(Data(futureVersionJSON.utf8), named: "profile.v1.json") {
			XCTFail("Expected the version fixture to be written.")
		}
		let unsupportedVersion = await store.read()
		XCTAssertEqual(unsupportedVersion, .unsupportedVersion)

		let clearResult = await store.clear()
		XCTAssertEqual(clearResult, .cleared)
		let recoveredDraft = try await initialDraft(from: store)
		let recoveredGenres = genres(3)
		let completedRecovery = ProfileDraft(
			version: Profile.version,
			flowID: recoveredDraft.flowID,
			genreIDs: recoveredGenres,
			onboardingStartedRecorded: false
		)
		guard case .saved = await store.commit(completedRecovery, availableGenreIDs: recoveredGenres) else {
			return XCTFail("Expected onboarding to complete after an explicit purge.")
		}

		let fileURL = directoryURL.appending(path: "not-a-directory")
		try Data().write(to: fileURL)
		let failingStore = ProfileStore(localStore: LocalStore(directoryURL: fileURL))
		let failedDraft = await failingStore.beginInitialDraft()
		XCTAssertEqual(failedDraft, .failure(.unavailable))
	}

	func testFailedProfileWriteLeavesTheDraftRetryable() async throws {
		let store = ProfileStore(
			localStore: LocalStore(directoryURL: directoryURL, failNextWriteNamed: "profile.v1.json")
		)
		let draft = try await initialDraft(from: store)
		let choices = genres(3)
		let selectedDraft = ProfileDraft(
			version: Profile.version,
			flowID: draft.flowID,
			genreIDs: choices,
			onboardingStartedRecorded: false
		)
		let savedDraft = await store.saveDraft(selectedDraft)
		XCTAssertEqual(savedDraft, .success(selectedDraft))

		let failedWrite = await store.commit(selectedDraft, availableGenreIDs: choices)
		let readAfterFailure = await store.read()
		let draftAfterFailure = await store.readDraft()
		XCTAssertEqual(failedWrite, .unavailable)
		XCTAssertEqual(readAfterFailure, .missing)
		XCTAssertEqual(draftAfterFailure, .draft(selectedDraft))

		guard case .saved = await store.commit(selectedDraft, availableGenreIDs: choices) else {
			return XCTFail("Expected the retry to save the profile.")
		}
	}

	func testClearRemovesAConcurrentCommitAndInvalidatesTheProfile() async throws {
		// 2026-10-12: this test used one `Task.yield()` to let the commit start before `clear()`. When
		// `clear()` ran first, the commit legitimately saved a profile and the assertion failed
		// (CI run 38239884450). The gate holds the commit's profile read response, so the order
		// "commit in flight, then clear" is forced rather than hoped for.
		let gate = ResponseGate(holding: .read, named: "profile.v1.json")
		defer { gate.release() }
		let store = ProfileStore(
			localStore: LocalStore(directoryURL: directoryURL) { operation, name in
				await gate.afterOperation(operation, name)
			}
		)
		let draft = try await initialDraft(from: store)
		let choices = genres(3)
		let selected = ProfileDraft(
			version: Profile.version,
			flowID: draft.flowID,
			genreIDs: choices,
			onboardingStartedRecorded: false
		)
		let write = Task { await store.commit(selected, availableGenreIDs: choices) }
		guard await gate.waitUntilReached(timeout: Self.gateTimeout) else {
			return XCTFail("The commit never reached its profile read.")
		}

		let clearResult = await within(Self.gateTimeout) { await store.clear() }
		gate.release()
		let writeResult = await within(Self.gateTimeout) { await write.value }

		XCTAssertEqual(clearResult, .cleared)
		XCTAssertEqual(writeResult, .invalidated)
		let profile = await store.read()
		let draftState = await store.readDraft()
		XCTAssertEqual(profile, .missing)
		XCTAssertEqual(draftState, .missing)
	}

	func testCommitStartedAfterClearSavesANewProfile() async throws {
		// Decision (TRA-410): `clear()` invalidates the commits already in flight, not the ones that
		// start after it returns. Onboarding restarts after an explicit purge and must be able to save.
		let store = makeStore()
		let draft = try await initialDraft(from: store)
		let choices = genres(3)
		let selected = ProfileDraft(
			version: Profile.version,
			flowID: draft.flowID,
			genreIDs: choices,
			onboardingStartedRecorded: false
		)
		guard case .saved(let first) = await store.commit(selected, availableGenreIDs: choices) else {
			return XCTFail("Expected the first profile to be saved.")
		}

		let clearResult = await store.clear()
		XCTAssertEqual(clearResult, .cleared)
		let readAfterClear = await store.read()
		XCTAssertEqual(readAfterClear, .missing)

		guard case .saved(let second) = await store.commit(selected, availableGenreIDs: choices) else {
			return XCTFail("Expected a commit started after clear() to be saved.")
		}
		XCTAssertNotEqual(second.localID, first.localID)
		XCTAssertEqual(second.revision, 1)
		let persisted = await store.read()
		let draftState = await store.readDraft()
		XCTAssertEqual(persisted, .profile(second))
		XCTAssertEqual(draftState, .missing)
	}

	private static let gateTimeout = Duration.seconds(10)

	private func makeStore(suffix: String = "") -> ProfileStore {
		let directory =
			suffix.isEmpty
			? directoryURL!
			: directoryURL.appending(path: suffix, directoryHint: .isDirectory)
		return ProfileStore(localStore: LocalStore(directoryURL: directory))
	}

	private func initialDraft(from store: ProfileStore) async throws -> ProfileDraft {
		guard case .success(let draft) = await store.beginInitialDraft() else {
			throw NSError(domain: "ProfileStoreTests", code: 1)
		}
		return draft
	}

	private func genres(_ count: Int) -> [NodeIdentity] {
		(0..<count).compactMap { NodeIdentity(rawValue: "genre:genre-\($0)") }
	}
}

/// Returns the value of `operation`, or `nil` once `timeout` has elapsed. A stuck operation fails the
/// calling test instead of hanging it until the CI timeout (2026-10-12, #330).
private func within<Value: Sendable>(
	_ timeout: Duration,
	_ operation: @escaping @Sendable () async -> Value
) async -> Value? {
	let outcome = OneShot<Value?>()
	Task { outcome.fulfill(await operation()) }
	Task {
		try? await Task.sleep(for: timeout)
		outcome.fulfill(nil)
	}
	return await outcome.wait()
}

/// A value that is set once (the first `fulfill` wins) and awaited by any number of callers.
private final class OneShot<Value: Sendable>: @unchecked Sendable {
	private let lock = NSLock()
	private var stored: Value?
	private var isFulfilled = false
	private var waiters: [CheckedContinuation<Value, Never>] = []

	func fulfill(_ value: Value) {
		lock.lock()
		guard !isFulfilled else {
			lock.unlock()
			return
		}
		isFulfilled = true
		stored = value
		let pending = waiters
		waiters = []
		lock.unlock()
		for waiter in pending { waiter.resume(returning: value) }
	}

	func wait() async -> Value {
		await withCheckedContinuation { continuation in
			lock.lock()
			if isFulfilled, let value = stored {
				lock.unlock()
				continuation.resume(returning: value)
			} else {
				waiters.append(continuation)
				lock.unlock()
			}
		}
	}
}

/// Holds the first response of one `LocalStore` operation until `release()`. Always releasable: a call
/// to `release()` made before the operation arrives means it is never held, later operations pass
/// through, and the hold gives up on its own after `holdLimit` so no caller stays blocked.
private final class ResponseGate: @unchecked Sendable {
	private static let holdLimit = Duration.seconds(30)

	private let operation: LocalStoreOperation
	private let name: String
	private let lock = NSLock()
	private var isArmed = true
	private let reached = OneShot<Void>()
	private let released = OneShot<Void>()

	init(holding operation: LocalStoreOperation, named name: String) {
		self.operation = operation
		self.name = name
	}

	func afterOperation(_ operation: LocalStoreOperation, _ name: String) async {
		guard operation == self.operation, name == self.name, claim() else { return }
		reached.fulfill(())
		let released = released
		_ = await within(Self.holdLimit) { await released.wait() }
	}

	func waitUntilReached(timeout: Duration) async -> Bool {
		let reached = reached
		return await within(timeout) { await reached.wait() } != nil
	}

	func release() {
		released.fulfill(())
	}

	private func claim() -> Bool {
		lock.lock()
		defer { lock.unlock() }
		let wasArmed = isArmed
		isArmed = false
		return wasArmed
	}
}
