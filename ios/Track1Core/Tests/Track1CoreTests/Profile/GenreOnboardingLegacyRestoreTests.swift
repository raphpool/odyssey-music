import XCTest

@testable import Track1Core

/// A profile read from `profile.v1.json` has no selection, only the `genre:*` slugs chosen in the old tree.
/// `GenreOnboardingModel` rebuilds a selection from them through the served `legacySelectionBySlug` table.
@MainActor
final class GenreOnboardingLegacyRestoreTests: XCTestCase {
	private let rock = "rock"
	private let electronic = "electronic"
	private let jazz = "jazz"

	private let progRock = "Q49451"
	private let punk = "Q3071"
	private let techno = "Q11399"
	private let bebop = "Q8341"

	private func slug(_ raw: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: raw))
	}

	/// `Q9999` is served in the rock family but has no slug in the catalog, so it is not visible: the table
	/// still lists it, and `legacyGenreIDs(for:)` must filter it out before the rules see it.
	private func taxonomy() throws -> EditorialGenreTaxonomy {
		let catalog = try EditorialFixture.catalog(
			nodes: [
				("genre:progressive-rock", "Progressive rock"), ("genre:prog", "Prog"),
				("genre:punk-rock", "Punk rock"), ("genre:hard-rock", "Hard rock"),
				("genre:techno", "Techno"), ("genre:house", "House"), ("genre:bebop", "Bebop"),
			],
			edges: [],
			families: [
				(key: "rock", label: "Rock", order: 1),
				(key: "electronic", label: "Electronic", order: 2),
				(key: "jazz", label: "Jazz", order: 3),
			],
			genres: [
				(
					id: "Q49451", name: "Prog Rock", family: "rock",
					slugs: ["genre:progressive-rock", "genre:prog"]
				),
				(id: "Q3071", name: "Punk", family: "rock", slugs: ["genre:punk-rock"]),
				(id: "Q83270", name: "Hard Rock", family: "rock", slugs: ["genre:hard-rock"]),
				(id: "Q9999", name: "Ghost", family: "rock", slugs: ["genre:ghost"]),
				(id: "Q11399", name: "Techno", family: "electronic", slugs: ["genre:techno"]),
				(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house"]),
				(id: "Q8341", name: "Bebop", family: "jazz", slugs: ["genre:bebop"]),
			],
			legacy: [
				"genre:rock": ["Q49451", "Q3071", "Q83270", "Q9999"],
				"genre:progressive-rock": ["Q49451"],
				"genre:prog": ["Q49451"],
				"genre:synth-punk": ["Q3071", "Q11399"],
				"genre:electronic": ["Q11399", "Q10413"],
				"genre:punk-rock": ["Q3071"],
				"genre:techno": ["Q11399"],
				"genre:bebop": ["Q8341"],
				"genre:ghost-only": ["Q9999"],
			]
		)
		return try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
	}

	private func v1Profile(_ slugs: [String]) throws -> Profile {
		Profile(
			version: Profile.version,
			localID: UUID(),
			genreIDs: try slugs.map(slug),
			revision: 3,
			onboardingCompleted: true,
			flowID: UUID(),
			selection: nil
		)
	}

	private func model(
		v1 slugs: [String],
		draft: ProfileDraft? = nil
	) throws -> GenreOnboardingModel {
		GenreOnboardingModel(taxonomy: try taxonomy(), editing: try v1Profile(slugs), draft: draft)
	}

	// MARK: - Rule 3: the slug covers a whole family

	func testAFamilySlugSelectsTheFamilyAloneWithNoExplicitGenre() throws {
		let model = try model(v1: ["genre:rock"])

		XCTAssertEqual(model.selectedFamilies, [rock])
		XCTAssertEqual(model.selectedSubgenreCount, 0)
		XCTAssertFalse(model.isAllSelected(of: rock))
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testAFamilySlugKeepsEveryVisibleSlugOfTheFamilyInTheDraft() throws {
		let draft = try model(v1: ["genre:rock"]).makeDraft()

		XCTAssertEqual(draft.selection, GenreSelection(families: [rock], genres: []))
		XCTAssertEqual(
			draft.genreIDs,
			try ["genre:hard-rock", "genre:prog", "genre:progressive-rock", "genre:punk-rock"].map(slug))
	}

	func testAFamilyWithASingleVisibleGenreIsSelectedAsAFamily() throws {
		// The rule compares sets, so a family with one visible genre cannot tell the two apart.
		let model = try model(v1: ["genre:bebop"])

		XCTAssertEqual(model.selectedFamilies, [jazz])
		XCTAssertEqual(model.selectedSubgenreCount, 0)
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	// MARK: - Rule 4: explicit genres

	func testASubgenreSlugSelectsItsFamilyAndTheGenreAsExplicit() throws {
		let model = try model(v1: ["genre:progressive-rock"])

		XCTAssertEqual(model.selectedFamilies, [rock])
		XCTAssertEqual(model.selectedSubgenreCount, 1)
		XCTAssertTrue(model.isSubgenreSelected(progRock))
		XCTAssertEqual(model.makeDraft().selection, GenreSelection(families: [rock], genres: [progRock]))
	}

	func testAFamilySlugBesideASubgenreSlugKeepsOnlyTheSubgenre() throws {
		let model = try model(v1: ["genre:rock", "genre:progressive-rock"])

		XCTAssertEqual(model.selectedFamilies, [rock])
		XCTAssertEqual(model.selectedSubgenreCount, 1)
		XCTAssertTrue(model.isSubgenreSelected(progRock))
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testTheStoredOrderOfAFamilySlugAndASubgenreSlugDoesNotChangeTheResult() throws {
		let model = try model(v1: ["genre:progressive-rock", "genre:rock"])

		XCTAssertEqual(model.makeDraft().selection, GenreSelection(families: [rock], genres: [progRock]))
	}

	func testASlugMappedToTwoFamiliesSelectsBothFamiliesAndBothGenres() throws {
		let model = try model(v1: ["genre:synth-punk"])

		XCTAssertEqual(model.selectedFamilies, [rock, electronic])
		XCTAssertEqual(model.selectedSubgenreCount, 2)
		XCTAssertTrue(model.isSubgenreSelected(punk))
		XCTAssertTrue(model.isSubgenreSelected(techno))
	}

	func testSelectedFamiliesFollowTheFirstAppearanceInTheStoredGenreIDs() throws {
		// Taxonomy order is rock, electronic, jazz; the profile names electronic first.
		let model = try model(v1: ["genre:techno", "genre:ghost-only", "genre:bebop", "genre:punk-rock"])

		XCTAssertEqual(model.selectedFamilies, [electronic, jazz, rock])
		XCTAssertEqual(model.subgenreSteps, [electronic, jazz, rock])
	}

	func testTwoSlugsLeadingToTheSameGenreAddItOnce() throws {
		let model = try model(v1: ["genre:progressive-rock", "genre:prog"])

		XCTAssertEqual(model.selectedFamilies, [rock])
		XCTAssertEqual(model.selectedSubgenreCount, 1)
		XCTAssertEqual(model.makeDraft().selection, GenreSelection(families: [rock], genres: [progRock]))
	}

	func testAWholeFamilyAfterAnExplicitGenreOfAnotherFamilyKeepsBoth() throws {
		let model = try model(v1: ["genre:progressive-rock", "genre:electronic"])

		XCTAssertEqual(model.selectedFamilies, [rock, electronic])
		XCTAssertEqual(
			model.makeDraft().selection, GenreSelection(families: [rock, electronic], genres: [progRock]))
	}

	// MARK: - Rule 2: dropped slugs

	func testASlugAbsentFromTheTableIsDroppedAndNothingElseChanges() throws {
		let model = try model(v1: ["genre:vaporwave", "genre:progressive-rock"])

		XCTAssertEqual(model.droppedGenreIDs, [try slug("genre:vaporwave")])
		XCTAssertEqual(model.makeDraft().selection, GenreSelection(families: [rock], genres: [progRock]))
	}

	func testASlugWhoseGenresAreAllInvisibleIsDropped() throws {
		let model = try model(v1: ["genre:ghost-only"])

		XCTAssertEqual(model.droppedGenreIDs, [try slug("genre:ghost-only")])
		XCTAssertEqual(model.selectedFamilies, [])
		XCTAssertFalse(model.canContinueFromGenres)
		XCTAssertNil(model.makeDraft().selection)
	}

	func testDroppedSlugsKeepTheStoredOrder() throws {
		let model = try model(v1: ["genre:zzz", "genre:ghost-only", "genre:aaa"])

		XCTAssertEqual(model.droppedGenreIDs, try ["genre:zzz", "genre:ghost-only", "genre:aaa"].map(slug))
	}

	func testARepeatedUnresolvedSlugIsListedOnce() throws {
		let model = try model(v1: ["genre:zzz", "genre:ghost-only", "genre:zzz"])

		XCTAssertEqual(model.droppedGenreIDs, try ["genre:zzz", "genre:ghost-only"].map(slug))
	}

	func testARestoredV1ProfileIsStillAnEditAndEndsOnSave() throws {
		let model = try model(v1: ["genre:progressive-rock"])

		XCTAssertTrue(model.isEditing)
		XCTAssertEqual(model.ctaTitle(forStep: model.subgenreSteps.count - 1), "Enregistrer")
	}

	func testAV1ProfileWithoutAnyGenreLoadsEmpty() throws {
		let model = try model(v1: [])

		XCTAssertTrue(model.isEditing)
		XCTAssertEqual(model.selectedFamilies, [])
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	// MARK: - Where the rules do not apply

	func testAV2ProfileDoesNotGoThroughTheRulesAndDropsNothing() throws {
		let v2 = Profile(
			version: Profile.version,
			localID: UUID(),
			genreIDs: [try slug("genre:rock"), try slug("genre:vaporwave")],
			revision: 3,
			onboardingCompleted: true,
			flowID: UUID(),
			selection: GenreSelection(families: [jazz], genres: [])
		)
		let model = GenreOnboardingModel(taxonomy: try taxonomy(), editing: v2)

		XCTAssertEqual(model.selectedFamilies, [jazz])
		XCTAssertEqual(model.selectedSubgenreCount, 0)
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testADraftWithoutSelectionAndNoProfileIsNeverReadAsV1() throws {
		let draft = ProfileDraft(
			version: Profile.version, flowID: UUID(), genreIDs: [try slug("genre:rock")],
			onboardingStartedRecorded: true)
		let model = GenreOnboardingModel(taxonomy: try taxonomy(), draft: draft)

		XCTAssertEqual(model.selectedFamilies, [])
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testADraftSelectionWinsOverTheV1Profile() throws {
		let draft = ProfileDraft(
			version: Profile.version, flowID: UUID(), genreIDs: [], onboardingStartedRecorded: true,
			selection: GenreSelection(families: [jazz], genres: [bebop]))
		let model = try model(v1: ["genre:rock"], draft: draft)

		XCTAssertEqual(model.selectedFamilies, [jazz])
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testTheRebuiltSelectionIsAFixedPointOfTheV2Restore() throws {
		let first = try model(v1: ["genre:progressive-rock", "genre:synth-punk", "genre:vaporwave"])
		let draft = first.makeDraft()
		let saved = Profile(
			version: Profile.version,
			localID: UUID(),
			genreIDs: draft.genreIDs,
			revision: 4,
			onboardingCompleted: true,
			flowID: UUID(),
			selection: draft.selection
		)
		let reloaded = GenreOnboardingModel(taxonomy: try taxonomy(), editing: saved)

		XCTAssertEqual(reloaded.selectedFamilies, first.selectedFamilies)
		XCTAssertEqual(reloaded.makeDraft().selection, draft.selection)
		XCTAssertEqual(reloaded.droppedGenreIDs, [])
	}
}
