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
			onboardingStartedRecorded: false, displayName: "Raph", disc: .mint
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
			onboardingStartedRecorded: true, displayName: "Raph", disc: .mint
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
				onboardingStartedRecorded: false, displayName: "Raph", disc: .mint
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
		if case .failure = await localStore.write(Data("not json".utf8), named: "profile.v3.json") {
			XCTFail("Expected the corrupt fixture to be written.")
		}
		let store = ProfileStore(localStore: localStore)
		let corruptRead = await store.read()
		XCTAssertEqual(corruptRead, .corrupt)
		let futureVersionJSON = """
			{"version":4,"local_id":"00000000-0000-0000-0000-000000000000","genre_ids":[],"revision":1,"onboarding_completed":true,"flow_id":"00000000-0000-0000-0000-000000000000","display_name":"Raph","disc":"mint","created_at":"2027-01-15T08:00:00Z"}
			"""
		if case .failure = await localStore.write(Data(futureVersionJSON.utf8), named: "profile.v3.json") {
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
			onboardingStartedRecorded: false, displayName: "Raph", disc: .mint
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
			localStore: LocalStore(directoryURL: directoryURL, failNextWriteNamed: "profile.v3.json")
		)
		let draft = try await initialDraft(from: store)
		let choices = genres(3)
		let selectedDraft = ProfileDraft(
			version: Profile.version,
			flowID: draft.flowID,
			genreIDs: choices,
			onboardingStartedRecorded: false, displayName: "Raph", disc: .mint
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
			let gate = ResponseGate(holding: held, named: "profile.v3.json")
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
				onboardingStartedRecorded: false, displayName: "Raph", disc: .mint
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
			onboardingStartedRecorded: false, displayName: "Raph", disc: .mint
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

	// MARK: Version 3 (TRA-712)

	func testOldProfilesAndDraftsAreIgnored() async throws {
		// Decision Q12 (2026-11-16): nothing of v1 or v2 is read, whatever else is on disk.
		let old = #"{"version":2,"local_id":"\#(UUID())","genre_ids":[],"revision":3,"#
			+ #""onboarding_completed":true,"flow_id":"\#(UUID())"}"#
		let localStore = LocalStore(directoryURL: directoryURL)
		let store = ProfileStore(localStore: localStore)
		_ = await localStore.write(Data(old.utf8), named: "profile.v2.json")
		let onlyV2 = await store.read()
		XCTAssertEqual(onlyV2, .missing)
		for name in allNames.dropLast(2) { _ = await localStore.write(Data(old.utf8), named: name) }
		let profile = await store.read()
		let draft = await store.readDraft()
		XCTAssertEqual(profile, .missing)
		XCTAssertEqual(draft, .missing)
	}

	func testTheFirstCommitStampsTheClockAndDeletesTheOldFiles() async throws {
		let clock = Date(timeIntervalSince1970: 1_800_000_000)
		let localStore = LocalStore(directoryURL: directoryURL)
		for name in allNames.dropLast(2) { _ = await localStore.write(Data("{}".utf8), named: name) }
		let store = ProfileStore(localStore: localStore, now: { clock })
		let choices = genres(3)
		guard case .saved(let saved) = await store.commit(draft(genres: choices), availableGenreIDs: choices) else {
			return XCTFail("Expected the first commit to save.")
		}
		XCTAssertEqual(saved.createdAt, clock)
		XCTAssertEqual(saved.displayName, "Raph")
		XCTAssertEqual(saved.disc, .mint)
		XCTAssertEqual(allNames.dropLast(2).filter(fileExists), [])
		let reread = await store.read()
		XCTAssertEqual(reread, .profile(saved))
	}

	func testCreatedAtIsWholeSecondsSoTheSavedProfileEqualsTheOneRead() async throws {
		let store = ProfileStore(
			localStore: LocalStore(directoryURL: directoryURL),
			now: { Date(timeIntervalSince1970: 1_800_000_000.75) })
		let choices = genres(3)
		guard case .saved(let saved) = await store.commit(draft(genres: choices), availableGenreIDs: choices) else {
			return XCTFail("Expected the commit to save.")
		}
		XCTAssertEqual(saved.createdAt, Date(timeIntervalSince1970: 1_800_000_000))
		let reread = await store.read()
		XCTAssertEqual(reread, .profile(saved))
	}

	func testALaterCommitWithoutPseudoOrDiscKeepsThemAndTheCreationDate() async throws {
		let choices = genres(3)
		let first = ProfileStore(
			localStore: LocalStore(directoryURL: directoryURL), now: { Date(timeIntervalSince1970: 1_800_000_000) })
		guard case .saved(let original) = await first.commit(draft(genres: choices), availableGenreIDs: choices)
		else { return XCTFail("Expected the first commit to save.") }

		let later = ProfileStore(
			localStore: LocalStore(directoryURL: directoryURL), now: { Date(timeIntervalSince1970: 1_900_000_000) })
		let edit = draft(genres: Array(choices.prefix(2)), named: false)
		guard case .saved(let updated) = await later.commit(edit, availableGenreIDs: choices) else {
			return XCTFail("Expected the edit to save.")
		}
		XCTAssertEqual(updated.displayName, original.displayName)
		XCTAssertEqual(updated.disc, original.disc)
		XCTAssertEqual(updated.createdAt, original.createdAt)
		XCTAssertEqual(updated.revision, original.revision + 1)

		let raw = ProfileDraft(
			version: Profile.version, flowID: edit.flowID, genreIDs: choices, onboardingStartedRecorded: true,
			displayName: " Raph ")
		let rawResult = await later.commit(raw, availableGenreIDs: choices)
		XCTAssertEqual(rawResult, .invalid)
	}

	func testACommitWithoutAValidPseudoAndDiscOnAMissingProfileWritesNothing() async throws {
		let choices = genres(3)
		let identities: [(String?, ProfileDisc?)] = [
			(nil, nil), ("Raph", nil), (nil, .mint), (" Raph ", .mint), ("", .mint),
		]
		for (name, disc) in identities {
			let candidate = ProfileDraft(
				version: Profile.version, flowID: UUID(), genreIDs: choices, onboardingStartedRecorded: true,
				displayName: name, disc: disc)
			let result = await makeStore().commit(candidate, availableGenreIDs: choices)
			XCTAssertEqual(result, .invalid, "\(String(describing: name)) \(String(describing: disc))")
		}
		XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directoryURL.path), [])
	}

	func testAV3FileWithAnUnknownDiscAnAbsentKeyOrARawPseudoIsCorrupt() async throws {
		let localStore = LocalStore(directoryURL: directoryURL)
		let store = ProfileStore(localStore: localStore)
		_ = await localStore.write(try v3JSON(), named: "profile.v3.json")
		guard case .profile = await store.read() else { return XCTFail("The fixture itself must be valid.") }
		var broken = [try v3JSON(disc: "pink"), try v3JSON(name: " Raph ")]
		for key in ["display_name", "disc", "created_at"] { broken.append(try v3JSON(omitting: key)) }
		for data in broken {
			_ = await localStore.write(data, named: "profile.v3.json")
			let read = await store.read()
			XCTAssertEqual(read, .corrupt)
		}
	}

	func testTheFileUsesSnakeCaseKeysAndAnISO8601Date() async throws {
		let store = ProfileStore(
			localStore: LocalStore(directoryURL: directoryURL), now: { Date(timeIntervalSince1970: 1_800_000_000) })
		let choices = genres(3)
		guard case .saved = await store.commit(draft(genres: choices), availableGenreIDs: choices) else {
			return XCTFail("Expected the commit to save.")
		}
		let data = try Data(contentsOf: directoryURL.appending(path: "profile.v3.json"))
		let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
		XCTAssertEqual(object["display_name"] as? String, "Raph")
		XCTAssertEqual(object["disc"] as? String, "mint")
		XCTAssertEqual(object["created_at"] as? String, "2027-01-15T08:00:00Z")
		XCTAssertEqual(object["version"] as? Int, 3)
	}

	// MARK: Selection (TRA-516)

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

	func testClearRemovesEveryVersionOfTheFiles() async throws {
		let names = allNames
		let localStore = LocalStore(directoryURL: directoryURL)
		for name in names { _ = await localStore.write(Data("{}".utf8), named: name) }
		let cleared = await ProfileStore(localStore: localStore).clear()
		XCTAssertEqual(cleared, .cleared)
		XCTAssertEqual(names.filter(fileExists), [])
		let read = await ProfileStore(localStore: localStore).read()
		XCTAssertEqual(read, .missing)
	}

	func testAFailedClearStopsAtTheFirstError() async throws {
		let names = allNames
		let localStore = LocalStore(
			directoryURL: directoryURL, fileManager: FailingRemovalFileManager(failingOn: ["profile.v1.json"]))
		for name in names { _ = await localStore.write(Data("{}".utf8), named: name) }
		let cleared = await ProfileStore(localStore: localStore).clear()
		XCTAssertEqual(cleared, .unavailable)
		XCTAssertEqual(names.filter(fileExists), Array(allNames.dropFirst()))
	}

	func testAFailedClearOfTheVersion3ProfileStillRemovesEverythingBeforeIt() async throws {
		let names = allNames
		let localStore = LocalStore(
			directoryURL: directoryURL, fileManager: FailingRemovalFileManager(failingOn: ["profile.v3.json"]))
		for name in names { _ = await localStore.write(Data("{}".utf8), named: name) }
		let cleared = await ProfileStore(localStore: localStore).clear()
		XCTAssertEqual(cleared, .unavailable)
		XCTAssertEqual(names.filter(fileExists), ["profile.v3.json"])
	}

	func testAVersion1DraftIsIgnored() async throws {
		let v1Draft = ProfileDraft(version: 1, flowID: UUID(), genreIDs: genres(2), onboardingStartedRecorded: true)
		try await seed(v1Draft, named: "profile-draft.v1.json")
		let store = makeStore()
		let read = await store.readDraft()
		XCTAssertEqual(read, .missing)
		let fresh = try await initialDraft(from: store)
		XCTAssertNotEqual(fresh.flowID, v1Draft.flowID)
		XCTAssertTrue(fileExists("profile-draft.v3.json"))
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

	private func seed(_ value: some Encodable, named name: String) async throws {
		_ = await LocalStore(directoryURL: directoryURL).write(try JSONEncoder().encode(value), named: name)
	}

	private func fileExists(_ name: String) -> Bool {
		FileManager.default.fileExists(atPath: directoryURL.appending(path: name).path)
	}

	private let allNames = [
		"profile-draft.v1.json", "profile.v1.json", "profile-draft.v2.json", "profile.v2.json",
		"profile-draft.v3.json", "profile.v3.json",
	]

	private func draft(
		genres: [NodeIdentity], selection: GenreSelection? = nil, started: Bool = false, named: Bool = true
	) -> ProfileDraft {
		ProfileDraft(
			version: Profile.version, flowID: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
			genreIDs: genres, onboardingStartedRecorded: started, selection: selection,
			displayName: named ? "Raph" : nil, disc: named ? .mint : nil)
	}

	private func v3JSON(disc: String = "mint", name: String = "Raph", omitting key: String? = nil) throws
		-> Data
	{
		var object: [String: Any] = [
			"version": 3, "local_id": UUID().uuidString, "genre_ids": [], "revision": 1,
			"onboarding_completed": true, "flow_id": UUID().uuidString, "display_name": name, "disc": disc,
			"created_at": "2027-01-15T08:00:00Z",
		]
		if let key { object[key] = nil }
		return try JSONSerialization.data(withJSONObject: object)
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
