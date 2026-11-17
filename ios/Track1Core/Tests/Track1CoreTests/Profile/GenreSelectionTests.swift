import XCTest

@testable import Track1Core

final class GenreSelectionTests: XCTestCase {
	/// Electronic holds a two-slug genre (Techno) so that multi-slug contribution is observable; Rock and
	/// Jazz exist so a selection can leave a family out. Slugs are served out of alphabetical order so the
	/// sort cannot pass by accident.
	private func taxonomy() throws -> EditorialGenreTaxonomy {
		let catalog = try EditorialFixture.catalog(
			nodes: [
				("genre:techno", "Techno"), ("genre:detroit-techno", "Detroit techno"),
				("genre:house", "House"), ("genre:drum-and-bass", "Drum and bass"),
				("genre:punk-rock", "Punk rock"), ("genre:bebop", "Bebop"),
			],
			edges: [],
			families: [
				(key: "electronic", label: "Electronic", order: 1),
				(key: "rock", label: "Rock", order: 2),
				(key: "jazz", label: "Jazz", order: 3),
			],
			genres: [
				(
					id: "Q11399", name: "Techno", family: "electronic",
					slugs: ["genre:techno", "genre:detroit-techno"]
				),
				(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house"]),
				(id: "Q1003", name: "Drum & Bass", family: "electronic", slugs: ["genre:drum-and-bass"]),
				(id: "Q3071", name: "Punk", family: "rock", slugs: ["genre:punk-rock"]),
				(id: "Q8341", name: "Bebop", family: "jazz", slugs: ["genre:bebop"]),
			]
		)
		return try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
	}

	private func derived(_ selection: GenreSelection) throws -> [String] {
		selection.derivedGenreIDs(in: try taxonomy()).map(\.rawValue)
	}

	// MARK: Derivation

	func testAFamilyAloneContributesTheSlugsOfAllItsVisibleGenres() throws {
		let result = try derived(GenreSelection(families: ["electronic"], genres: []))
		XCTAssertEqual(
			result, ["genre:detroit-techno", "genre:drum-and-bass", "genre:house", "genre:techno"])
	}

	func testExplicitGenresRestrictTheFamilyToTheirOwnSlugs() throws {
		let result = try derived(GenreSelection(families: ["electronic"], genres: ["Q10413", "Q1003"]))
		XCTAssertEqual(result, ["genre:drum-and-bass", "genre:house"])
	}

	func testAGenreWithSeveralSlugsContributesAllOfThem() throws {
		let result = try derived(GenreSelection(families: ["electronic"], genres: ["Q11399"]))
		XCTAssertEqual(result, ["genre:detroit-techno", "genre:techno"])
	}

	func testTheFamilyOwnSlugIsNeverAdded() throws {
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:rock", "Rock"), ("genre:punk-rock", "Punk rock")],
			edges: [],
			families: [(key: "rock", label: "Rock", order: 1)],
			genres: [(id: "Q3071", name: "Punk", family: "rock", slugs: ["genre:punk-rock"])]
		)
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
		let result = GenreSelection(families: ["rock"], genres: []).derivedGenreIDs(in: taxonomy)
		XCTAssertEqual(result.map(\.rawValue), ["genre:punk-rock"])
	}

	func testEachFamilyAppliesTheRuleIndependently() throws {
		// Rock is chosen alone (all its genres); Electronic is restricted to House.
		let result = try derived(GenreSelection(families: ["rock", "electronic"], genres: ["Q10413"]))
		XCTAssertEqual(result, ["genre:house", "genre:punk-rock"])
	}

	// MARK: Ignored input

	func testAGenreOfAnUnselectedFamilyContributesNothing() throws {
		// Q3071 belongs to rock, which is not selected; Electronic has no explicit genre, so it stays whole.
		let result = try derived(GenreSelection(families: ["electronic"], genres: ["Q3071"]))
		XCTAssertEqual(
			result, ["genre:detroit-techno", "genre:drum-and-bass", "genre:house", "genre:techno"])
	}

	func testAnUnknownGenreIDDoesNotRestrictTheFamily() throws {
		let result = try derived(GenreSelection(families: ["rock"], genres: ["Q0000", "local:nowhere"]))
		XCTAssertEqual(result, ["genre:punk-rock"])
	}

	func testAnUnknownFamilyContributesNothing() throws {
		XCTAssertEqual(try derived(GenreSelection(families: ["metal"], genres: ["Q10413"])), [])
		XCTAssertEqual(try derived(GenreSelection(families: ["metal", "jazz"], genres: [])), ["genre:bebop"])
	}

	func testTheResultIsDeduplicatedAndSortedByRawValue() throws {
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:house", "House"), ("genre:acid-house", "Acid house"), ("genre:garage", "Garage")],
			edges: [],
			families: [
				(key: "electronic", label: "Electronic", order: 1), (key: "club", label: "Club", order: 2),
			],
			genres: [
				(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house", "genre:acid-house"]),
				// Shares genre:house with the genre above, across families.
				(id: "Q1234", name: "Club house", family: "club", slugs: ["genre:house", "genre:garage"]),
			]
		)
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
		let result = GenreSelection(families: ["electronic", "club"], genres: []).derivedGenreIDs(in: taxonomy)
		XCTAssertEqual(result.map(\.rawValue), ["genre:acid-house", "genre:garage", "genre:house"])
	}

