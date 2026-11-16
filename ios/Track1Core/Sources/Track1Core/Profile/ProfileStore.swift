import Foundation

public enum ProfileRead: Equatable, Sendable {
	case missing
	case profile(Profile)
	case corrupt
	case unsupportedVersion
	case unavailable
}

extension ProfileRead {
	public var requiresExplicitRecovery: Bool {
		switch self {
		case .corrupt, .unsupportedVersion: true
		case .missing, .profile, .unavailable: false
		}
	}

	public var recoveryDescription: String {
		switch self {
		case .unsupportedVersion:
			"La version de votre profil musical n’est pas prise en charge sur cet iPhone."
		case .corrupt:
			"Votre profil musical local ne peut pas être lu."
		case .missing, .profile, .unavailable:
			""
		}
	}
}

public enum ProfileDraftRead: Equatable, Sendable {
	case missing
	case draft(ProfileDraft)
	case corrupt
	case unavailable
}

public enum ProfileWrite: Equatable, Sendable {
	case saved(Profile)
	case invalid
	case unavailable
	case invalidated
}

public enum ProfileClear: Equatable, Sendable {
	case cleared
	case unavailable
}

public actor ProfileStore {
	/// Also read by the simulator-only `-track1-fail-next-profile-write` hook in `AppContainer`.
	public static let profileFileName = "profile.v2.json"
	private static let draftFile = "profile-draft.v2.json"
	// 2026-11-16 (TRA-757, decision Q12): the v1 files are never read, so a person who only has a v1 profile
	// goes through onboarding again. They are still named here because `clear()` removes them.
	private static let legacyProfileFile = "profile.v1.json"
	private static let legacyDraftFile = "profile-draft.v1.json"
	// The v2 profile is removed last: when the removal of an older file fails, `clear()` stops there and the
	// profile is still readable, instead of half erased.
	private static let removalOrder = [legacyDraftFile, legacyProfileFile, draftFile, profileFileName]

	private let localStore: LocalStore
	private var operationGeneration = 0
	private var shouldResetBeforeUse: Bool
	private var shouldSeedCorruptProfileBeforeUse: Bool

	public init(
		localStore: LocalStore = LocalStore(),
		resetBeforeUse: Bool = false,
		seedCorruptProfileBeforeUse: Bool = false
	) {
		self.localStore = localStore
		shouldResetBeforeUse = resetBeforeUse
		shouldSeedCorruptProfileBeforeUse = seedCorruptProfileBeforeUse
	}

	public func read() async -> ProfileRead {
		await resetIfNeeded()
		switch await localStore.read(named: Self.profileFileName) {
		case .failure: return .unavailable
		case .success(nil): return .missing
		case .success(let data?):
			guard let profile = try? JSONDecoder().decode(Profile.self, from: data) else {
				return .corrupt
			}
			guard profile.version == Profile.version else { return .unsupportedVersion }
			guard profile.isValid() else { return .corrupt }
			return .profile(profile)
		}
	}

	public func readDraft() async -> ProfileDraftRead {
		await resetIfNeeded()
		switch await localStore.read(named: Self.draftFile) {
		case .failure: return .unavailable
		case .success(nil): return .missing
		case .success(let data?):
			guard let draft = try? JSONDecoder().decode(ProfileDraft.self, from: data), draft.isValid() else {
				return .corrupt
			}
			return .draft(draft)
		}
	}

	public func beginInitialDraft() async -> Result<ProfileDraft, LocalStoreError> {
		await resetIfNeeded()
		switch await readDraft() {
		case .draft(let draft): return .success(draft)
		case .unavailable: return .failure(.unavailable)
		case .missing, .corrupt:
			let draft = ProfileDraft(
				version: Profile.version, flowID: UUID(), genreIDs: [], onboardingStartedRecorded: false)
			return await persist(draft)
		}
	}

	public func saveDraft(_ draft: ProfileDraft) async -> Result<ProfileDraft, LocalStoreError> {
		await resetIfNeeded()
		guard draft.isValid() else { return .failure(.unavailable) }
		return await persist(draft)
	}

	public func markOnboardingStarted(_ draft: ProfileDraft) async -> Result<ProfileDraft, LocalStoreError> {
		await resetIfNeeded()
		guard !draft.onboardingStartedRecorded else { return .success(draft) }
		return await persist(
			ProfileDraft(
				version: draft.version,
				flowID: draft.flowID,
				genreIDs: draft.genreIDs,
				onboardingStartedRecorded: true,
				selection: draft.selection
			)
		)
	}

	public func commit(_ draft: ProfileDraft, availableGenreIDs: [NodeIdentity]) async -> ProfileWrite {
		await resetIfNeeded()
		let reconciledGenreIDs = ProfileSelection.reconciled(selected: draft.genreIDs, available: availableGenreIDs)
		guard draft.isValid(),
			ProfileSelection.isComplete(selected: reconciledGenreIDs, available: availableGenreIDs)
		else {
			return .invalid
		}
		let expectedGeneration = operationGeneration
		let current = await read()
		guard expectedGeneration == operationGeneration else { return .invalidated }
		guard current != .corrupt, current != .unsupportedVersion, current != .unavailable else {
			return .unavailable
		}
		let orderedGenreIDs = reconciledGenreIDs.sorted { $0.rawValue < $1.rawValue }
		// `selection` is the person's intent and is kept as is; only `genreIDs`, its projection that the
		// daily recommendation reads, is reconciled with the catalog.
		let profile: Profile
		switch current {
		case .profile(let existing):
			let unchanged = existing.genreIDs == orderedGenreIDs && existing.selection == draft.selection
			profile = Profile(
				version: Profile.version,
				localID: existing.localID,
				genreIDs: orderedGenreIDs,
				revision: unchanged ? existing.revision : existing.revision + 1,
				onboardingCompleted: true,
				flowID: existing.flowID,
				selection: draft.selection
			)
		case .missing:
			profile = Profile(
				version: Profile.version,
				localID: UUID(),
				genreIDs: orderedGenreIDs,
				revision: 1,
				onboardingCompleted: true,
				flowID: draft.flowID,
				selection: draft.selection
			)
		case .corrupt, .unsupportedVersion, .unavailable:
			return .unavailable
		}
		guard expectedGeneration == operationGeneration else { return .invalidated }
		guard case .success = await write(profile, named: Self.profileFileName) else { return .unavailable }
		guard expectedGeneration == operationGeneration else { return .invalidated }
		guard case .success = await localStore.remove(named: Self.draftFile) else {
			return .unavailable
		}
		return .saved(profile)
	}

	public func clear() async -> ProfileClear {
		await resetIfNeeded()
		operationGeneration += 1
		return await removeAllFiles() ? .cleared : .unavailable
	}

	private func removeAllFiles() async -> Bool {
		for name in Self.removalOrder {
			if case .failure = await localStore.remove(named: name) { return false }
		}
		return true
	}

	private func persist(_ draft: ProfileDraft) async -> Result<ProfileDraft, LocalStoreError> {
		guard case .success = await write(draft, named: Self.draftFile) else { return .failure(.unavailable) }
		return .success(draft)
	}

	private func write<Value: Encodable>(
		_ value: Value,
		named name: String
	) async -> Result<Void, LocalStoreError> {
		do {
			let encoder = JSONEncoder()
			encoder.outputFormatting = [.sortedKeys]
			return await localStore.write(try encoder.encode(value), named: name)
		} catch {
			return .failure(.unavailable)
		}
	}

	private func resetIfNeeded() async {
		if shouldSeedCorruptProfileBeforeUse {
			shouldSeedCorruptProfileBeforeUse = false
			operationGeneration += 1
			_ = await localStore.write(Data("not json".utf8), named: Self.profileFileName)
		}
		guard shouldResetBeforeUse else { return }
		shouldResetBeforeUse = false
		operationGeneration += 1
		_ = await removeAllFiles()
	}
}
