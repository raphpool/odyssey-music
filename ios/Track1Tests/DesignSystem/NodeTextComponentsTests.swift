import SwiftUI
import XCTest

@testable import Track1

/// The pure rules of the text components of a node page (Teaser card, Section header, Fact row, Track row),
/// whose sizes and rules are those of the Figma docs `171:52`, `171:66`, `172:6` and `172:38` (read
/// 2026-10-13).
final class NodeTextComponentsTests: XCTestCase {
	// MARK: - Track row

	func testTrackNumbersArePaddedToTwoDigits() {
		XCTAssertEqual(TrackRow.formattedNumber(1), "01")
		XCTAssertEqual(TrackRow.formattedNumber(9), "09")
		XCTAssertEqual(TrackRow.formattedNumber(12), "12")
		XCTAssertEqual(TrackRow.formattedNumber(100), "100")
	}

	func testTrackRowIsAtLeast44PointsTall() {
		XCTAssertEqual(TrackRow.minimumHeight, 44)
	}

	func testTrackRowIdentifierFollowsTheNumber() {
		XCTAssertEqual(TrackRow.identifier(number: 3), "track-row-3")
		XCTAssertEqual(TrackRow.identifier(number: 12), "track-row-12")
	}

	// MARK: - Facts

	func testNoFactsMeansAnEmptyBlock() {
		XCTAssertTrue(FactsBlock.isEmpty([]))
		XCTAssertFalse(FactsBlock.isEmpty([(label: "BPM", value: "96")]))
	}

	func testFactLabelsAreUppercaseInAFixed104PointColumn() {
		XCTAssertEqual(FactRow.displayLabel("Sonic markers"), "SONIC MARKERS")
		XCTAssertEqual(FactRow.labelColumnWidth, 104)
	}

	func testFactsBlockIdentifier() {
		XCTAssertEqual(FactsBlock.identifier, "facts")
	}

	// MARK: - Section header

	func testNoCountMeansNoCountText() {
		XCTAssertNil(SectionHeader.countText(nil))
	}

	func testCountTextIsThePlainNumber() {
		XCTAssertEqual(SectionHeader.countText(83), "83")
		XCTAssertEqual(SectionHeader.countText(0), "0")
		XCTAssertEqual(SectionHeader.countText(1234), "1234")
	}

	func testSectionTitlesAreLowercase() {
		XCTAssertEqual(SectionHeader.displayTitle("Discography"), "discography")
	}

	func testSectionHeaderLeaves12PointsAboveItsContent() {
		XCTAssertEqual(SectionHeader.contentSpacing, 12)
	}

	func testSectionIdentifierFollowsTheField() {
		XCTAssertEqual(SectionHeader.identifier(field: "tracklist"), "section-tracklist")
	}

	// MARK: - Teaser card

	func testTeaserCardIdentifier() {
		XCTAssertEqual(TeaserCard.identifier, "teaser")
	}

	/// Since the UI refresh the teaser is plain text: the card around the page provides the padding and the
	/// fill. A teaser as tall as the bare text it draws has neither padding nor a padded background.
	@MainActor
	func testTeaserCardIsAsTallAsItsBareTextWithNoPadding() {
		let text = "Un disque."
		let size = CGSize(width: 337, height: 1000)
		let teaser = UIHostingController(rootView: TeaserCard(text: text)).sizeThatFits(in: size)
		let bare = UIHostingController(
			rootView: Track1Text(text, role: .bodyMedium, verbatim: true)
				.frame(maxWidth: .infinity, alignment: .leading)
				.fixedSize(horizontal: false, vertical: true)
		).sizeThatFits(in: size)

		XCTAssertGreaterThan(bare.height, 0)
		XCTAssertEqual(teaser.height, bare.height, accuracy: 0.5)
		XCTAssertEqual(teaser.width, bare.width, accuracy: 0.5)
	}
}
