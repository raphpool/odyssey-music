import XCTest

@testable import Track1Core

@MainActor
final class OnboardingFlowModelTests: XCTestCase {
	private let hipHop = NodeIdentity(rawValue: "genre:hip-hop")!
	private let jazz = NodeIdentity(rawValue: "genre:jazz")!
	private let trap = NodeIdentity(rawValue: "genre:trap")!
	private let boomBap = NodeIdentity(rawValue: "genre:boom-bap")!
	private let drill = NodeIdentity(rawValue: "genre:drill")!
	private let bebop = NodeIdentity(rawValue: "genre:bebop")!
	private let coolJazz = NodeIdentity(rawValue: "genre:cool-jazz")!

	private func taxonomy() throws -> GenreTaxonomy {
		GenreTaxonomy(catalog: try OnboardingFixture.catalog())
	}

	private func model(editing: Profile? = nil) throws -> OnboardingFlowModel {
		OnboardingFlowModel(taxonomy: try taxonomy(), editing: editing)
	}

	private func profile(_ genreIDs: [NodeIdentity]) -> Profile {
		Profile(
			version: Profile.version,
			localID: UUID(),
			genreIDs: genreIDs,
			revision: 3,
			onboardingCompleted: true,
			flowID: UUID()
		)
	}

	func testOneParentIsEnoughToContinueFromTheGenres() throws {
		let model = try model()
		XCTAssertFalse(model.canContinueFromGenres)
		model.toggleParent(hipHop)
		XCTAssertTrue(model.canContinueFromGenres)
		model.toggleParent(hipHop)
		XCTAssertFalse(model.canContinueFromGenres)
	}

	func testSubgenreStepsFollowTheSelectionOrderAndTheLastCtaIsTerminer() throws {
		let model = try model()
		model.toggleParent(jazz)
		model.toggleParent(hipHop)

		XCTAssertEqual(model.selectedParents, [jazz, hipHop])
		XCTAssertEqual(model.subgenreSteps, [jazz, hipHop])
		XCTAssertEqual(model.ctaTitle(forStep: 0), "Continuer")
		XCTAssertEqual(model.ctaTitle(forStep: 1), "Terminer")
	}

	func testTheCtaIsEnregistrerOnTheLastStepWhenEditing() throws {
		let model = try model(editing: profile([jazz, hipHop]))

		XCTAssertEqual(model.ctaTitle(forStep: 0), "Continuer")
		XCTAssertEqual(model.ctaTitle(forStep: 1), "Enregistrer")
	}

	func testAParentIgnoresUnknownGenres() throws {
		let model = try model()
		model.toggleParent(trap)
		model.toggleParent(NodeIdentity(rawValue: "genre:ambient")!)

		XCTAssertEqual(model.selectedParents, [])
	}

	func testToggleAllSelectsEverythingThenClears() throws {
		let model = try model()
		model.toggleParent(hipHop)
		XCTAssertFalse(model.isAllSelected(of: hipHop))

		model.toggleAll(of: hipHop)
		XCTAssertTrue(model.isAllSelected(of: hipHop))
		XCTAssertEqual(model.selectedSubgenreCount, 3)

		model.toggleAll(of: hipHop)
		XCTAssertFalse(model.isAllSelected(of: hipHop))
		XCTAssertEqual(model.selectedSubgenreCount, 0)
	}

	func testSelectingEverySubgenreByHandMakesAllSelectedTrue() throws {
		let model = try model()
		model.toggleParent(hipHop)
		model.toggleSubgenre(trap, of: hipHop)
		model.toggleSubgenre(boomBap, of: hipHop)
		XCTAssertFalse(model.isAllSelected(of: hipHop))
		model.toggleSubgenre(drill, of: hipHop)
		XCTAssertTrue(model.isAllSelected(of: hipHop))

		model.toggleSubgenre(drill, of: hipHop)
		XCTAssertFalse(model.isAllSelected(of: hipHop))
		// With one row missing, "select all" completes the selection instead of clearing it.
		model.toggleAll(of: hipHop)
		XCTAssertTrue(model.isAllSelected(of: hipHop))
		XCTAssertEqual(model.selectedSubgenreCount, 3)
	}

	func testDeselectingAParentRemovesItsSubgenresOnly() throws {
		let model = try model()
		model.toggleParent(hipHop)
		model.toggleParent(jazz)
		model.toggleAll(of: hipHop)
		model.toggleSubgenre(bebop, of: jazz)

		model.toggleParent(hipHop)

		XCTAssertEqual(model.selectedParents, [jazz])
		XCTAssertEqual(model.selectedSubgenreCount, 1)
		XCTAssertEqual(model.makeDraft().genreIDs, [jazz, bebop])
	}

	func testASubgenreSharedWithAnotherSelectedParentSurvivesDeselectingOneParent() throws {
		let catalog = try OnboardingFixture.catalog(
			nodes: [("genre:soul", "Soul"), ("genre:rnb", "R&B"), ("genre:neo-soul", "Neo soul")],
			edges: [("genre:soul", "genre:neo-soul", "subgenres"), ("genre:rnb", "genre:neo-soul", "subgenres")]
		)
		let soul = NodeIdentity(rawValue: "genre:soul")!
		let rnb = NodeIdentity(rawValue: "genre:rnb")!
		let neoSoul = NodeIdentity(rawValue: "genre:neo-soul")!
		let model = OnboardingFlowModel(taxonomy: GenreTaxonomy(catalog: catalog))
		model.toggleParent(soul)
		model.toggleParent(rnb)
		model.toggleSubgenre(neoSoul, of: soul)
		XCTAssertTrue(model.isAllSelected(of: rnb))

		model.toggleParent(soul)

		XCTAssertEqual(model.makeDraft().genreIDs, [rnb, neoSoul])
	}

