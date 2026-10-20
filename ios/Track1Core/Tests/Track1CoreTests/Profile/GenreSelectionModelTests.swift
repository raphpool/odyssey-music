import XCTest

@testable import Track1Core

@MainActor
final class GenreSelectionModelTests: XCTestCase {
	// Same taxonomy as `GenreOnboardingModelTests`. Families are served in the order jazz, hip-hop, rock; the
	// label order (Hip-Hop, Jazz, Rock) differs, so a label sort cannot pass by accident.
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

	private func makeModel(
		editing: Profile? = nil,
		draft: ProfileDraft? = nil
	) throws -> GenreSelectionModel {
		GenreSelectionModel(taxonomy: try taxonomy(), editing: editing, draft: draft)
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

	private func draft(
		_ selection: GenreSelection?,
		flowID: UUID = UUID(),
		started: Bool = false
	) -> ProfileDraft {
		ProfileDraft(
			version: Profile.version, flowID: flowID, genreIDs: [], onboardingStartedRecorded: started,
			selection: selection)
	}

	func testFamilyChoicesAreTheTaxonomyCardsInServedOrder() throws {
		let model = try makeModel()
		let expected = try taxonomy().families

		XCTAssertEqual(model.familyChoices.map(\.id), [jazz, hipHop, rock])
		XCTAssertEqual(model.familyChoices, expected)
		model.toggleSubgenre(trap)
		XCTAssertEqual(model.familyChoices, expected, "ticking must not reorder or filter the cards")
	}

	func testSubgenresAreTheVisibleChipsInServedOrder() throws {
		let model = try makeModel()

		// "Ghost" has no slug in the catalog: it is not a chip.
		XCTAssertEqual(model.subgenres(of: hipHop).map(\.id), [trap, boomBap, drill])
		XCTAssertEqual(model.subgenres(of: jazz).map(\.id), [bebop, coolJazz])
		XCTAssertEqual(model.subgenres(of: rock).map(\.id), [punk])
		XCTAssertTrue(model.subgenres(of: "x").isEmpty)
		XCTAssertTrue(model.subgenres(of: trap).isEmpty, "a genre id is not a family key")
	}

	func testOneSubgenreIsEnoughToContinue() throws {
		let model = try makeModel()
		XCTAssertFalse(model.canContinue)
		model.toggleSubgenre(trap)
		XCTAssertTrue(model.canContinue)
		model.toggleSubgenre(trap)
		XCTAssertFalse(model.canContinue)
	}

	func testUnknownAndInvisibleGenresAreIgnored() throws {
		let model = try makeModel()
		model.toggleSubgenre(ghost)
		model.toggleSubgenre("nope")
		model.toggleSubgenre(hipHop)

		XCTAssertEqual(model.selectedGenres, [])
		XCTAssertFalse(model.isSubgenreSelected(ghost))
		XCTAssertFalse(model.canContinue)
	}

	func testSelectedGenresKeepTickOrderWithoutDuplicates() throws {
		let model = try makeModel()
		model.toggleSubgenre(punk)
		model.toggleSubgenre(trap)
		model.toggleSubgenre(bebop)
		XCTAssertEqual(model.selectedGenres, [punk, trap, bebop])

		model.toggleSubgenre(trap)
		XCTAssertEqual(model.selectedGenres, [punk, bebop])
		XCTAssertFalse(model.isSubgenreSelected(trap))

		model.toggleSubgenre(trap)
		XCTAssertEqual(model.selectedGenres, [punk, bebop, trap])
		XCTAssertTrue(model.isSubgenreSelected(trap))
	}

	func testToggleAllTicksEveryVisibleGenreThenClears() throws {
		let model = try makeModel()
		XCTAssertFalse(model.isAllSelected(of: hipHop))

		model.toggleAll(of: hipHop)
		XCTAssertTrue(model.isAllSelected(of: hipHop))
		XCTAssertEqual(model.selectedCount(of: hipHop), 3)
		XCTAssertFalse(model.isSubgenreSelected(ghost))

		model.toggleAll(of: hipHop)
		XCTAssertFalse(model.isAllSelected(of: hipHop))
		XCTAssertEqual(model.selectedCount(of: hipHop), 0)
	}

	func testTickingEveryChipByHandMakesAllSelectedTrue() throws {
		let model = try makeModel()
		model.toggleSubgenre(trap)
		model.toggleSubgenre(boomBap)
		XCTAssertFalse(model.isAllSelected(of: hipHop))
		model.toggleSubgenre(drill)
		XCTAssertTrue(model.isAllSelected(of: hipHop))
	}

	func testToggleAllCompletesAPartialCardAfterTheGenresAlreadyTicked() throws {
		let model = try makeModel()
		model.toggleSubgenre(drill)

		model.toggleAll(of: hipHop)

		XCTAssertTrue(model.isAllSelected(of: hipHop))
		XCTAssertEqual(model.selectedGenres, [drill, trap, boomBap])
	}

	func testToggleAllOfAnUnknownKeyDoesNothing() throws {
		let model = try makeModel()
		model.toggleSubgenre(punk)
		model.toggleAll(of: "x")

		XCTAssertEqual(model.selectedGenres, [punk])
		XCTAssertFalse(model.isAllSelected(of: "x"))
		XCTAssertEqual(model.selectedCount(of: "x"), 0)
	}

	func testSelectedSubgenreCountIsTheSumOverAllCards() throws {
		let model = try makeModel()
		model.toggleAll(of: hipHop)
		model.toggleSubgenre(bebop)
		model.toggleSubgenre(punk)

		let perCard = model.familyChoices.map { model.selectedCount(of: $0.id) }
		XCTAssertEqual(perCard, [1, 3, 1])
		XCTAssertEqual(model.selectedSubgenreCount, 5)
		XCTAssertEqual(model.selectedSubgenreCount, perCard.reduce(0, +))
	}

	func testSelectedFamiliesFollowTaxonomyOrderNotTickOrder() throws {
		let model = try makeModel()
		XCTAssertEqual(model.selectedFamilies, [])

		model.toggleSubgenre(punk)
		model.toggleSubgenre(bebop)
		XCTAssertEqual(model.selectedFamilies, [jazz, rock])

		model.toggleSubgenre(punk)
		XCTAssertEqual(model.selectedFamilies, [jazz])
	}

	func testSelectedFamilyChoicesAreTheDerivedFamiliesAsCards() throws {
		let model = try makeModel()
		model.toggleSubgenre(punk)
		model.toggleSubgenre(trap)

		let cards = try taxonomy().families
		XCTAssertEqual(model.selectedFamilyChoices, [cards[1], cards[2]])
	}

	func testTheCtaIsContinuerWhenCreatingAndEnregistrerWhenEditing() throws {
		let creating = try makeModel()
		let editing = try makeModel(editing: profile(GenreSelection(families: [jazz], genres: [bebop])))

		XCTAssertEqual(creating.ctaTitle, "Continuer")
		XCTAssertFalse(creating.isEditing)
		XCTAssertEqual(editing.ctaTitle, "Enregistrer")
		XCTAssertTrue(editing.isEditing)
	}

	func testNothingTickedMakesADraftWithoutSelectionKeepingTheFlow() throws {
		let flowID = UUID()
		let model = try makeModel(draft: draft(nil, flowID: flowID, started: true))

		let result = model.makeDraft()

		XCTAssertEqual(result.genreIDs, [])
		XCTAssertNil(result.selection)
		XCTAssertEqual(result.flowID, flowID)
		XCTAssertTrue(result.onboardingStartedRecorded)
		XCTAssertEqual(result.version, Profile.version)
	}

	func testMakeDraftCarriesTheSelectionAndTheGenreIDsDerivedFromIt() throws {
		let model = try makeModel()
		model.toggleSubgenre(trap)
		model.toggleSubgenre(bebop)

		let result = model.makeDraft()

		XCTAssertEqual(result.selection, GenreSelection(families: [jazz, hipHop], genres: [trap, bebop]))
		XCTAssertEqual(result.genreIDs.map(\.rawValue), ["genre:bebop", "genre:trap", "genre:trap-music"])
		XCTAssertFalse(result.onboardingStartedRecorded)
		XCTAssertEqual(model.makeDraft().flowID, result.flowID)
		XCTAssertTrue(result.isValid())
	}

	func testAFamilyAloneIsRestoredWithAllItsVisibleGenres() throws {
		let stored = profile(GenreSelection(families: [rock], genres: []))
		let model = try makeModel(editing: stored)
		let legacy = GenreOnboardingModel(taxonomy: try taxonomy(), editing: stored)

		XCTAssertEqual(model.selectedGenres, [punk])
		XCTAssertTrue(model.isAllSelected(of: rock))
		XCTAssertEqual(model.makeDraft().genreIDs, legacy.makeDraft().genreIDs)
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testATickedGenreNarrowsItsStoredFamilyInsteadOfExpandingIt() throws {
		let model = try makeModel(editing: profile(GenreSelection(families: [hipHop], genres: [boomBap])))

		XCTAssertEqual(model.selectedGenres, [boomBap])
		XCTAssertFalse(model.isAllSelected(of: hipHop))
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testRestoringDiscardsInSilenceWhatTheTaxonomyCannotShow() throws {
		// An unknown family, a family twice, an invisible genre, an unknown genre and a genre twice.
		let stored = GenreSelection(
			families: ["ambient", jazz, jazz], genres: [ghost, "local:nowhere", bebop, bebop])
		let model = try makeModel(editing: profile(stored))

		XCTAssertEqual(model.selectedGenres, [bebop])
		XCTAssertEqual(model.makeDraft().selection, GenreSelection(families: [jazz], genres: [bebop]))
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testAFamilyWhoseOnlyStoredGenreIsInvisibleIsRestoredWhole() throws {
		// Rule 2 looks at the genres that were really ticked: Ghost is not one of them.
		let model = try makeModel(editing: profile(GenreSelection(families: [hipHop], genres: [ghost])))

		XCTAssertEqual(model.selectedGenres, [trap, boomBap, drill])
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testAStoredGenreIsTickedEvenWithoutItsFamilyAndKeepsItsStoredOrder() throws {
		let model = try makeModel(editing: profile(GenreSelection(families: [jazz], genres: [punk, trap, bebop])))

		XCTAssertEqual(model.selectedGenres, [punk, trap, bebop])
		XCTAssertEqual(model.selectedFamilies, [jazz, hipHop, rock])
	}

	func testAV1ProfileWithoutSelectionRestoresAnEmptySelection() throws {
		let model = try makeModel(editing: profile(nil, genreIDs: [try slug("genre:trap")]))

		XCTAssertTrue(model.isEditing)
		XCTAssertEqual(model.selectedGenres, [])
		XCTAssertFalse(model.canContinue)
		XCTAssertNil(model.makeDraft().selection)
		// This taxonomy serves no legacy table, so the v1 slug has no editorial equivalent: it is dropped.
		XCTAssertEqual(model.droppedGenreIDs, [try slug("genre:trap")])
	}

	func testTheResumedDraftWinsOverTheProfileBeingEdited() throws {
		let draftFlowID = UUID()
		let edited = profile(GenreSelection(families: [jazz], genres: [bebop]), flowID: UUID())
		let resumed = draft(GenreSelection(families: [rock], genres: [punk]), flowID: draftFlowID, started: true)
		let model = try makeModel(editing: edited, draft: resumed)

		XCTAssertTrue(model.isEditing)
		XCTAssertEqual(model.selectedGenres, [punk])
		XCTAssertEqual(model.makeDraft().flowID, draftFlowID)
		XCTAssertTrue(model.makeDraft().onboardingStartedRecorded)
	}

	func testAResumedDraftWithoutSelectionFallsBackToTheEditedProfile() throws {
		let draftFlowID = UUID()
		let edited = profile(GenreSelection(families: [jazz], genres: [coolJazz]), flowID: UUID())
		let model = try makeModel(editing: edited, draft: draft(nil, flowID: draftFlowID, started: true))

		XCTAssertEqual(model.selectedGenres, [coolJazz])
		XCTAssertEqual(model.makeDraft().flowID, draftFlowID)
		XCTAssertTrue(model.makeDraft().onboardingStartedRecorded)
	}

	func testAResumedDraftKeepsItsFlowIDItsStartedFlagAndItsTicks() throws {
		let flowID = UUID()
		let resumed = draft(GenreSelection(families: [hipHop], genres: [trap]), flowID: flowID, started: true)
		let model = try makeModel(draft: resumed)

		model.toggleSubgenre(drill)
		let result = model.makeDraft()

		XCTAssertEqual(result.flowID, flowID)
		XCTAssertTrue(result.onboardingStartedRecorded)
		XCTAssertEqual(result.selection, GenreSelection(families: [hipHop], genres: [trap, drill]))
	}

	func testAProfileBuiltFromADraftReloadsIdentically() throws {
		let first = try makeModel()
		first.toggleSubgenre(drill)
		first.toggleSubgenre(punk)
		first.toggleSubgenre(trap)
		first.toggleSubgenre(bebop)
		let saved = first.makeDraft()
		let stored = profile(saved.selection, genreIDs: saved.genreIDs, flowID: saved.flowID)

		let reloaded = try makeModel(editing: stored)

		XCTAssertEqual(reloaded.selectedGenres, [drill, punk, trap, bebop])
		XCTAssertEqual(reloaded.makeDraft(), saved)
	}

	func testReloadingTwiceIsStable() throws {
		let messy = GenreSelection(families: ["ambient", hipHop, jazz], genres: [ghost, coolJazz, trap, punk])
		let once = try makeModel(editing: profile(messy))
		let twice = try makeModel(editing: profile(once.makeDraft().selection))

		XCTAssertEqual(once.selectedGenres, [coolJazz, trap, punk])
		XCTAssertEqual(twice.selectedGenres, once.selectedGenres)
		XCTAssertEqual(twice.makeDraft().selection, once.makeDraft().selection)
		XCTAssertEqual(twice.makeDraft().genreIDs, once.makeDraft().genreIDs)
	}

	func testARestoredFamilyAloneIsAFixedPointAfterOneSave() throws {
		let once = try makeModel(editing: profile(GenreSelection(families: [jazz], genres: [])))
		let saved = once.makeDraft()
		let twice = try makeModel(editing: profile(saved.selection, genreIDs: saved.genreIDs))

		XCTAssertEqual(saved.selection, GenreSelection(families: [jazz], genres: [bebop, coolJazz]))
		XCTAssertEqual(twice.selectedGenres, once.selectedGenres)
		XCTAssertEqual(twice.makeDraft().genreIDs, saved.genreIDs)
	}
}
