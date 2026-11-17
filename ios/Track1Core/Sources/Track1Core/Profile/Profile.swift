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
	public static let version = 3

	public let version: Int
	public let localID: UUID
	public let genreIDs: [NodeIdentity]
	public let revision: Int
	public let onboardingCompleted: Bool
	public let flowID: UUID
	/// Set once, by the first commit, and kept by every later one.
	public let createdAt: Date
	/// Nil until the pseudo and disc screens are wired into onboarding. When present, already normalized by
	/// `PseudoRules`: `isValid()` refuses a file that holds anything else.
	public let displayName: String?
	public let disc: ProfileDisc?
	/// The editorial families and genres behind `genreIDs`. Nil when the draft carried none, which keeps the
	/// key absent from the file.
	public let selection: GenreSelection?

	enum CodingKeys: String, CodingKey {
		case version
		case localID = "local_id"
		case genreIDs = "genre_ids"
		case revision
		case onboardingCompleted = "onboarding_completed"
		case flowID = "flow_id"
		case createdAt = "created_at"
		case displayName = "display_name"
		case disc
		case selection
	}

	// Explicit because a `let` optional gets no default value in the memberwise initializer.
	init(
		version: Int, localID: UUID, genreIDs: [NodeIdentity], revision: Int, onboardingCompleted: Bool,
		flowID: UUID, createdAt: Date, displayName: String? = nil, disc: ProfileDisc? = nil,
		selection: GenreSelection? = nil
	) {
		self.version = version
		self.localID = localID
		self.genreIDs = genreIDs
		self.revision = revision
		self.onboardingCompleted = onboardingCompleted
		self.flowID = flowID
		self.createdAt = createdAt
		self.displayName = displayName
		self.disc = disc
		self.selection = selection
	}

	func isValid() -> Bool {
		version == Self.version && revision > 0 && onboardingCompleted
			&& (displayName.map { PseudoRules.normalized($0) == $0 } ?? true)
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
	/// Nil until the pseudo and disc screens have run; the commit then takes them from the saved profile.
	public let displayName: String?
	public let disc: ProfileDisc?

	enum CodingKeys: String, CodingKey {
		case version
		case flowID = "flow_id"
		case genreIDs = "genre_ids"
		case onboardingStartedRecorded = "onboarding_started_recorded"
		case selection
		case displayName = "display_name"
		case disc
	}

	public init(
		version: Int, flowID: UUID, genreIDs: [NodeIdentity], onboardingStartedRecorded: Bool,
		selection: GenreSelection? = nil, displayName: String? = nil, disc: ProfileDisc? = nil
	) {
		self.version = version
		self.flowID = flowID
		self.genreIDs = genreIDs
		self.onboardingStartedRecorded = onboardingStartedRecorded
		self.selection = selection
		self.displayName = displayName
		self.disc = disc
	}

	func isValid() -> Bool {
		version == Profile.version && genreIDs.allSatisfy { $0.type == .genre }
			&& Set(genreIDs).count == genreIDs.count && (selection?.isValid() ?? true)
			&& (displayName.map { PseudoRules.normalized($0) == $0 } ?? true)
	}
}
