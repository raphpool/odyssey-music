import Track1Core
import XCTest

@testable import Track1

final class OnboardingContractTests: XCTestCase {
	func testOnboardingEventsUseOnlyTheTypedAllowlistedProperties() {
		let flowID = UUID().uuidString.lowercased()
		XCTAssertTrue(
			AnalyticsValidation.accepts(
				AnalyticsEvent(
					name: .onboardingCompleted,
					properties: ["flow_id": .string(flowID), "genres_count": .integer(3)],
					source: .onboarding
				)
			)
		)
		XCTAssertFalse(
			AnalyticsValidation.accepts(
				AnalyticsEvent(
					name: .onboardingCompleted,
					properties: [
						"flow_id": .string(flowID),
						"genres_count": .integer(3),
						"genre_ids": .string("genre:ambient"),
					],
					source: .onboarding
				)
			)
		)
	}

	func testEditingChangesRevisionButCancellingDoesNotWriteAProfile() async throws {
		let directory = FileManager.default.temporaryDirectory.appending(
			path: UUID().uuidString,
			directoryHint: .isDirectory
		)
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = ProfileStore(localStore: LocalStore(directoryURL: directory))
		let choices = (0..<3).compactMap { NodeIdentity(rawValue: "genre:genre-\($0)") }
		guard case .success(let initialDraft) = await store.beginInitialDraft() else {
			return XCTFail("Expected a draft.")
		}
		let completedDraft = ProfileDraft(
			version: Profile.version,
			flowID: initialDraft.flowID,
			genreIDs: choices,
			onboardingStartedRecorded: true
		)
		guard case .saved(let original) = await store.commit(completedDraft, availableGenreIDs: choices) else {
			return XCTFail("Expected an initial profile.")
		}
		guard case .success(let editingDraft) = await store.beginEditingDraft(from: original) else {
			return XCTFail("Expected an editing draft.")
		}
		let changedChoices = Array(choices.dropLast()) + [NodeIdentity(rawValue: "genre:other")!]
		let changedDraft = ProfileDraft(
			version: Profile.version,
			flowID: editingDraft.flowID,
			genreIDs: changedChoices,
			onboardingStartedRecorded: true
		)
		let savedDraft = await store.saveDraft(changedDraft)
		XCTAssertEqual(savedDraft, .success(changedDraft))
		if case .failure = await store.discardEditingDraft() {
			XCTFail("Expected the editing draft to be discarded.")
		}
		let retainedProfile = await store.read()
		XCTAssertEqual(retainedProfile, .profile(original))

		guard case .success(let nextEditingDraft) = await store.beginEditingDraft(from: original),
			case .saved(let updated) = await store.commit(changedDraft, availableGenreIDs: changedChoices)
		else { return XCTFail("Expected the profile update.") }
		XCTAssertEqual(nextEditingDraft.flowID, original.flowID)
		XCTAssertEqual(updated.revision, original.revision + 1)
	}
}
