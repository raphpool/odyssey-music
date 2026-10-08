import Foundation

enum ProfileRead: Equatable, Sendable {
	case missing
	case profile(Profile)
	case corrupt
	case unsupportedVersion
	case unavailable
}

extension ProfileRead {
	var requiresExplicitRecovery: Bool {
		switch self {
		case .corrupt, .unsupportedVersion: true
		case .missing, .profile, .unavailable: false
		}
	}

	var recoveryDescription: String {
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

enum ProfileDraftRead: Equatable, Sendable {
	case missing
	case draft(ProfileDraft)
	case corrupt
	case unavailable
}

enum ProfileWrite: Equatable, Sendable {
	case saved(Profile)
	case invalid
	case unavailable
	case invalidated
}

enum ProfileClear: Equatable, Sendable {
	case cleared
	case unavailable
}

actor ProfileStore {
	private static let profileFile = "profile.v1.json"
	private static let draftFile = "profile-draft.v1.json"

	private let localStore: LocalStore
	private var operationGeneration = 0
	private var shouldResetBeforeUse: Bool
	private var shouldSeedCorruptProfileBeforeUse: Bool

	init(
		localStore: LocalStore = LocalStore(),
		resetBeforeUse: Bool = false,
		seedCorruptProfileBeforeUse: Bool = false
	) {
		self.localStore = localStore
		shouldResetBeforeUse = resetBeforeUse
		shouldSeedCorruptProfileBeforeUse = seedCorruptProfileBeforeUse
	}

	func read() async -> ProfileRead {
		await resetIfNeeded()
		switch await localStore.read(named: Self.profileFile) {
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

	func readDraft() async -> ProfileDraftRead {
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

	func beginInitialDraft() async -> Result<ProfileDraft, LocalStoreError> {
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

	func beginEditingDraft(from profile: Profile) async -> Result<ProfileDraft, LocalStoreError> {
		await resetIfNeeded()
		let draft = ProfileDraft(
			version: Profile.version,
			flowID: profile.flowID,
			genreIDs: profile.genreIDs,
			onboardingStartedRecorded: true
		)
		return await persist(draft)
	}

	func saveDraft(_ draft: ProfileDraft) async -> Result<ProfileDraft, LocalStoreError> {
		await resetIfNeeded()
		guard draft.isValid() else { return .failure(.unavailable) }
		return await persist(draft)
	}

	func markOnboardingStarted(_ draft: ProfileDraft) async -> Result<ProfileDraft, LocalStoreError> {
		await resetIfNeeded()
		guard !draft.onboardingStartedRecorded else { return .success(draft) }
		return await persist(
			ProfileDraft(
				version: draft.version,
				flowID: draft.flowID,
				genreIDs: draft.genreIDs,
				onboardingStartedRecorded: true
			)
		)
	}

	func commit(_ draft: ProfileDraft, availableGenreIDs: [NodeIdentity]) async -> ProfileWrite {
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
		let profile: Profile
		switch current {
		case .profile(let existing):
			let revision = existing.genreIDs == orderedGenreIDs ? existing.revision : existing.revision + 1
			profile = Profile(
				version: Profile.version,
				localID: existing.localID,
				genreIDs: orderedGenreIDs,
				revision: revision,
				onboardingCompleted: true,
				flowID: existing.flowID
			)
		case .missing:
			profile = Profile(
				version: Profile.version,
				localID: UUID(),
				genreIDs: orderedGenreIDs,
				revision: 1,
				onboardingCompleted: true,
				flowID: draft.flowID
			)
		case .corrupt, .unsupportedVersion, .unavailable:
			return .unavailable
		}
		guard expectedGeneration == operationGeneration else { return .invalidated }
		guard case .success = await write(profile, named: Self.profileFile) else { return .unavailable }
		guard expectedGeneration == operationGeneration else { return .invalidated }
		guard case .success = await localStore.remove(named: Self.draftFile) else {
			return .unavailable
		}
		return .saved(profile)
	}

	func discardEditingDraft() async -> Result<Void, LocalStoreError> {
		await resetIfNeeded()
		return await localStore.remove(named: Self.draftFile)
	}

	func clear() async -> ProfileClear {
		await resetIfNeeded()
		operationGeneration += 1
		let profileResult = await localStore.remove(named: Self.profileFile)
		let draftResult = await localStore.remove(named: Self.draftFile)
		guard case .success = profileResult, case .success = draftResult else { return .unavailable }
		return .cleared
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
			_ = await localStore.write(Data("not json".utf8), named: Self.profileFile)
		}
		guard shouldResetBeforeUse else { return }
		shouldResetBeforeUse = false
		operationGeneration += 1
		_ = await localStore.remove(named: Self.profileFile)
		_ = await localStore.remove(named: Self.draftFile)
	}
}
