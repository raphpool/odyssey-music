import XCTest

@testable import Track1Core

/// E.3 (TRA-393): the pure parts of the hero and of the release card, read from Figma `171:34` (doc
/// `171:36`) and `172:16` (doc `172:21`) on 2026-10-13.
final class HeroFormatTests: XCTestCase {
	// MARK: NodeHeroKind

	func testProjectAndTrackShowTheReleaseHero() {
		XCTAssertEqual(NodeHeroKind(.project), .release)
		XCTAssertEqual(NodeHeroKind(.track), .release)
	}

	func testArtistShowsTheCircularHero() {
		XCTAssertEqual(NodeHeroKind(.artist), .artist)
	}

	func testGenreAndLabelShowTheSquareCoverHero() {
		XCTAssertEqual(NodeHeroKind(.genre), .cover)
		XCTAssertEqual(NodeHeroKind(.label), .cover)
	}

	// MARK: meta

	func testMetaCoversEveryCombinationOfYearAndReleaseType() {
		XCTAssertNil(ReleaseCardFormat.meta(year: nil, releaseType: nil))
		XCTAssertEqual(ReleaseCardFormat.meta(year: "2015", releaseType: nil), "2015")
		XCTAssertEqual(ReleaseCardFormat.meta(year: nil, releaseType: "ep"), "ep")
		XCTAssertEqual(ReleaseCardFormat.meta(year: "2015", releaseType: "album"), "2015 · album")
	}

	func testMetaTreatsBlankValuesAsAbsent() {
		XCTAssertNil(ReleaseCardFormat.meta(year: "", releaseType: "  "))
		XCTAssertEqual(ReleaseCardFormat.meta(year: " 2015 ", releaseType: ""), "2015")
	}

	// MARK: spoken label

	func testSpokenLabelDropsTheVisualSeparatorAndEmptyParts() {
		XCTAssertEqual(
			ReleaseCardFormat.spokenLabel(title: "To Pimp a Butterfly", meta: "2015 · album"),
			"To Pimp a Butterfly, 2015, album")
		XCTAssertEqual(ReleaseCardFormat.spokenLabel(title: "Untitled", meta: "a · · b"), "Untitled, a, b")
		XCTAssertEqual(ReleaseCardFormat.spokenLabel(title: "Untitled", meta: nil), "Untitled")
	}
}