	// MARK: Validity

	func testValidity() {
		XCTAssertTrue(GenreSelection(families: ["rock"], genres: []).isValid())
		XCTAssertTrue(GenreSelection(families: ["rock", "jazz"], genres: ["Q1", "Q2"]).isValid())
		XCTAssertFalse(GenreSelection(families: [], genres: []).isValid())
		XCTAssertFalse(GenreSelection(families: [], genres: ["Q1"]).isValid())
		XCTAssertFalse(GenreSelection(families: ["rock", "rock"], genres: []).isValid())
		XCTAssertFalse(GenreSelection(families: ["rock"], genres: ["Q1", "Q1"]).isValid())
	}

	// MARK: Profile and draft

	private let flowID = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
	private let localID = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!

	private func profile(selection: GenreSelection? = nil) -> Profile {
		Profile(
			version: Profile.version, localID: localID, genreIDs: [], revision: 1,
			onboardingCompleted: true, flowID: flowID, createdAt: Date(timeIntervalSince1970: 0),
			displayName: "Raph", disc: .mint, selection: selection)
	}

	private func draft(selection: GenreSelection? = nil) -> ProfileDraft {
		ProfileDraft(
			version: Profile.version, flowID: flowID, genreIDs: [], onboardingStartedRecorded: false,
			selection: selection)
	}

	private func jsonObject(_ value: some Encodable) throws -> [String: Any] {
		let data = try JSONEncoder().encode(value)
		return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
	}

	func testProfileRoundTripsWithASelection() throws {
		let original = profile(selection: GenreSelection(families: ["rock"], genres: ["Q3071"]))
		let decoded = try JSONDecoder().decode(Profile.self, from: JSONEncoder().encode(original))
		XCTAssertEqual(decoded, original)
		let selection = try XCTUnwrap(try jsonObject(original)["selection"] as? [String: Any])
		XCTAssertEqual(selection["families"] as? [String], ["rock"])
		XCTAssertEqual(selection["genres"] as? [String], ["Q3071"])
	}

	func testProfileWithoutSelectionOmitsTheKeyAndDecodesToNil() throws {
		let original = profile()
		XCTAssertNil(try jsonObject(original)["selection"])
		let decoded = try JSONDecoder().decode(Profile.self, from: JSONEncoder().encode(original))
		XCTAssertNil(decoded.selection)
		XCTAssertEqual(decoded, original)
	}

	func testAProfileWrittenBeforeSelectionExistedStillDecodes() throws {
		let legacy = """
			{"version":\(Profile.version),"local_id":"\(localID.uuidString)","genre_ids":["genre:house"],\
			"revision":2,"onboarding_completed":true,"flow_id":"\(flowID.uuidString)","created_at":0,\
			"display_name":"Raph","disc":"mint"}
			"""
		let decoded = try JSONDecoder().decode(Profile.self, from: Data(legacy.utf8))
		XCTAssertNil(decoded.selection)
		XCTAssertEqual(decoded.genreIDs.map(\.rawValue), ["genre:house"])
		XCTAssertTrue(decoded.isValid())
	}

	func testADraftWrittenBeforeSelectionExistedStillDecodes() throws {
		let legacy = """
			{"version":\(Profile.version),"flow_id":"\(flowID.uuidString)","genre_ids":["genre:house"],\
			"onboarding_started_recorded":true}
			"""
		let decoded = try JSONDecoder().decode(ProfileDraft.self, from: Data(legacy.utf8))
		XCTAssertNil(decoded.selection)
		XCTAssertTrue(decoded.isValid())
	}

	func testDraftRoundTripsWithAndWithoutSelection() throws {
		let withSelection = draft(selection: GenreSelection(families: ["jazz"], genres: []))
		for original in [draft(), withSelection] {
			let decoded = try JSONDecoder().decode(ProfileDraft.self, from: JSONEncoder().encode(original))
			XCTAssertEqual(decoded, original)
		}
		XCTAssertNil(try jsonObject(draft())["selection"])
		XCTAssertNotNil(try jsonObject(withSelection)["selection"])
	}

	func testProfileValidityFollowsTheSelection() {
		XCTAssertTrue(profile().isValid())
		XCTAssertTrue(profile(selection: GenreSelection(families: ["rock"], genres: [])).isValid())
		XCTAssertFalse(profile(selection: GenreSelection(families: [], genres: [])).isValid())
		XCTAssertFalse(profile(selection: GenreSelection(families: ["rock", "rock"], genres: [])).isValid())
	}

	func testDraftValidityFollowsTheSelection() {
		XCTAssertTrue(draft().isValid())
		XCTAssertTrue(draft(selection: GenreSelection(families: ["rock"], genres: ["Q3071"])).isValid())
		XCTAssertFalse(draft(selection: GenreSelection(families: [], genres: [])).isValid())
		XCTAssertFalse(draft(selection: GenreSelection(families: ["rock"], genres: ["Q1", "Q1"])).isValid())
	}
}
