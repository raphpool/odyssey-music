import Foundation

public enum ProfileSelection {
	public static let minimumGenres = 1

	public static func reconciled(selected: [NodeIdentity], available: [NodeIdentity]) -> [NodeIdentity] {
		let availableGenres = Set(available.filter { $0.type == .genre })
		return selected.filter { availableGenres.contains($0) }
	}

	public static func isComplete(selected: [NodeIdentity], available: [NodeIdentity]) -> Bool {
		let availableGenres = Set(available.filter { $0.type == .genre })
		let selectedGenres = Set(reconciled(selected: selected, available: available))
		guard !availableGenres.isEmpty else { return false }
		return selectedGenres.count >= minimumGenres
	}

	public static func selectionInstruction(available: [NodeIdentity]) -> String {
		switch Set(available.filter { $0.type == .genre }).count {
		case 1:
			"Choisissez le genre disponible. Vos choix restent sur cet iPhone."
		case 2:
			"Choisissez au moins l’un des deux genres disponibles. Vos choix restent sur cet iPhone."
		default:
			"Choisissez au moins un genre. Vos choix restent sur cet iPhone."
		}
	}
}

public struct Profile: Codable, Equatable, Sendable {
	public static let version = 2

	public let version: Int
	public let localID: UUID
	public let genreIDs: [NodeIdentity]
	public let revision: Int
	public let onboardingCompleted: Bool
	public let flowID: UUID
	/// The editorial families and genres behind `genreIDs`. Nil for a profile written before the editorial
	/// taxonomy, which keeps the key absent from the file.
	public let selection: GenreSelection?

	enum CodingKeys: String, CodingKey {
		case version
		case localID = "local_id"
		case genreIDs = "genre_ids"
		case revision
		case onboardingCompleted = "onboarding_completed"
		case flowID = "flow_id"
		case selection
	}

	// Explicit because a `let` optional gets no default value in the memberwise initializer.
	init(
		version: Int, localID: UUID, genreIDs: [NodeIdentity], revision: Int, onboardingCompleted: Bool,
		flowID: UUID, selection: GenreSelection? = nil
	) {
		self.version = version
		self.localID = localID
		self.genreIDs = genreIDs
		self.revision = revision
		self.onboardingCompleted = onboardingCompleted
		self.flowID = flowID
		self.selection = selection
	}

	func isValid() -> Bool {
		version == Self.version && revision > 0 && onboardingCompleted
			&& genreIDs.allSatisfy { $0.type == .genre }
			&& Set(genreIDs).count == genreIDs.count
			&& (selection?.isValid() ?? true)
	}
}

public struct ProfileDraft: Codable, Equatable, Sendable {
	public let version: Int
	public let flowID: UUID
	public let genreIDs: [NodeIdentity]
	public let onboardingStartedRecorded: Bool
	public let selection: GenreSelection?

	enum CodingKeys: String, CodingKey {
		case version
		case flowID = "flow_id"
		case genreIDs = "genre_ids"
		case onboardingStartedRecorded = "onboarding_started_recorded"
		case selection
	}

	public init(
		version: Int, flowID: UUID, genreIDs: [NodeIdentity], onboardingStartedRecorded: Bool,
		selection: GenreSelection? = nil
	) {
		self.version = version
		self.flowID = flowID
		self.genreIDs = genreIDs
		self.onboardingStartedRecorded = onboardingStartedRecorded
		self.selection = selection
	}

	func isValid() -> Bool {
		version == Profile.version && genreIDs.allSatisfy { $0.type == .genre }
			&& Set(genreIDs).count == genreIDs.count && (selection?.isValid() ?? true)
	}
}
