import XCTest

@testable import Track1Core

/// E.2 (TRA-392): the pure parts of the edge chip, read from Figma `171:96` and doc `171:100` on 2026-10-13.
final class EdgeChipFormatTests: XCTestCase {
	// MARK: meta

	func testMetaIsNilWithoutYearAndReleaseType() {
		XCTAssertNil(EdgeChipFormat.meta(year: nil, releaseType: nil))
	}

	func testMetaShowsTheYearAlone() {
		XCTAssertEqual(EdgeChipFormat.meta(year: "2015", releaseType: nil), "· 2015")
	}

	func testMetaShowsYearThenReleaseType() {
		XCTAssertEqual(EdgeChipFormat.meta(year: "2015", releaseType: "album"), "· 2015 · album")
	}

	func testMetaShowsTheReleaseTypeAloneWithoutDanglingSeparator() {
		XCTAssertEqual(EdgeChipFormat.meta(year: nil, releaseType: "ep"), "· ep")
	}

	func testMetaTreatsBlankValuesAsAbsent() {
		XCTAssertNil(EdgeChipFormat.meta(year: "", releaseType: "  "))
		XCTAssertEqual(EdgeChipFormat.meta(year: " 2015 ", releaseType: ""), "· 2015")
	}

	func testMetaOfAnEdgeReadsItsYearAndReleaseType() throws {
		let json = """
			{"slug": "project:to-pimp-a-butterfly", "type": "project", "name": "To Pimp a Butterfly",
			 "year": "2015", "releaseType": "album"}
			"""
		let edge = try JSONDecoder().decode(NodeEdge.self, from: Data(json.utf8))
		XCTAssertEqual(EdgeChipFormat.meta(of: edge), "· 2015 · album")
	}

	// MARK: artist (TRA-482)

	func testAnEdgeDecodesTheArtistTheServerStampedOnAWork() throws {
		let json = """
			{"slug": "track:fitna--rohff", "type": "track", "name": "Fitna", "artist": "Rohff"}
			"""
		let edge = try JSONDecoder().decode(NodeEdge.self, from: Data(json.utf8))
		XCTAssertEqual(edge.artist, "Rohff")
		XCTAssertEqual(edge.slug.rawValue, "track:fitna--rohff")
	}

	func testAnEdgeWithoutArtistStillDecodes() throws {
		let json = """
			{"slug": "genre:trip-hop", "type": "genre", "name": "Trip hop"}
			"""
		let edge = try JSONDecoder().decode(NodeEdge.self, from: Data(json.utf8))
		XCTAssertNil(edge.artist)
		let explicitNull = """
			{"slug": "project:mezzanine", "type": "project", "name": "Mezzanine", "artist": null}
			"""
		XCTAssertNil(try JSONDecoder().decode(NodeEdge.self, from: Data(explicitNull.utf8)).artist)
	}

	// A mistyped additive field must not fail the whole node page (same tolerance as `SearchHit.artist`).
	func testAMistypedArtistIsReadAsAbsentWithoutFailingTheEdge() throws {
		let json = """
			{"slug": "track:fitna--rohff", "type": "track", "name": "Fitna", "artist": 42}
			"""
		let edge = try JSONDecoder().decode(NodeEdge.self, from: Data(json.utf8))
		XCTAssertNil(edge.artist)
		XCTAssertEqual(edge.name, "Fitna")
	}

	func testTheArtistDoesNotChangeTheChipMeta() throws {
		let json = """
			{"slug": "project:mezzanine", "type": "project", "name": "Mezzanine", "year": "1998",
			 "releaseType": "album", "artist": "Massive Attack"}
			"""
		let edge = try JSONDecoder().decode(NodeEdge.self, from: Data(json.utf8))
		XCTAssertEqual(EdgeChipFormat.meta(of: edge), "· 1998 · album")
	}

	// MARK: type label

	func testTypeLabelsAreTheLowercaseEnglishTypes() {
		let labels = NodeType.allCases.map(EdgeChipFormat.typeLabel)
		XCTAssertEqual(labels, ["artist", "project", "track", "genre", "label"])
	}

	// MARK: rows

	func testRowsWrapWhereTheNextChipNoLongerFits() {
		// 100 + 8 + 100 = 208 <= 220, then 208 + 8 + 60 = 276 > 220: the third chip starts a new row.
		let sizes = [CGSize(width: 100, height: 34), CGSize(width: 100, height: 34), CGSize(width: 60, height: 34)]
		XCTAssertEqual(ChipFlow.rows(sizes: sizes, maxWidth: 220, spacing: 8), [[0, 1], [2]])
	}

	func testRowsKeepAChipThatFitsExactlyOnTheRow() {
		// 100 + 8 + 92 = 200: the width is inclusive. One more point and the chip wraps.
		let sizes = [CGSize(width: 100, height: 34), CGSize(width: 92, height: 34), CGSize(width: 1, height: 34)]
		XCTAssertEqual(ChipFlow.rows(sizes: sizes, maxWidth: 200, spacing: 8), [[0, 1], [2]])
		let wider = [CGSize(width: 100, height: 34), CGSize(width: 93, height: 34)]
		XCTAssertEqual(ChipFlow.rows(sizes: wider, maxWidth: 200, spacing: 8), [[0], [1]])
	}

	func testRowsGiveAChipWiderThanMaxWidthARowOfItsOwn() {
		let sizes = [
			CGSize(width: 80, height: 34), CGSize(width: 400, height: 34), CGSize(width: 70, height: 34),
			CGSize(width: 70, height: 34),
		]
		XCTAssertEqual(ChipFlow.rows(sizes: sizes, maxWidth: 300, spacing: 8), [[0], [1], [2, 3]])
	}

	func testRowsOfNothingAreEmpty() {
		XCTAssertEqual(ChipFlow.rows(sizes: [], maxWidth: 300, spacing: 8), [])
	}

	func testRowsPutEverythingOnOneRowWhenTheWidthIsUnbounded() {
		let sizes = Array(repeating: CGSize(width: 150, height: 34), count: 5)
		XCTAssertEqual(ChipFlow.rows(sizes: sizes, maxWidth: .infinity, spacing: 8), [[0, 1, 2, 3, 4]])
	}
}
