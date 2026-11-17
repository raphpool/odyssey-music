import XCTest

@testable import Track1Core

/// 2026-11-16 (TRA-757 and TRA-712, decision Q12): `ProfileStore` reads neither `profile.v1.json` nor
/// `profile.v2.json`, so an old profile never reaches the model. The restore below is kept, and still tested,
/// until TRA-759 removes it after TestFlight; the last test pins that an old file does not get to it.
/// A profile with no selection has only the `genre:*` slugs chosen in the old tree.
/// `GenreSelectionModel` rebuilds the ticked genres from them through the served `legacySelectionBySlug`
/// table. Ported from `GenreOnboardingLegacyRestoreTests`: the two rules the single-level model no longer
/// has ("ids cover one family: family alone" and "family slug beside a subgenre slug: subgenre only") are
/// gone (plan D2), so the tests that covered them now expect the whole family and the union, and say so.
@MainActor
final class GenreSelectionModelLegacyRestoreTests: XCTestCase {
	private let rock = "rock"
	private let electronic = "electronic"
	private let jazz = "jazz"

	private let progRock = "Q49451"
	private let punk = "Q3071"
	private let hardRock = "Q83270"
	private let techno = "Q11399"
	private let house = "Q10413"
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
			createdAt: Date(timeIntervalSince1970: 0),
			displayName: "Raph",
			disc: .mint,
			selection: nil
		)
	}

	private func model(
		v1 slugs: [String],
		draft: ProfileDraft? = nil
	) throws -> GenreSelectionModel {
		GenreSelectionModel(taxonomy: try taxonomy(), editing: try v1Profile(slugs), draft: draft)
	}

	// MARK: - A family slug ticks the whole family (was: the family alone)

	func testAFamilySlugTicksEveryVisibleGenreOfTheFamily() throws {
		let model = try model(v1: ["genre:rock"])

		// `Q9999` is listed by the table but invisible: it is filtered out, not ticked.
		XCTAssertEqual(model.selectedGenres, [progRock, punk, hardRock])
		XCTAssertTrue(model.isAllSelected(of: rock))
		XCTAssertEqual(model.selectedFamilies, [rock])
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testAFamilySlugKeepsEveryVisibleSlugOfTheFamilyInTheDraft() throws {
		let draft = try model(v1: ["genre:rock"]).makeDraft()

		// A family alone writes every visible slug of the family to `genre_ids`: nothing is lost on save.
		XCTAssertEqual(
			draft.genreIDs,
			try ["genre:hard-rock", "genre:prog", "genre:progressive-rock", "genre:punk-rock"].map(slug))
		XCTAssertEqual(draft.selection, GenreSelection(families: [rock], genres: [progRock, punk, hardRock]))
	}

	func testAFamilyWithASingleVisibleGenreIsCompleteOnceThatGenreIsTicked() throws {
		// Was "selected as a family": jazz has one visible genre, so ticking it completes the card.
		let model = try model(v1: ["genre:bebop"])

		XCTAssertEqual(model.selectedGenres, [bebop])
		XCTAssertTrue(model.isAllSelected(of: jazz))
		XCTAssertEqual(model.selectedFamilies, [jazz])
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	// MARK: - A genre slug ticks its genre

	func testASubgenreSlugTicksItsGenreAlone() throws {
		let model = try model(v1: ["genre:progressive-rock"])

		XCTAssertEqual(model.selectedGenres, [progRock])
		XCTAssertEqual(model.selectedFamilies, [rock])
		XCTAssertFalse(model.isAllSelected(of: rock))
		XCTAssertEqual(model.makeDraft().selection, GenreSelection(families: [rock], genres: [progRock]))
	}

	func testAFamilySlugBesideASubgenreSlugKeepsTheUnion() throws {
		// Was "keeps only the subgenre": the restriction is gone on purpose (plan D2, decided 2026-10-19).
		let model = try model(v1: ["genre:rock", "genre:progressive-rock"])

		XCTAssertEqual(model.selectedGenres, [progRock, punk, hardRock])
		XCTAssertTrue(model.isAllSelected(of: rock))
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testTheStoredOrderOfAFamilySlugAndASubgenreSlugOnlyChangesTheTickOrder() throws {
		let model = try model(v1: ["genre:progressive-rock", "genre:rock"])

		// The subgenre comes first, then what the family slug adds: the same set as the other order.
		XCTAssertEqual(model.selectedGenres, [progRock, punk, hardRock])
		XCTAssertTrue(model.isAllSelected(of: rock))
	}

	func testASlugMappedToTwoFamiliesTicksBothGenres() throws {
		let model = try model(v1: ["genre:synth-punk"])

		XCTAssertEqual(model.selectedGenres, [punk, techno])
		XCTAssertEqual(model.selectedFamilies, [rock, electronic])
	}

	func testSelectedFamiliesFollowTheTaxonomyOrderNotTheStoredOrder() throws {
		// Taxonomy order is rock, electronic, jazz; the profile names electronic first.
		let model = try model(v1: ["genre:techno", "genre:ghost-only", "genre:bebop", "genre:punk-rock"])

		XCTAssertEqual(model.selectedGenres, [techno, bebop, punk])
		XCTAssertEqual(model.selectedFamilies, [rock, electronic, jazz])
	}

	func testTwoSlugsLeadingToTheSameGenreTickItOnce() throws {
		let model = try model(v1: ["genre:progressive-rock", "genre:prog"])

		XCTAssertEqual(model.selectedGenres, [progRock])
		XCTAssertEqual(model.selectedFamilies, [rock])
	}

	func testAWholeFamilyAfterAGenreOfAnotherFamilyKeepsBoth() throws {
		let model = try model(v1: ["genre:progressive-rock", "genre:electronic"])

		XCTAssertEqual(model.selectedGenres, [progRock, techno, house])
		XCTAssertEqual(model.selectedFamilies, [rock, electronic])
		XCTAssertTrue(model.isAllSelected(of: electronic))
		XCTAssertFalse(model.isAllSelected(of: rock))
	}

	// MARK: - Dropped slugs

	func testASlugAbsentFromTheTableIsDroppedAndNothingElseChanges() throws {
		let model = try model(v1: ["genre:vaporwave", "genre:progressive-rock"])

		XCTAssertEqual(model.droppedGenreIDs, [try slug("genre:vaporwave")])
		XCTAssertEqual(model.selectedGenres, [progRock])
		XCTAssertEqual(model.makeDraft().selection, GenreSelection(families: [rock], genres: [progRock]))
	}

	func testAnUnknownSlugAloneLeavesAnEmptySelection() throws {
		let model = try model(v1: ["genre:unknown"])

		XCTAssertEqual(model.selectedGenres, [])
		XCTAssertEqual(model.droppedGenreIDs, [try slug("genre:unknown")])
		XCTAssertFalse(model.canContinue)
	}

	func testASlugWhoseGenresAreAllInvisibleIsDropped() throws {
		let model = try model(v1: ["genre:ghost-only"])

		XCTAssertEqual(model.selectedGenres, [])
		XCTAssertEqual(model.droppedGenreIDs, [try slug("genre:ghost-only")])
		XCTAssertEqual(model.selectedFamilies, [])
		XCTAssertFalse(model.canContinue)
		XCTAssertNil(model.makeDraft().selection)
	}

	func testARepeatedUnresolvedSlugIsListedOnceAndDoesNotHideTheOthers() throws {
		let model = try model(v1: ["genre:unknown", "genre:bebop", "genre:unknown"])

		XCTAssertEqual(model.selectedGenres, [bebop])
		XCTAssertEqual(model.droppedGenreIDs, [try slug("genre:unknown")])
	}

	func testDroppedSlugsKeepTheStoredOrder() throws {
		let model = try model(v1: ["genre:ghost-only", "genre:unknown"])

		XCTAssertEqual(model.droppedGenreIDs, try ["genre:ghost-only", "genre:unknown"].map(slug))
	}

	// MARK: - An edit, even when empty

	func testARestoredV1ProfileIsStillAnEditAndEndsOnSave() throws {
		let model = try model(v1: ["genre:progressive-rock"])

		XCTAssertTrue(model.isEditing)
		XCTAssertEqual(model.ctaTitle, "Enregistrer")
	}

	func testAV1ProfileWithoutAnyGenreLoadsEmpty() throws {
		let model = try model(v1: [])

		XCTAssertEqual(model.selectedGenres, [])
		XCTAssertEqual(model.droppedGenreIDs, [])
		XCTAssertFalse(model.canContinue)
		XCTAssertTrue(model.isEditing)
		XCTAssertEqual(model.ctaTitle, "Enregistrer")
	}

	// MARK: - Where the rules do not apply

	func testAV2ProfileDoesNotGoThroughTheRulesAndDropsNothing() throws {
		let v2 = Profile(
			version: Profile.version,
			localID: UUID(),
			genreIDs: [try slug("genre:rock"), try slug("genre:unknown")],
			revision: 3,
			onboardingCompleted: true,
			flowID: UUID(),
			createdAt: Date(timeIntervalSince1970: 0),
			displayName: "Raph",
			disc: .mint,
			selection: GenreSelection(families: [jazz], genres: [bebop])
		)
		let model = GenreSelectionModel(taxonomy: try taxonomy(), editing: v2)

		XCTAssertEqual(model.selectedGenres, [bebop])
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testADraftWithoutSelectionAndNoProfileIsNeverReadAsV1() throws {
		let draft = ProfileDraft(
			version: Profile.version, flowID: UUID(), genreIDs: [try slug("genre:rock")],
			onboardingStartedRecorded: true)
		let model = GenreSelectionModel(taxonomy: try taxonomy(), draft: draft)

		XCTAssertEqual(model.selectedGenres, [])
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	func testADraftWithoutSelectionBesideAV1ProfileLeavesTheRulesToTheProfile() throws {
		// A draft is not a profile: it never reads as v1, so the profile is the v1 and the rules apply to it.
		let draft = ProfileDraft(
			version: Profile.version, flowID: UUID(), genreIDs: [try slug("genre:bebop")],
			onboardingStartedRecorded: true)
		let model = try model(v1: ["genre:progressive-rock", "genre:unknown"], draft: draft)

		XCTAssertEqual(model.selectedGenres, [progRock])
		XCTAssertEqual(model.droppedGenreIDs, [try slug("genre:unknown")])
	}

	func testADraftSelectionWinsOverTheV1Profile() throws {
		let draft = ProfileDraft(
			version: Profile.version, flowID: UUID(), genreIDs: [], onboardingStartedRecorded: true,
			selection: GenreSelection(families: [jazz], genres: [bebop]))
		let model = try model(v1: ["genre:rock", "genre:unknown"], draft: draft)

		XCTAssertEqual(model.selectedGenres, [bebop])
		XCTAssertEqual(model.droppedGenreIDs, [])
	}

	// MARK: - Fixed point

	func testTheRebuiltSelectionIsAFixedPointOfTheV2Restore() throws {
		let first = try model(v1: ["genre:rock", "genre:bebop"])
		let draft = first.makeDraft()
		let saved = Profile(
			version: Profile.version,
			localID: UUID(),
			genreIDs: draft.genreIDs,
			revision: 4,
			onboardingCompleted: true,
			flowID: UUID(),
			createdAt: Date(timeIntervalSince1970: 0),
			displayName: "Raph",
			disc: .mint,
			selection: draft.selection
		)
		let reloaded = GenreSelectionModel(taxonomy: try taxonomy(), editing: saved)

		XCTAssertEqual(first.selectedGenres, [progRock, punk, hardRock, bebop])
		XCTAssertEqual(reloaded.selectedGenres, first.selectedGenres)
		XCTAssertEqual(reloaded.makeDraft().selection, draft.selection)
		XCTAssertEqual(reloaded.makeDraft().genreIDs, draft.genreIDs)
		XCTAssertEqual(reloaded.droppedGenreIDs, [])
	}

	// MARK: - An old profile file never reaches the model

	func testAnOldProfileFileNeverReachesTheModel() async throws {
		let directory = FileManager.default.temporaryDirectory.appending(
			path: UUID().uuidString, directoryHint: .isDirectory)
		defer { try? FileManager.default.removeItem(at: directory) }
		let localStore = LocalStore(directoryURL: directory)
		let old =
			#"{"version":2,"local_id":"\#(UUID())","genre_ids":[],"revision":3,"#
			+ #""onboarding_completed":true,"flow_id":"\#(UUID())"}"#
		for name in ["profile.v1.json", "profile.v2.json"] {
			_ = await localStore.write(Data(old.utf8), named: name)
		}

		let read = await ProfileStore(localStore: localStore).read()
		XCTAssertEqual(read, .missing)
		// What the app does with the read: a v1 read back as a profile would put the model in edit mode.
		var editing: Profile?
		if case .profile(let profile) = read { editing = profile }
		let model = GenreSelectionModel(taxonomy: try taxonomy(), editing: editing)
		XCTAssertFalse(model.isEditing)
		XCTAssertEqual(model.selectedGenres, [])
	}
}
