import XCTest

@testable import Track1Core

@MainActor
final class GenreOnboardingModelTests: XCTestCase {
	// Families, served in the order jazz, hip-hop, rock. The label order (Hip-Hop, Jazz, Rock) differs, so a
	// label sort cannot pass by accident.
	private let hipHop = "hip-hop"
	private let jazz = "jazz"
	private let rock = "rock"

	private let trap = "Q2133"
	private let boomBap = "Q1118"
	private let drill = "local:drill"
	private let bebop = "Q8341"
	private let coolJazz = "Q1013"
	private let punk = "Q3071"
	private let ghost = "Q9999"

	private func slug(_ raw: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: raw))
	}

	/// `trap` has two slugs and `ghost` (hip-hop) has none in the catalog, so it is not shown.
	private func taxonomy() throws -> EditorialGenreTaxonomy {
		let catalog = try EditorialFixture.catalog(
			nodes: [
				("genre:trap", "Trap"), ("genre:trap-music", "Trap music"), ("genre:boom-bap", "Boom bap"),
				("genre:drill", "Drill"), ("genre:bebop", "Bebop"), ("genre:cool-jazz", "Cool jazz"),
				("genre:punk-rock", "Punk rock"),
			],
			edges: [],
			families: [
				(key: "hip-hop", label: "Hip-Hop", order: 2),
				(key: "jazz", label: "Jazz", order: 1),
				(key: "rock", label: "Rock", order: 3),
			],
			genres: [
				(id: "Q2133", name: "Trap", family: "hip-hop", slugs: ["genre:trap", "genre:trap-music"]),
				(id: "Q1118", name: "Boom bap", family: "hip-hop", slugs: ["genre:boom-bap"]),
				(id: "local:drill", name: "Drill", family: "hip-hop", slugs: ["genre:drill"]),
				(id: "Q9999", name: "Ghost", family: "hip-hop", slugs: ["genre:ghost"]),
				(id: "Q8341", name: "Bebop", family: "jazz", slugs: ["genre:bebop"]),
				(id: "Q1013", name: "Cool jazz", family: "jazz", slugs: ["genre:cool-jazz"]),
				(id: "Q3071", name: "Punk", family: "rock", slugs: ["genre:punk-rock"]),
			]
		)
		return try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
	}

	private func model(
		editing: Profile? = nil,
		draft: ProfileDraft? = nil
	) throws -> GenreOnboardingModel {
		GenreOnboardingModel(taxonomy: try taxonomy(), editing: editing, draft: draft)
	}

	private func profile(
		_ selection: GenreSelection?,
		genreIDs: [NodeIdentity] = [],
		flowID: UUID = UUID()
	) -> Profile {
		Profile(
			version: Profile.version,
			localID: UUID(),
			genreIDs: genreIDs,
			revision: 3,
			onboardingCompleted: true,
			flowID: flowID,
			selection: selection
		)
	}

	// MARK: - Families

	func testOneFamilyIsEnoughToContinueFromTheGenres() throws {
		let model = try model()
		XCTAssertFalse(model.canContinueFromGenres)
		model.toggleFamily(hipHop)
		XCTAssertTrue(model.canContinueFromGenres)
		model.toggleFamily(hipHop)
		XCTAssertFalse(model.canContinueFromGenres)
	}

	func testFamilyChoicesAreTheTaxonomyTilesInDisplayOrder() throws {
		let model = try model()
		let expected = try taxonomy().families
		XCTAssertEqual(expected.map(\.id), [jazz, hipHop, rock])
		XCTAssertEqual(model.familyChoices, expected)
		model.toggleFamily(hipHop)
		XCTAssertEqual(model.familyChoices, expected, "selecting must not reorder or filter the tiles")
	}

	func testTogglingAFamilyAppendsItThenRemovesItAndItsExplicitGenres() throws {
		let model = try model()
		model.toggleFamily(rock)
		model.toggleFamily(hipHop)
		model.toggleSubgenre(trap, of: hipHop)
		XCTAssertEqual(model.selectedFamilies, [rock, hipHop])
		XCTAssertTrue(model.isSubgenreSelected(trap))

		model.toggleFamily(hipHop)

		XCTAssertEqual(model.selectedFamilies, [rock])
		XCTAssertFalse(model.isSubgenreSelected(trap))
		XCTAssertEqual(model.selectedSubgenreCount, 0)
	}

	func testAFamilyIgnoresUnknownKeys() throws {
		let model = try model()
		model.toggleFamily("ambient")
		model.toggleFamily(trap)

		XCTAssertEqual(model.selectedFamilies, [])
	}

	func testDeselectingAFamilyRemovesItsGenresOnly() throws {
		let model = try model()
		model.toggleFamily(hipHop)
		model.toggleFamily(jazz)
		model.toggleAll(of: hipHop)
		model.toggleSubgenre(bebop, of: jazz)

		model.toggleFamily(hipHop)

		XCTAssertEqual(model.selectedFamilies, [jazz])
		XCTAssertEqual(model.selectedSubgenreCount, 1)
		XCTAssertEqual(model.makeDraft().selection, GenreSelection(families: [jazz], genres: [bebop]))
	}

	func testSelectedFamilyChoicesFollowTileOrderNotSelectionOrder() throws {
		let model = try model()
		model.toggleFamily(rock)
		model.toggleFamily(hipHop)
		model.toggleFamily(jazz)

		XCTAssertEqual(model.selectedFamilies, [rock, hipHop, jazz])
		XCTAssertEqual(model.selectedFamilyChoices.map(\.id), [jazz, hipHop, rock])
		XCTAssertTrue(try self.model().selectedFamilyChoices.isEmpty)
	}

	func testOnlyAModelBuiltFromAProfileIsEditing() throws {
		XCTAssertFalse(try model().isEditing)
		XCTAssertTrue(try model(editing: profile(GenreSelection(families: [jazz], genres: []))).isEditing)
	}

	// MARK: - Steps and CTA

	func testSubgenreStepsFollowTheSelectionOrderAndTheLastCtaIsTerminer() throws {
		let model = try model()
		model.toggleFamily(jazz)
		model.toggleFamily(hipHop)

		XCTAssertEqual(model.selectedFamilies, [jazz, hipHop])
		XCTAssertEqual(model.subgenreSteps, [jazz, hipHop])
		XCTAssertEqual(model.ctaTitle(forStep: 0), "Continuer")
		XCTAssertEqual(model.ctaTitle(forStep: 1), "Terminer")
	}

	func testTheCtaIsEnregistrerOnTheLastStepWhenEditing() throws {
		let model = try model(editing: profile(GenreSelection(families: [jazz, hipHop], genres: [])))

		XCTAssertEqual(model.ctaTitle(forStep: 0), "Continuer")
		XCTAssertEqual(model.ctaTitle(forStep: 1), "Enregistrer")
	}

	func testTheStepAfterAFamilyIsTheNextOneInSelectionOrder() throws {
		let model = try model()
		model.toggleFamily(rock)
		model.toggleFamily(jazz)
		model.toggleFamily(hipHop)

		XCTAssertEqual(model.subgenreStep(after: rock), jazz)
		XCTAssertEqual(model.subgenreStep(after: jazz), hipHop)
		XCTAssertNil(model.subgenreStep(after: hipHop), "the last step ends the flow")
	}

	func testAFamilyThatIsNotAStepHasNoSuccessor() throws {
		let model = try model()
		model.toggleFamily(jazz)
		model.toggleFamily(hipHop)

		XCTAssertNil(model.subgenreStep(after: rock))
		XCTAssertNil(model.subgenreStep(after: "ambient"))
		XCTAssertNil(try self.model().subgenreStep(after: jazz))
	}

	// MARK: - Genres

	func testSubgenreChoicesAreTheVisibleRowsInServedOrderAndOnlyForASelectedFamily() throws {
		let model = try model()
		XCTAssertEqual(model.subgenreChoices(of: hipHop), [])

		model.toggleFamily(hipHop)

		// "Ghost" has no slug in the catalog: it is not a row.
		XCTAssertEqual(model.subgenreChoices(of: hipHop).map(\.id), [trap, boomBap, drill])
		XCTAssertEqual(model.subgenreChoices(of: jazz), [])
	}

	func testToggleAllSelectsEverythingThenClears() throws {
		let model = try model()
		model.toggleFamily(hipHop)
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
		model.toggleFamily(hipHop)
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

	func testAFamilyWithoutVisibleRowsIsNeverAllSelected() throws {
		XCTAssertFalse(try model().isAllSelected(of: "ambient"))
	}

	func testSubgenresOutsideTheFamilyOrOfAnUnselectedFamilyAreIgnored() throws {
		let model = try model()
		model.toggleFamily(hipHop)
		model.toggleSubgenre(bebop, of: hipHop)
		model.toggleSubgenre(bebop, of: jazz)
		model.toggleSubgenre(ghost, of: hipHop)
		model.toggleAll(of: jazz)

		XCTAssertEqual(model.selectedSubgenreCount, 0)
		XCTAssertFalse(model.isSubgenreSelected(bebop))
	}

	func testTheSelectionSurvivesGoingBack() throws {
		let model = try model()
		model.toggleFamily(hipHop)
		model.toggleFamily(jazz)
		model.toggleSubgenre(trap, of: hipHop)
		model.toggleSubgenre(coolJazz, of: jazz)

		// Going back and forth between steps only reads the model: nothing is reset.
		_ = model.ctaTitle(forStep: 1)
		_ = model.isAllSelected(of: hipHop)
		_ = model.subgenreSteps

		XCTAssertEqual(model.selectedFamilies, [hipHop, jazz])
		XCTAssertEqual(
			model.makeDraft().selection, GenreSelection(families: [hipHop, jazz], genres: [trap, coolJazz]))
	}

	// MARK: - makeDraft

	func testMakeDraftCarriesTheSelectionAndTheGenreIDsDerivedFromIt() throws {
		let model = try model()
		model.toggleFamily(jazz)
		model.toggleFamily(hipHop)
		model.toggleSubgenre(drill, of: hipHop)
		model.toggleSubgenre(bebop, of: jazz)
		model.toggleSubgenre(trap, of: hipHop)

		let draft = model.makeDraft()
		let selection = GenreSelection(families: [jazz, hipHop], genres: [drill, bebop, trap])

		XCTAssertEqual(draft.selection, selection)
		XCTAssertEqual(draft.genreIDs, selection.derivedGenreIDs(in: try taxonomy()))
		// Explicit genres narrow the family down: all slugs of Drill, Bebop and Trap, none of the others.
		XCTAssertEqual(
			draft.genreIDs,
			[try slug("genre:bebop"), try slug("genre:drill"), try slug("genre:trap"), try slug("genre:trap-music")])
		XCTAssertEqual(draft.version, Profile.version)
		XCTAssertFalse(draft.onboardingStartedRecorded)
		XCTAssertEqual(model.makeDraft().flowID, draft.flowID)
		XCTAssertTrue(draft.isValid())
	}

	func testAFamilyAloneMeansAllItsGenres() throws {
		let model = try model()
		model.toggleFamily(jazz)

		let draft = model.makeDraft()

		XCTAssertEqual(draft.selection, GenreSelection(families: [jazz], genres: []))
		XCTAssertEqual(draft.genreIDs, [try slug("genre:bebop"), try slug("genre:cool-jazz")])
		XCTAssertTrue(draft.isValid())
	}

	func testNothingSelectedMakesADraftWithoutSelectionOrGenres() throws {
		let draft = try model().makeDraft()

		XCTAssertNil(draft.selection)
		XCTAssertEqual(draft.genreIDs, [])
		XCTAssertEqual(draft.version, Profile.version)
	}

	// MARK: - Restoring

	func testEditingRestoresExactlyTheSelectionOfAnExistingProfile() throws {
		let selection = GenreSelection(families: [jazz, hipHop], genres: [bebop, trap])
		let flowID = UUID()
		let model = try model(editing: profile(selection, flowID: flowID))

		XCTAssertEqual(model.selectedFamilies, [jazz, hipHop])
		XCTAssertEqual(model.subgenreSteps, [jazz, hipHop])
		XCTAssertEqual(model.selectedSubgenreCount, 2)
		XCTAssertFalse(model.isAllSelected(of: hipHop))
		let draft = model.makeDraft()
		XCTAssertEqual(draft.selection, selection)
		XCTAssertEqual(draft.flowID, flowID)
	}

	func testEditingKeepsAllSelectedForAFullyChosenFamily() throws {
		let model = try model(editing: profile(GenreSelection(families: [hipHop], genres: [trap, boomBap, drill])))

		XCTAssertTrue(model.isAllSelected(of: hipHop))
	}

	func testEditingDiscardsInSilenceWhatTheTaxonomyCannotShow() throws {
		// An unknown family, a family twice, a genre without a visible slug, an unknown genre, and a genre
		// whose family is not selected.
		let stored = GenreSelection(
			families: ["ambient", jazz, jazz], genres: [ghost, "local:nowhere", trap, bebop])
		let model = try model(editing: profile(stored))

		XCTAssertEqual(model.selectedFamilies, [jazz])
		XCTAssertEqual(model.makeDraft().selection, GenreSelection(families: [jazz], genres: [bebop]))
	}

	func testAProfileWhoseFamiliesAreAllUnknownDoesNotMeetTheMinimum() throws {
		let model = try model(editing: profile(GenreSelection(families: ["ambient"], genres: [trap])))

		XCTAssertFalse(model.canContinueFromGenres)
		XCTAssertEqual(model.selectedFamilies, [])
		XCTAssertEqual(model.selectedSubgenreCount, 0)
		XCTAssertNil(model.makeDraft().selection)
	}

	func testAResumedDraftKeepsItsFlowIDItsStartedFlagAndItsSelection() throws {
		let flowID = UUID()
		let resumed = ProfileDraft(
			version: Profile.version,
			flowID: flowID,
			genreIDs: [try slug("genre:trap"), try slug("genre:trap-music")],
			onboardingStartedRecorded: true,
			selection: GenreSelection(families: [hipHop], genres: [trap])
		)
		let model = try model(draft: resumed)

		XCTAssertEqual(model.selectedFamilies, [hipHop])
		XCTAssertEqual(model.selectedSubgenreCount, 1)
		model.toggleSubgenre(drill, of: hipHop)
		let draft = model.makeDraft()
		XCTAssertEqual(draft.flowID, flowID)
		XCTAssertTrue(draft.onboardingStartedRecorded)
		XCTAssertEqual(draft.selection, GenreSelection(families: [hipHop], genres: [trap, drill]))
	}

	func testTheResumedDraftWinsOverTheProfileBeingEdited() throws {
		let editedFlowID = UUID()
		let draftFlowID = UUID()
		let edited = profile(GenreSelection(families: [jazz], genres: []), flowID: editedFlowID)
		let resumed = ProfileDraft(
			version: Profile.version, flowID: draftFlowID, genreIDs: [], onboardingStartedRecorded: true,
			selection: GenreSelection(families: [rock], genres: [punk]))
		let model = try model(editing: edited, draft: resumed)

		XCTAssertTrue(model.isEditing)
		XCTAssertEqual(model.selectedFamilies, [rock])
		XCTAssertEqual(model.makeDraft().flowID, draftFlowID)
	}

	func testAResumedDraftWithoutSelectionFallsBackToTheEditedProfile() throws {
		let resumed = ProfileDraft(
			version: Profile.version, flowID: UUID(), genreIDs: [], onboardingStartedRecorded: false)
		let model = try model(
			editing: profile(GenreSelection(families: [jazz], genres: [coolJazz])), draft: resumed)

		XCTAssertEqual(model.selectedFamilies, [jazz])
		XCTAssertTrue(model.isSubgenreSelected(coolJazz))
	}

	func testAProfileCreatedByTheFlowReloadsIdentically() throws {
		let taxonomy = try taxonomy()
		let first = GenreOnboardingModel(taxonomy: taxonomy)
		first.toggleFamily(rock)
		first.toggleFamily(hipHop)
		first.toggleFamily(jazz)
		first.toggleSubgenre(drill, of: hipHop)
		first.toggleSubgenre(trap, of: hipHop)
		first.toggleSubgenre(bebop, of: jazz)
		let saved = first.makeDraft()
		let stored = profile(saved.selection, genreIDs: saved.genreIDs, flowID: saved.flowID)

		let reloaded = GenreOnboardingModel(taxonomy: taxonomy, editing: stored)

		XCTAssertEqual(reloaded.makeDraft().selection, saved.selection)
		XCTAssertEqual(reloaded.makeDraft().genreIDs, saved.genreIDs)
		XCTAssertEqual(reloaded.selectedFamilies, first.selectedFamilies)
		XCTAssertEqual(reloaded.selectedSubgenreCount, first.selectedSubgenreCount)
		XCTAssertEqual(reloaded.makeDraft().flowID, saved.flowID)
	}

	func testReloadingTwiceIsStable() throws {
		let taxonomy = try taxonomy()
		let messy = GenreSelection(families: ["ambient", hipHop, jazz], genres: [ghost, coolJazz, trap, punk])
		let once = GenreOnboardingModel(taxonomy: taxonomy, editing: profile(messy))
		let twice = GenreOnboardingModel(taxonomy: taxonomy, editing: profile(once.makeDraft().selection))

		XCTAssertEqual(
			once.makeDraft().selection, GenreSelection(families: [hipHop, jazz], genres: [coolJazz, trap]))
		XCTAssertEqual(twice.makeDraft().selection, once.makeDraft().selection)
		XCTAssertEqual(twice.makeDraft().genreIDs, once.makeDraft().genreIDs)
	}
}
