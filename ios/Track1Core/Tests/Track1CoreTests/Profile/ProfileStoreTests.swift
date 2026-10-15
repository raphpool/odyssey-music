import Foundation
import XCTest

@testable import Track1Core

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

	func testOneGenreIsEnoughAndAnEmptySelectionIsRejected() async throws {
		// 2026-10-13: the minimum went from three genres to one (D13, TRA-402); the former small-catalog
		// exception ("select every available genre") no longer exists because one genre always suffices.
		let store = makeStore()
		let initial = try await initialDraft(from: store)
		let threeGenres = genres(3)
		let empty = ProfileDraft(
			version: Profile.version,
			flowID: initial.flowID,
			genreIDs: [],
			onboardingStartedRecorded: false
		)
		let emptyResult = await store.commit(empty, availableGenreIDs: threeGenres)
		XCTAssertEqual(emptyResult, .invalid)

		let single = ProfileDraft(
			version: Profile.version,
			flowID: initial.flowID,
			genreIDs: Array(threeGenres.prefix(1)),
			onboardingStartedRecorded: false
		)
		guard case .saved(let profile) = await store.commit(single, availableGenreIDs: threeGenres) else {
			return XCTFail("Expected a one-genre profile to be saved.")
		}
		XCTAssertEqual(profile.revision, 1)
		XCTAssertEqual(profile.genreIDs, Array(threeGenres.prefix(1)))

		XCTAssertFalse(ProfileSelection.isComplete(selected: [], available: []))
		XCTAssertFalse(ProfileSelection.isComplete(selected: [], available: threeGenres))
		XCTAssertTrue(ProfileSelection.isComplete(selected: Array(threeGenres.prefix(1)), available: threeGenres))
	}

	func testSelectionInstructionAdaptsToTheCatalogSize() {
		XCTAssertEqual(
			ProfileSelection.selectionInstruction(available: genres(1)),
			"Choisissez le genre disponible. Vos choix restent sur cet iPhone."
		)
		XCTAssertEqual(
			ProfileSelection.selectionInstruction(available: genres(2)),
			"Choisissez au moins l’un des deux genres disponibles. Vos choix restent sur cet iPhone."
		)
		XCTAssertEqual(
			ProfileSelection.selectionInstruction(available: genres(3)),
			"Choisissez au moins un genre. Vos choix restent sur cet iPhone."
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
		if case .failure = await localStore.write(Data("not json".utf8), named: "profile.v2.json") {
			XCTFail("Expected the corrupt fixture to be written.")
		}
		let store = ProfileStore(localStore: localStore)
		let corruptRead = await store.read()
		XCTAssertEqual(corruptRead, .corrupt)
		let futureVersionJSON = """
			{"version":3,"local_id":"00000000-0000-0000-0000-000000000000","genre_ids":[],"revision":1,"onboarding_completed":true,"flow_id":"00000000-0000-0000-0000-000000000000"}
			"""
		if case .failure = await localStore.write(Data(futureVersionJSON.utf8), named: "profile.v2.json") {
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
			localStore: LocalStore(directoryURL: directoryURL, failNextWriteNamed: "profile.v2.json")
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
		// (CI run 38239884450). The gate holds one response of the commit, so the order
		// "commit in flight, then clear" is forced rather than hoped for. Both generation guards that
		// matter are covered: the one after the profile read and the one after the profile write.
		for held in [LocalStoreOperation.read, .write] {
			let gate = ResponseGate(holding: held, named: "profile.v2.json")
			defer { gate.release() }
			let directory = directoryURL.appending(path: "held-\(held)", directoryHint: .isDirectory)
			let store = ProfileStore(
				localStore: LocalStore(directoryURL: directory) { operation, name in
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
				return XCTFail("The commit never reached its profile \(held).")
			}

			let clearResult = await within(Self.gateTimeout) { await store.clear() }
			gate.release()
			let writeResult = await within(Self.gateTimeout) { await write.value }

			XCTAssertEqual(clearResult, .cleared, "held \(held)")
			XCTAssertEqual(writeResult, .invalidated, "held \(held)")
			let profile = await store.read()
			let draftState = await store.readDraft()
			XCTAssertEqual(profile, .missing, "held \(held)")
			XCTAssertEqual(draftState, .missing, "held \(held)")
		}
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

	// MARK: Version 2 (TRA-516)

	func testAV1ProfileIsReadAsVersion2WithoutBeingWritten() async throws {
		let choices = genres(3)
		let v1 = try await seedV1Profile(genres: choices).profile
		let read = await makeStore().read()
		XCTAssertEqual(
			read,
			.profile(
				Profile(
					version: Profile.version, localID: v1.localID, genreIDs: choices, revision: v1.revision,
					onboardingCompleted: true, flowID: v1.flowID)))
		XCTAssertFalse(fileExists("profile.v2.json"))
	}

	func testTheFirstCommitAfterAV1ReadWritesV2AndLeavesV1Untouched() async throws {
		let choices = genres(3)
		let (v1, v1Bytes) = try await seedV1Profile(genres: choices)
		let store = makeStore()
		_ = await store.read()
		let selection = GenreSelection(families: ["rock"], genres: [])
		let committed = await store.commit(draft(genres: choices, selection: selection), availableGenreIDs: choices)
		guard case .saved(let saved) = committed else { return XCTFail("Expected the commit to save.") }
		XCTAssertEqual(saved.localID, v1.localID)
		XCTAssertEqual(saved.revision, v1.revision + 1)
		XCTAssertEqual(saved.selection, selection)
		let persisted = await makeStore().read()
		XCTAssertEqual(persisted, .profile(saved))
		XCTAssertEqual(try Data(contentsOf: directoryURL.appending(path: "profile.v1.json")), v1Bytes)
	}

	func testRevisionFollowsTheGenreIDsAndTheSelection() async throws {
		let choices = genres(3)
		let store = makeStore()
		var revisions: [Int] = []
		for family in ["rock", "jazz", "jazz"] {
			let selection = GenreSelection(families: [family], genres: [])
			let committed = await store.commit(
				draft(genres: choices, selection: selection), availableGenreIDs: choices)
			guard case .saved(let saved) = committed else { return XCTFail("Expected the commit to save.") }
			revisions.append(saved.revision)
		}
		XCTAssertEqual(revisions, [1, 2, 2])
	}

	func testV2WinsOverV1AndAFutureVersionIsUnsupported() async throws {
		let choices = genres(3)
		_ = try await seedV1Profile(genres: choices)
		let v2 = Profile(
			version: Profile.version, localID: UUID(), genreIDs: [choices[0]], revision: 7,
			onboardingCompleted: true, flowID: UUID())
		try await seed(v2, named: "profile.v2.json")
		let read = await makeStore().read()
		XCTAssertEqual(read, .profile(v2))

		let future = Profile(
			version: 3, localID: v2.localID, genreIDs: v2.genreIDs, revision: 7, onboardingCompleted: true,
			flowID: v2.flowID)
		try await seed(future, named: "profile.v2.json")
		let futureRead = await makeStore().read()
		XCTAssertEqual(futureRead, .unsupportedVersion)
	}

	func testClearRemovesTheVersion1AndVersion2Files() async throws {
		let names = ["profile.v1.json", "profile-draft.v1.json", "profile.v2.json", "profile-draft.v2.json"]
		let localStore = LocalStore(directoryURL: directoryURL)
		for name in names { _ = await localStore.write(Data("{}".utf8), named: name) }
		let cleared = await ProfileStore(localStore: localStore).clear()
		XCTAssertEqual(cleared, .cleared)
		XCTAssertEqual(names.filter(fileExists), [])
		let read = await ProfileStore(localStore: localStore).read()
		XCTAssertEqual(read, .missing)
	}

	func testAFailedClearKeepsTheVersion2ProfileSoNothingStaleReappears() async throws {
		let choices = genres(3)
		_ = try await seedV1Profile(genres: choices)
		let v2 = Profile(
			version: Profile.version, localID: UUID(), genreIDs: [choices[0]], revision: 7,
			onboardingCompleted: true, flowID: UUID())
		try await seed(v2, named: "profile.v2.json")
		let fileManager = FailingRemovalFileManager(failingOn: ["profile.v1.json"])
		let store = ProfileStore(localStore: LocalStore(directoryURL: directoryURL, fileManager: fileManager))
		let cleared = await store.clear()
		XCTAssertEqual(cleared, .unavailable)
		let read = await store.read()
		XCTAssertEqual(read, .profile(v2))
		XCTAssertTrue(fileExists("profile.v2.json"))
	}

	func testAFailedClearStopsAtTheFirstError() async throws {
		let names = ["profile-draft.v1.json", "profile.v1.json", "profile-draft.v2.json", "profile.v2.json"]
		let localStore = LocalStore(
			directoryURL: directoryURL, fileManager: FailingRemovalFileManager(failingOn: ["profile.v1.json"]))
		for name in names { _ = await localStore.write(Data("{}".utf8), named: name) }
		_ = await ProfileStore(localStore: localStore).clear()
		XCTAssertEqual(names.filter(fileExists), ["profile.v1.json", "profile-draft.v2.json", "profile.v2.json"])
	}

	func testAFailedClearOfTheVersion2ProfileStillRemovesEverythingBeforeIt() async throws {
		let names = ["profile-draft.v1.json", "profile.v1.json", "profile-draft.v2.json", "profile.v2.json"]
		let localStore = LocalStore(
			directoryURL: directoryURL, fileManager: FailingRemovalFileManager(failingOn: ["profile.v2.json"]))
		for name in names { _ = await localStore.write(Data("{}".utf8), named: name) }
		let cleared = await ProfileStore(localStore: localStore).clear()
		XCTAssertEqual(cleared, .unavailable)
		XCTAssertEqual(names.filter(fileExists), ["profile.v2.json"])
	}

	func testAnUnreadableOrUnversionedV1ProfileIsRejectedWhenNoV2Exists() async throws {
		try Data("not json".utf8).write(to: directoryURL.appending(path: "profile.v1.json"))
		let corrupt = await makeStore().read()
		XCTAssertEqual(corrupt, .corrupt)

		let version0 = Profile(
			version: 0, localID: UUID(), genreIDs: genres(2), revision: 3, onboardingCompleted: true, flowID: UUID())
		try await seed(version0, named: "profile.v1.json")
		let unsupported = await makeStore().read()
		XCTAssertEqual(unsupported, .unsupportedVersion)
	}

	func testCommittingAnUnchangedSelectionAfterAV1ReadKeepsTheRevisionAndIdentity() async throws {
		let choices = genres(3)
		let v1 = try await seedV1Profile(genres: choices).profile
		let store = makeStore()
		_ = await store.read()
		let committed = await store.commit(draft(genres: choices), availableGenreIDs: choices)
		guard case .saved(let saved) = committed else { return XCTFail("Expected the commit to save.") }
		XCTAssertEqual(saved.revision, v1.revision)
		XCTAssertEqual(saved.localID, v1.localID)
		XCTAssertEqual(saved.flowID, v1.flowID)
		XCTAssertNil(saved.selection)
	}

	func testReadingAV1ProfileCreatesNoFile() async throws {
		_ = try await seedV1Profile(genres: genres(3))
		let store = makeStore()
		_ = await store.read()
		_ = await store.readDraft()
		let contents = try FileManager.default.contentsOfDirectory(atPath: directoryURL.path)
		XCTAssertEqual(contents.sorted(), ["profile.v1.json"])
	}

	func testAVersion1DraftIsIgnored() async throws {
		let v1Draft = ProfileDraft(version: 1, flowID: UUID(), genreIDs: genres(2), onboardingStartedRecorded: true)
		try await seed(v1Draft, named: "profile-draft.v1.json")
		let store = makeStore()
		let read = await store.readDraft()
		XCTAssertEqual(read, .missing)
		let fresh = try await initialDraft(from: store)
		XCTAssertNotEqual(fresh.flowID, v1Draft.flowID)
		XCTAssertTrue(fileExists("profile-draft.v2.json"))
	}

	func testMarkingOnboardingStartedKeepsTheSelection() async throws {
		let selection = GenreSelection(families: ["rock"], genres: ["Q11399"])
		let started = await makeStore().markOnboardingStarted(draft(genres: [], selection: selection))
		XCTAssertEqual(started, .success(draft(genres: [], selection: selection, started: true)))
	}

	func testCommitKeepsTheSelectionAsAuthorityWhileReconcilingTheGenreIDs() async throws {
		let choices = genres(3)
		let selection = GenreSelection(families: ["rock"], genres: ["Q-retired-from-the-catalog"])
		let committed = await makeStore().commit(
			draft(genres: choices, selection: selection), availableGenreIDs: [choices[0]])
		guard case .saved(let saved) = committed else { return XCTFail("Expected the commit to save.") }
		XCTAssertEqual(saved.genreIDs, [choices[0]])
		XCTAssertEqual(saved.selection, selection)
	}

	private func seedV1Profile(genres: [NodeIdentity]) async throws -> (profile: Profile, bytes: Data) {
		let profile = Profile(
			version: 1, localID: UUID(), genreIDs: genres, revision: 3, onboardingCompleted: true, flowID: UUID())
		try await seed(profile, named: "profile.v1.json")
		return (profile, try Data(contentsOf: directoryURL.appending(path: "profile.v1.json")))
	}

	private func seed(_ value: some Encodable, named name: String) async throws {
		_ = await LocalStore(directoryURL: directoryURL).write(try JSONEncoder().encode(value), named: name)
	}

	private func fileExists(_ name: String) -> Bool {
		FileManager.default.fileExists(atPath: directoryURL.appending(path: name).path)
	}

	private func draft(
		genres: [NodeIdentity], selection: GenreSelection? = nil, started: Bool = false
	) -> ProfileDraft {
		ProfileDraft(
			version: Profile.version, flowID: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
			genreIDs: genres, onboardingStartedRecorded: started, selection: selection)
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

/// System boundary for `LocalStore`: removing a file whose name is listed fails, as a locked or read-only
/// file would. Everything else goes to the real file system.
private final class FailingRemovalFileManager: FileManager, @unchecked Sendable {
	private let failingNames: Set<String>

	init(failingOn names: Set<String>) {
		failingNames = names
		super.init()
	}

	override func removeItem(at url: URL) throws {
		if failingNames.contains(url.lastPathComponent) {
			throw CocoaError(.fileWriteNoPermission)
		}
		try super.removeItem(at: url)
	}
}

/// Returns the value of `operation`, or `nil` once `timeout` has elapsed. A stuck operation fails the
/// calling test instead of hanging it until the CI timeout (2026-10-12, #330).
private func within<Value: Sendable>(
	_ timeout: Duration,
	_ operation: @escaping @Sendable () async -> Value
) async -> Value? {
	let outcome = OneShot<Value?>()
	let timer = Task {
		try? await Task.sleep(for: timeout)
		guard !Task.isCancelled else { return }
		outcome.fulfill(nil)
	}
	Task {
		outcome.fulfill(await operation())
		timer.cancel()
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
