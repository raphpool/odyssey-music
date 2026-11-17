import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// The values are spelled out again from the TRA-737 ticket (the v1 Genres tab, 393 x 844 frame): a measure
/// changed in `GenresTabMetrics` alone fails here. Each value has its own test, named after it.
@MainActor
final class GenresTabViewTests: XCTestCase {
	private func rgbaHex(_ color: Color) -> String {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		return [red, green, blue, alpha].map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}

	// MARK: Measures

	func testTheColumnStartsAtY78() {
		XCTAssertEqual(GenresTabMetrics.columnTop, 78)
	}

	/// 78 - 59 = 19: the column lands at y 78 under the 59 pt status bar of the reference frame.
	func testTheColumnTopIsReducedByTheStatusBarOfTheReferenceFrame() {
		XCTAssertEqual(GenresTabMetrics.referenceTopInset, 59)
		XCTAssertEqual(GenresTabMetrics.columnTopPadding, 19)
	}

	func testTheColumnGapIs16() {
		XCTAssertEqual(GenresTabMetrics.columnSpacing, 16)
	}

	func testTheListSideMarginIs16() {
		XCTAssertEqual(GenresTabMetrics.listInset, 16)
	}

	func testTheListVerticalMarginIs12() {
		XCTAssertEqual(GenresTabMetrics.listVerticalInset, 12)
	}

	func testTheGapBetweenTwoCardsIs12() {
		XCTAssertEqual(GenresTabMetrics.listCardSpacing, 12)
	}

	/// The list draws these three itself: the tab must say what the list really does.
	func testTheListMeasuresAreTheOnesOfTheSelectionList() {
		XCTAssertEqual(GenresTabMetrics.listInset, GenreSelectionListMetrics.listInset)
		XCTAssertEqual(GenresTabMetrics.listVerticalInset, GenreSelectionListMetrics.listVerticalInset)
		XCTAssertEqual(GenresTabMetrics.listCardSpacing, GenreSelectionListMetrics.cardSpacing)
	}

	func testTheGapBetweenTheTwoLinesOfTheTenureIs2() {
		XCTAssertEqual(GenresTabMetrics.footSpacing, 2)
	}

	func testTheGapBeforeTheLogotypeIs4() {
		XCTAssertEqual(GenresTabMetrics.wordmarkSpacing, 4)
	}

	func testTheLogotypeIs40Point81By8Point88() {
		XCTAssertEqual(GenresTabMetrics.wordmarkSize.width, 40.81)
		XCTAssertEqual(GenresTabMetrics.wordmarkSize.height, 8.88)
	}

	func testTheBarHasNoMarginUnderItsButton() {
		XCTAssertEqual(GenresTabMetrics.barBottomInset, 0)
	}

	func testTheButtonEndsSeventeenPointsAboveTheTabBar() {
		XCTAssertEqual(GenresTabMetrics.barAboveTabBar, 17)
	}

	/// The bar keeps 32 pt under its button: 0 + 17 - 32 = -15 takes back what the tab does not draw.
	func testTheBarIsPaddedByTheDifferenceWithItsOwnBottomInset() {
		XCTAssertEqual(BottomActionBar.bottomInset, 32)
		XCTAssertEqual(GenresTabView.barBottomPadding, -15)
	}

	/// The last line of the tenure must clear the ramp of the fade, which the scroll view still reaches into:
	/// the ramp is (44.103 - 22.821) % of the 195 pt of the fade, about 41.5 pt.
	func testTheScrollEndsAboveTheRampOfTheFade() {
		let stops = BottomActionBar.fadeStops
		let ramp = BottomActionBar.fadeHeight * (stops[1].location - stops[0].location)
		XCTAssertEqual(ramp, 41.5, accuracy: 0.1)
		XCTAssertGreaterThan(GenresTabMetrics.contentBottomInset, ramp)
	}

	// MARK: Text, colours and background

	func testTheSectionTitleIsMonoItemInTextPrimary() {
		XCTAssertEqual(GenresTabMetrics.sectionTitle, "Tes genres")
		XCTAssertEqual(GenresTabMetrics.sectionTitleRole, .monoItem)
		XCTAssertEqual(GenresTabMetrics.sectionTitleRole.size, 18)
		XCTAssertEqual(GenresTabMetrics.sectionTitleRole.lineHeight, 22)
		XCTAssertEqual(GenresTabMetrics.sectionTitleColor, Track1Tokens.colorTextPrimary)
	}

