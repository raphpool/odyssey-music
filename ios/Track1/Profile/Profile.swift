import Foundation
import Track1Core

enum ProfileSelection {
	static let minimumGenres = 3

	static func reconciled(selected: [NodeIdentity], available: [NodeIdentity]) -> [NodeIdentity] {
		let availableGenres = Set(available.filter { $0.type == .genre })
		return selected.filter { availableGenres.contains($0) }
	}

	static func isComplete(selected: [NodeIdentity], available: [NodeIdentity]) -> Bool {
		let availableGenres = Set(available.filter { $0.type == .genre })
		let selectedGenres = Set(reconciled(selected: selected, available: available))
		guard !availableGenres.isEmpty else { return false }
		return availableGenres.count < minimumGenres
			? selectedGenres == availableGenres
			: selectedGenres.count >= minimumGenres
	}

	static func selectionInstruction(available: [NodeIdentity]) -> String {
		switch Set(available.filter { $0.type == .genre }).count {
		case 1:
			"Choisissez le genre disponible. Vos choix restent sur cet iPhone."
		case 2:
			"Choisissez les deux genres disponibles. Vos choix restent sur cet iPhone."
		default:
			"Choisissez au moins trois genres. Vos choix restent sur cet iPhone."
		}
	}
}

struct Profile: Codable, Equatable, Sendable {
	static let version = 1

	let version: Int
	let localID: UUID
	let genreIDs: [NodeIdentity]
	let revision: Int
	let onboardingCompleted: Bool
	let flowID: UUID

	enum CodingKeys: String, CodingKey {
		case version
		case localID = "local_id"
		case genreIDs = "genre_ids"
		case revision
		case onboardingCompleted = "onboarding_completed"
		case flowID = "flow_id"
	}

	func isValid() -> Bool {
		version == Self.version && revision > 0 && onboardingCompleted
			&& genreIDs.allSatisfy { $0.type == .genre }
			&& Set(genreIDs).count == genreIDs.count
	}
}

struct ProfileDraft: Codable, Equatable, Sendable {
	let version: Int
	let flowID: UUID
	let genreIDs: [NodeIdentity]
	let onboardingStartedRecorded: Bool

	enum CodingKeys: String, CodingKey {
		case version
		case flowID = "flow_id"
		case genreIDs = "genre_ids"
		case onboardingStartedRecorded = "onboarding_started_recorded"
	}

	func isValid() -> Bool {
		version == Profile.version && genreIDs.allSatisfy { $0.type == .genre }
			&& Set(genreIDs).count == genreIDs.count
	}
}