	func testSubgenresOutsideTheParentOrOfAnUnselectedParentAreIgnored() throws {
		let model = try model()
		model.toggleParent(hipHop)
		model.toggleSubgenre(bebop, of: hipHop)
		model.toggleSubgenre(bebop, of: jazz)
		model.toggleAll(of: jazz)

		XCTAssertEqual(model.selectedSubgenreCount, 0)
	}

	func testTheSelectionSurvivesGoingBack() throws {
		let model = try model()
		model.toggleParent(hipHop)
		model.toggleParent(jazz)
		model.toggleSubgenre(trap, of: hipHop)
		model.toggleSubgenre(coolJazz, of: jazz)

		// Going back and forth between steps only reads the model: nothing is reset.
		_ = model.ctaTitle(forStep: 1)
		_ = model.isAllSelected(of: hipHop)
		_ = model.subgenreSteps

		XCTAssertEqual(model.selectedParents, [hipHop, jazz])
		XCTAssertEqual(model.makeDraft().genreIDs, [hipHop, jazz, trap, coolJazz])
	}

	func testMakeDraftHoldsParentsThenSubgenresInSelectionOrderWithoutDuplicates() throws {
		let model = try model()
		model.toggleParent(jazz)
		model.toggleParent(hipHop)
		model.toggleSubgenre(drill, of: hipHop)
		model.toggleSubgenre(bebop, of: jazz)
		model.toggleSubgenre(trap, of: hipHop)

		let draft = model.makeDraft()

		XCTAssertEqual(draft.genreIDs, [jazz, hipHop, drill, bebop, trap])
		XCTAssertEqual(draft.version, Profile.version)
		XCTAssertFalse(draft.onboardingStartedRecorded)
		XCTAssertEqual(model.makeDraft().flowID, draft.flowID)
	}

	func testADraftWithASingleParentIsAValidProfile() async throws {
		let model = try model()
		model.toggleParent(jazz)
		let draft = model.makeDraft()
		let available = [jazz, hipHop, bebop]
		let directory = FileManager.default.temporaryDirectory.appending(
			path: UUID().uuidString,
			directoryHint: .isDirectory
		)
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = ProfileStore(localStore: LocalStore(directoryURL: directory))

		XCTAssertEqual(draft.genreIDs, [jazz])
		guard case .saved(let saved) = await store.commit(draft, availableGenreIDs: available) else {
			return XCTFail("Expected a one-genre selection to be saved.")
		}
		XCTAssertEqual(saved.genreIDs, [jazz])
	}

	func testEditingRestoresExactlyTheSelectionOfAnExistingProfile() throws {
		let existing = profile([jazz, hipHop, bebop, trap])
		let model = try model(editing: existing)

		XCTAssertEqual(model.selectedParents, [jazz, hipHop])
		XCTAssertEqual(model.subgenreSteps, [jazz, hipHop])
		XCTAssertEqual(model.selectedSubgenreCount, 2)
		XCTAssertFalse(model.isAllSelected(of: hipHop))
		let draft = model.makeDraft()
		XCTAssertEqual(Set(draft.genreIDs), Set(existing.genreIDs))
		XCTAssertEqual(draft.genreIDs.count, existing.genreIDs.count)
		XCTAssertEqual(draft.flowID, existing.flowID)
	}

	func testEditingKeepsAllSelectedForAFullyChosenParent() throws {
		let model = try model(editing: profile([hipHop, trap, boomBap, drill]))

		XCTAssertTrue(model.isAllSelected(of: hipHop))
	}

	func testEditingIgnoresStoredGenresThatAreNoLongerInTheTaxonomy() throws {
		// A profile from before the parent/subgenre flow can hold a genre without a tile today.
		let ambient = NodeIdentity(rawValue: "genre:ambient")!
		let model = try model(editing: profile([ambient, jazz]))

		XCTAssertEqual(model.selectedParents, [jazz])
		XCTAssertEqual(model.makeDraft().genreIDs, [jazz])
	}

	func testAResumedDraftKeepsItsFlowIDItsStartedFlagAndItsSelection() throws {
		let flowID = UUID()
		let resumed = ProfileDraft(
			version: Profile.version,
			flowID: flowID,
			genreIDs: [hipHop, trap],
			onboardingStartedRecorded: true
		)
		let model = OnboardingFlowModel(taxonomy: try taxonomy(), draft: resumed)

		XCTAssertEqual(model.selectedParents, [hipHop])
		XCTAssertEqual(model.selectedSubgenreCount, 1)
		model.toggleSubgenre(drill, of: hipHop)
		let draft = model.makeDraft()
		XCTAssertEqual(draft.flowID, flowID)
		XCTAssertTrue(draft.onboardingStartedRecorded)
		XCTAssertEqual(draft.genreIDs, [hipHop, trap, drill])
	}
}