	func testTheTenureIsMonoMicroInTextTertiary() {
		XCTAssertEqual(GenresTabMetrics.footRole, .monoMicro)
		XCTAssertEqual(GenresTabMetrics.footRole.face, .jetBrainsMonoMedium)
		XCTAssertEqual(GenresTabMetrics.footRole.size, 11)
		XCTAssertEqual(GenresTabMetrics.footRole.lineHeight, 14)
		XCTAssertEqual(GenresTabMetrics.footColor, Track1Tokens.colorTextTertiary)
		XCTAssertEqual(rgbaHex(GenresTabMetrics.footColor), "8d7a6dff")
	}

	func testTheLogotypeIsTheBrandWordmarkInTextPrimary() {
		XCTAssertEqual(GenresTabMetrics.wordmarkImageName, "Brand/Wordmark")
		XCTAssertEqual(GenresTabMetrics.wordmarkImageName, WelcomeView.wordmarkImageName)
		XCTAssertEqual(GenresTabMetrics.wordmarkColor, Track1Tokens.colorTextPrimary)
	}

	func testTheSaveButtonIsCalledSauvegarder() {
		XCTAssertEqual(GenresTabMetrics.saveTitle, "Sauvegarder")
	}

	/// `#3D3429` at the top, `#1A110E` from 30.746 % of the height down.
	func testTheBackgroundGradientIsTheTwoStopsOfTheNode() {
		let stops = GenresTabMetrics.backgroundStops
		XCTAssertEqual(stops.count, 2)
		XCTAssertEqual(stops[0].location, 0)
		XCTAssertEqual(stops[1].location, 0.30746, accuracy: 0.000001)
		XCTAssertEqual(stops[0].color, Track1Tokens.colorScreenGradientTop)
		XCTAssertEqual(stops[1].color, Track1Tokens.colorBackgroundElevated)
		XCTAssertEqual(rgbaHex(stops[0].color), "3d3429ff")
		XCTAssertEqual(rgbaHex(stops[1].color), "1a110eff")
	}

	// MARK: When "Sauvegarder" is active

	func testSaveIsOffWhileTheSelectionIsTheSavedOne() {
		XCTAssertFalse(GenresTabSaveRule.isEnabled(selected: ["a", "b"], saved: ["a", "b"]))
	}

	/// The order of ticking has no effect on the recommendation: the same genres are not a change.
	func testSaveIsOffWhenTheSameGenresAreTickedInAnotherOrder() {
		XCTAssertFalse(GenresTabSaveRule.isEnabled(selected: ["b", "a"], saved: ["a", "b"]))
	}

	func testSaveIsOnWhenAGenreIsAdded() {
		XCTAssertTrue(GenresTabSaveRule.isEnabled(selected: ["a", "b", "c"], saved: ["a", "b"]))
	}

	func testSaveIsOnWhenAGenreIsRemovedAndOthersRemain() {
		XCTAssertTrue(GenresTabSaveRule.isEnabled(selected: ["a"], saved: ["a", "b"]))
	}

	func testSaveIsOnWhenAGenreIsSwappedForAnother() {
		XCTAssertTrue(GenresTabSaveRule.isEnabled(selected: ["a", "c"], saved: ["a", "b"]))
	}

	/// Everything unticked differs from the saved profile, and still cannot be saved: a profile needs a genre.
	func testSaveIsOffWhenNothingIsTicked() {
		XCTAssertFalse(GenresTabSaveRule.isEnabled(selected: [], saved: ["a", "b"]))
	}

	func testSaveIsOffWhenNothingIsTickedAndNothingWasSaved() {
		XCTAssertFalse(GenresTabSaveRule.isEnabled(selected: [], saved: []))
	}

	/// A saved profile whose families all left the taxonomy shows no tick: the first one is a change.
	func testSaveIsOnForTheFirstTickOfAnEmptySavedSelection() {
		XCTAssertTrue(GenresTabSaveRule.isEnabled(selected: ["a"], saved: []))
	}
}
