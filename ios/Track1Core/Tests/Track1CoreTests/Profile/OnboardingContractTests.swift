import XCTest

@testable import Track1Core

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
			onboardingStartedRecorded: true,
			displayName: "Raph",
			disc: .mint
		)
		guard case .saved(let original) = await store.commit(completedDraft, availableGenreIDs: choices) else {
			return XCTFail("Expected an initial profile.")
		}
		let changedChoices = Array(choices.dropLast()) + [NodeIdentity(rawValue: "genre:other")!]
		let changedDraft = ProfileDraft(
			version: Profile.version,
			flowID: original.flowID,
			genreIDs: changedChoices,
			onboardingStartedRecorded: true
		)
		let savedDraft = await store.saveDraft(changedDraft)
		XCTAssertEqual(savedDraft, .success(changedDraft))
		let retainedProfile = await store.read()
		XCTAssertEqual(retainedProfile, .profile(original))

		guard case .saved(let updated) = await store.commit(changedDraft, availableGenreIDs: changedChoices) else {
			return XCTFail("Expected the profile update.")
		}
		XCTAssertEqual(updated.revision, original.revision + 1)
	}

	func testAProfileWithASingleGenreIsValidAndRoundTrips() async throws {
		let directory = FileManager.default.temporaryDirectory.appending(
			path: UUID().uuidString,
			directoryHint: .isDirectory
		)
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = ProfileStore(localStore: LocalStore(directoryURL: directory))
		let jazz = try XCTUnwrap(NodeIdentity(rawValue: "genre:jazz"))
		guard case .success(let draft) = await store.beginInitialDraft() else {
			return XCTFail("Expected a draft.")
		}
		let single = ProfileDraft(
			version: Profile.version,
			flowID: draft.flowID,
			genreIDs: [jazz],
			onboardingStartedRecorded: true,
			displayName: "Raph",
			disc: .mint
		)
		guard case .saved(let profile) = await store.commit(single, availableGenreIDs: [jazz]) else {
			return XCTFail("Expected a one-genre profile to be saved.")
		}
		XCTAssertEqual(ProfileSelection.minimumGenres, 1)
		let reloaded = await store.read()
		XCTAssertEqual(reloaded, .profile(profile))
		XCTAssertEqual(profile.genreIDs, [jazz])
	}
}
