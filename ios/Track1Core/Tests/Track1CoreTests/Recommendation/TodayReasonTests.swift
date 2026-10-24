import XCTest

@testable import Track1Core

final class TodayReasonTests: XCTestCase {
	private typealias GenreRow = (id: String, name: String, slugs: [String])

	private static let rows: [GenreRow] = [
		(id: "Q1", name: "Ambient", slugs: ["genre:ambient"]),
		(id: "Q2", name: "IDM", slugs: ["genre:idm"]),
		(id: "Q3", name: "Glitch", slugs: ["genre:glitch"]),
		(id: "Q4", name: "Dub", slugs: ["genre:dub"]),
	]

	/// A taxonomy whose genres are all visible, `rows` in the order given.
	private func taxonomy(_ rows: [GenreRow] = TodayReasonTests.rows) throws -> EditorialGenreTaxonomy {
		let catalog = try EditorialFixture.catalog(
			nodes: rows.flatMap { row in row.slugs.map { ($0, "Node \($0)") } },
			edges: [],
			families: [(key: "electronic", label: "Electronic", order: 1)],
			genres: rows.map { (id: $0.id, name: $0.name, family: "electronic", slugs: $0.slugs) })
		return try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
	}

	private func selection(_ genres: [String]) -> GenreSelection {
		GenreSelection(families: ["electronic"], genres: genres)
	}

	// MARK: Names

	func testNamesFollowTheTickOrderAndStopAtThree() throws {
		let names = TodayReason.genreNames(
			selection: selection(["Q2", "Q1", "Q3", "Q4"]), taxonomy: try taxonomy())

		XCTAssertEqual(names, ["IDM", "Ambient", "Glitch"])
	}

	func testTheCapIsThree() {
		XCTAssertEqual(TodayReason.maxGenres, 3)
	}

	func testFewerThanThreeGenresAreAllKept() throws {
		let names = TodayReason.genreNames(selection: selection(["Q3", "Q4"]), taxonomy: try taxonomy())

		XCTAssertEqual(names, ["Glitch", "Dub"])
	}

	func testAnUnknownIDIsSkippedWithoutShiftingTheOthers() throws {
		let names = TodayReason.genreNames(
			selection: selection(["Q2", "local:ghost", "Q1", "Q3", "Q4"]), taxonomy: try taxonomy())

		XCTAssertEqual(names, ["IDM", "Ambient", "Glitch"])
	}

	func testABlankNameIsSkipped() throws {
		let rows: [GenreRow] = [
			(id: "Q1", name: "   ", slugs: ["genre:ambient"]),
			(id: "Q2", name: "IDM", slugs: ["genre:idm"]),
			(id: "Q3", name: "\t", slugs: ["genre:glitch"]),
			(id: "Q4", name: "Dub", slugs: ["genre:dub"]),
		]
		let names = TodayReason.genreNames(
			selection: selection(["Q1", "Q2", "Q3", "Q4"]), taxonomy: try taxonomy(rows))

		XCTAssertEqual(names, ["IDM", "Dub"])
	}

	func testNamesAreTrimmed() throws {
		let rows: [GenreRow] = [(id: "Q1", name: "  Ambient \n", slugs: ["genre:ambient"])]
		let names = TodayReason.genreNames(selection: selection(["Q1"]), taxonomy: try taxonomy(rows))

		XCTAssertEqual(names, ["Ambient"])
	}

	func testAGenreWithoutAnyPresentSlugIsNotInTheTaxonomy() throws {
		// The taxonomy lists Q9 but the catalog holds none of its slugs: it is invisible, so it has no name.
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:ambient", "Ambient")],
			edges: [],
			families: [(key: "electronic", label: "Electronic", order: 1)],
			genres: [
				(id: "Q1", name: "Ambient", family: "electronic", slugs: ["genre:ambient"]),
				(id: "Q9", name: "Hidden", family: "electronic", slugs: ["genre:hidden"]),
			])
		let names = TodayReason.genreNames(
			selection: selection(["Q9", "Q1"]), taxonomy: EditorialGenreTaxonomy(catalog: catalog))

		XCTAssertEqual(names, ["Ambient"])
	}

	func testNoSelectionGivesNoName() throws {
		XCTAssertEqual(TodayReason.genreNames(selection: nil, taxonomy: try taxonomy()), [])
	}

	func testNoTaxonomyGivesNoName() {
		XCTAssertEqual(TodayReason.genreNames(selection: selection(["Q1", "Q2"]), taxonomy: nil), [])
	}

	func testAnEmptyGenreListGivesNoName() throws {
		XCTAssertEqual(TodayReason.genreNames(selection: selection([]), taxonomy: try taxonomy()), [])
	}

	// MARK: Copy

	func testTheLineJoinsThreeNames() {
		XCTAssertEqual(
			TodayReasonCopy.line(genreNames: ["IDM", "Glitch", "Ambient"]),
			"parce que tu explores IDM - Glitch - Ambient")
	}

	func testTheLineHasNoSeparatorForASingleName() {
		XCTAssertEqual(TodayReasonCopy.line(genreNames: ["IDM"]), "parce que tu explores IDM")
	}

	func testNoNameGivesNoLine() {
		XCTAssertNil(TodayReasonCopy.line(genreNames: []))
	}

	func testTheSeparatorIsASpaceAHyphenMinusAndASpace() {
		XCTAssertEqual(
			TodayReasonCopy.separator.unicodeScalars.map(\.value), [0x0020, 0x002D, 0x0020])
	}
}
