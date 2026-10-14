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

	func testParentChoicesAreTheTaxonomyTilesInDisplayOrder() throws {
		let model = try model()
		let expected = try taxonomy().parents
		XCTAssertFalse(expected.isEmpty)
		XCTAssertEqual(model.parentChoices, expected)
		model.toggleParent(jazz)
		XCTAssertEqual(model.parentChoices, expected, "selecting must not reorder or filter the tiles")
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

	// MARK: - Editing an old profile (TRA-442)

	private let rock = NodeIdentity(rawValue: "genre:rock")!
	private let shoegaze = NodeIdentity(rawValue: "genre:shoegaze")!
	private let altRock = NodeIdentity(rawValue: "genre:alt-rock")!
	private let grunge = NodeIdentity(rawValue: "genre:grunge")!
	private let ambient = NodeIdentity(rawValue: "genre:ambient")!
	private let soul = NodeIdentity(rawValue: "genre:soul")!
	private let rnb = NodeIdentity(rawValue: "genre:rnb")!
	private let neoSoul = NodeIdentity(rawValue: "genre:neo-soul")!

	/// Rock > Shoegaze, Rock > Alt rock > Grunge (level 3), Soul and R&B sharing Neo soul, Jazz > Bebop.
	/// `genre:orphan-level-3` hangs under a subgenre that no parent reaches, so it has no ancestor to join.
	private func deepTaxonomy() throws -> GenreTaxonomy {
		GenreTaxonomy(
			catalog: try OnboardingFixture.catalog(
				nodes: [
					("genre:rock", "Rock"), ("genre:shoegaze", "Shoegaze"), ("genre:alt-rock", "Alt rock"),
					("genre:grunge", "Grunge"), ("genre:soul", "Soul"), ("genre:rnb", "R&B"),
					("genre:neo-soul", "Neo soul"), ("genre:jazz", "Jazz"), ("genre:bebop", "Bebop"),
					("genre:ambient", "Ambient"), ("genre:loop-a", "Loop A"), ("genre:orphan-level-3", "Orphan"),
				],
				edges: [
					("genre:rock", "genre:shoegaze", "subgenres"), ("genre:rock", "genre:alt-rock", "subgenres"),
					("genre:alt-rock", "genre:grunge", "subgenres"), ("genre:soul", "genre:neo-soul", "subgenres"),
					("genre:rnb", "genre:neo-soul", "subgenres"), ("genre:jazz", "genre:bebop", "subgenres"),
					("genre:loop-a", "genre:orphan-level-3", "subgenres"),
					("genre:orphan-level-3", "genre:loop-a", "subgenres"),
				]
			))
	}

	private func deepModel(editing stored: [NodeIdentity]) throws -> OnboardingFlowModel {
		OnboardingFlowModel(taxonomy: try deepTaxonomy(), editing: profile(stored))
	}

	func testASubgenreWithoutItsParentLoadsWithTheParentSelectedAndTheSubgenreChecked() async throws {
		let model = try deepModel(editing: [shoegaze])

		XCTAssertEqual(model.selectedParents, [rock])
		XCTAssertEqual(model.subgenreSteps, [rock])
		XCTAssertEqual(model.selectedSubgenreCount, 1)
		XCTAssertEqual(model.droppedGenres, [])
		// Saving without touching anything keeps both, and the profile store accepts the result.
		let draft = model.makeDraft()
		XCTAssertEqual(draft.genreIDs, [rock, shoegaze])
		let directory = FileManager.default.temporaryDirectory.appending(
			path: UUID().uuidString, directoryHint: .isDirectory)
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = ProfileStore(localStore: LocalStore(directoryURL: directory))
		guard case .saved(let saved) = await store.commit(draft, availableGenreIDs: [rock, shoegaze]) else {
			return XCTFail("Expected the promoted selection to be saved.")
		}
		XCTAssertEqual(saved.genreIDs, [rock, shoegaze])
	}

	func testThePromotedSubgenreCanBeUncheckedAndTheParentStays() throws {
		let model = try deepModel(editing: [shoegaze])

		model.toggleSubgenre(shoegaze, of: rock)

		XCTAssertEqual(model.makeDraft().genreIDs, [rock])
		XCTAssertTrue(model.canContinueFromGenres)
	}

	func testPromotedParentsFollowTheExistingOnesInStoredOrder() throws {
		let model = try deepModel(editing: [shoegaze, jazz, bebop])

		XCTAssertEqual(model.selectedParents, [jazz, rock])
		XCTAssertEqual(model.makeDraft().genreIDs, [jazz, rock, shoegaze, bebop])
	}

	func testASubgenreWhoseParentIsAlreadySelectedPromotesNothing() throws {
		let model = try deepModel(editing: [shoegaze, rock])

		XCTAssertEqual(model.selectedParents, [rock])
		XCTAssertEqual(model.makeDraft().genreIDs, [rock, shoegaze])
		XCTAssertEqual(model.droppedGenres, [])
	}

	func testSeveralOrphanSubgenresOfTheSameParentPromoteItOnce() throws {
		let model = try deepModel(editing: [shoegaze, altRock])

		XCTAssertEqual(model.selectedParents, [rock])
		XCTAssertEqual(model.makeDraft().genreIDs, [rock, shoegaze, altRock])
	}

	func testAnOrphanSharedByTwoParentsPromotesOnlyTheFirstOneInTileOrder() throws {
		let model = try deepModel(editing: [neoSoul])

		// "R&B" sorts before "Soul": one deterministic parent, not both.
		XCTAssertEqual(model.selectedParents, [rnb])
		XCTAssertEqual(model.makeDraft().genreIDs, [rnb, neoSoul])
	}

	func testAnOrphanSharedByTwoParentsPromotesNothingWhenOneParentIsSelected() throws {
		let model = try deepModel(editing: [soul, neoSoul])

		XCTAssertEqual(model.selectedParents, [soul])
		XCTAssertEqual(model.makeDraft().genreIDs, [soul, neoSoul])
	}

	func testALevelThreeGenreIsReplacedByItsLevelTwoAncestorAndItsParentIsPromoted() throws {
		let model = try deepModel(editing: [grunge])

		XCTAssertEqual(model.selectedParents, [rock])
		XCTAssertEqual(model.makeDraft().genreIDs, [rock, altRock])
		// The level-3 genre has no tile: it is dropped, and the ancestor that replaces it is not.
		XCTAssertEqual(model.droppedGenres, [grunge])
	}

	func testALevelThreeGenreDoesNotDuplicateAnAncestorAlreadyThere() throws {
		let model = try deepModel(editing: [rock, altRock, grunge])

		XCTAssertEqual(model.makeDraft().genreIDs, [rock, altRock])
		XCTAssertEqual(model.droppedGenres, [grunge])
	}

	func testALevelThreeGenreWithoutAnAncestorInTheTaxonomyIsDropped() throws {
		let orphan = NodeIdentity(rawValue: "genre:orphan-level-3")!
		let model = try deepModel(editing: [jazz, orphan])

		XCTAssertEqual(model.makeDraft().genreIDs, [jazz])
		XCTAssertEqual(model.droppedGenres, [orphan])
	}

	func testAnUnknownGenreIsAbsentFromTheSavedDraftAndListedAsDropped() throws {
		let missing = NodeIdentity(rawValue: "genre:chiptune")!
		let model = try deepModel(editing: [missing, jazz, shoegaze, ambient])

		XCTAssertEqual(model.makeDraft().genreIDs, [jazz, rock, shoegaze])
		// `ambient` exists in the catalog but has neither a tile nor a parent: same rule as an absent genre.
		XCTAssertEqual(model.droppedGenres, [missing, ambient])
	}

	func testAProfileWhoseGenresAreAllUnknownDoesNotMeetTheMinimumAndSaysSo() throws {
		let missing = NodeIdentity(rawValue: "genre:chiptune")!
		let model = try deepModel(editing: [missing, ambient])

		XCTAssertFalse(model.canContinueFromGenres)
		XCTAssertEqual(model.selectedParents, [])
		XCTAssertEqual(model.makeDraft().genreIDs, [])
		XCTAssertEqual(model.droppedGenres, [missing, ambient])
	}

	func testAnEmptyProfileLoadsEmptyWithNothingDropped() throws {
		let model = try deepModel(editing: [])

		XCTAssertFalse(model.canContinueFromGenres)
		XCTAssertEqual(model.makeDraft().genreIDs, [])
		XCTAssertEqual(model.droppedGenres, [])
	}

	func testAProfileCreatedByTheFlowReloadsIdenticallyWithoutParasiticPromotion() throws {
		let taxonomy = try deepTaxonomy()
		let first = OnboardingFlowModel(taxonomy: taxonomy)
		first.toggleParent(rock)
		first.toggleParent(jazz)
		first.toggleParent(soul)
		first.toggleParent(rnb)
		first.toggleSubgenre(shoegaze, of: rock)
		first.toggleSubgenre(neoSoul, of: soul)
		first.toggleSubgenre(bebop, of: jazz)
		let saved = first.makeDraft().genreIDs

		let reloaded = OnboardingFlowModel(taxonomy: taxonomy, editing: profile(saved))

		XCTAssertEqual(reloaded.makeDraft().genreIDs, saved)
		XCTAssertEqual(reloaded.selectedParents, first.selectedParents)
		XCTAssertEqual(reloaded.selectedSubgenreCount, first.selectedSubgenreCount)
		XCTAssertEqual(reloaded.droppedGenres, [])
	}

	func testReloadingTwiceIsStable() throws {
		let taxonomy = try deepTaxonomy()
		let once = OnboardingFlowModel(taxonomy: taxonomy, editing: profile([grunge, neoSoul, ambient]))
		let twice = OnboardingFlowModel(taxonomy: taxonomy, editing: profile(once.makeDraft().genreIDs))

		XCTAssertEqual(twice.makeDraft().genreIDs, once.makeDraft().genreIDs)
		XCTAssertEqual(twice.droppedGenres, [])
	}

	func testAResumedDraftAlsoPromotesTheParentOfAnOrphanSubgenre() throws {
		let flowID = UUID()
		let draft = ProfileDraft(
			version: Profile.version, flowID: flowID, genreIDs: [shoegaze], onboardingStartedRecorded: true)
		let model = OnboardingFlowModel(taxonomy: try deepTaxonomy(), draft: draft)

		XCTAssertEqual(model.makeDraft().genreIDs, [rock, shoegaze])
		XCTAssertEqual(model.makeDraft().flowID, flowID)
	}

	// MARK: - Edit mode and the Genres tab (K.1)

	func testOnlyAModelBuiltFromAProfileIsEditing() throws {
		XCTAssertFalse(try model().isEditing)
		XCTAssertTrue(try model(editing: profile([hipHop])).isEditing)
	}

	func testTheGenresTabShowsTheParentsInTileOrderNotInSelectionOrder() throws {
		// Stored in the order jazz, hip-hop: the tiles read Hip-Hop, Jazz (alphabetical, as in the flow).
		let editing = try model(editing: profile([jazz, hipHop, trap]))

		XCTAssertEqual(editing.selectedParentChoices.map(\.identity), [hipHop, jazz])
	}

	func testTheGenresTabShowsThePromotedParentOfAnOrphanSubgenre() throws {
		// A profile of the flat onboarding can hold a subgenre alone (TRA-442): its parent has a tile here too.
		let editing = try model(editing: profile([bebop]))

		XCTAssertEqual(editing.selectedParentChoices.map(\.identity), [jazz])
		XCTAssertTrue(try model().selectedParentChoices.isEmpty)
	}
}
