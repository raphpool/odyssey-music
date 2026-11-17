import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Genres step (`243:1585`), TRA-403 then TRA-639, then TRA-767 for the v1 mock-up `316:5066` (read on
/// 2026-11-17, 393 x 852). The accordion list takes the Figma margins (`316:5077`): 16 pt from the screen
/// edges, 12 pt between two cards, 12 pt above and below the list.
@MainActor
final class GenresStepLayoutTests: XCTestCase {
	private func rgbaHex(_ color: Color) -> String {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		return [red, green, blue, alpha].map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}

	/// One editorial family with one published genre, so a single chip is there to toggle.
	private func model() throws -> GenreSelectionModel {
		let json = """
			{"version": "v1", "revision": "sha256:\(String(repeating: "0123456789abcdef", count: 4))",
			"taxonomy": {"mode": "editorial", "version": 2,
				"families": [{"key": "hip-hop", "label": "Hip-hop", "order": 1}],
				"genres": [{"id": "Q11401", "name": "Trap", "family": "hip-hop", "slugs": ["genre:trap"]}],
				"legacySelectionBySlug": {}},
			"nodes": [{"identity": "genre:trap", "type": "genre", "name": "Trap", "teaser": null}],
			"edges": []}
			"""
		let catalog = try JSONDecoder().decode(Catalog.self, from: Data(json.utf8))
		return GenreSelectionModel(taxonomy: try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog)))
	}

	func testGenresBarHasItsOwnIdentifierAndKeepsTheFade() throws {
		let bar = GenresStepView.actionBar(model: try model()) {}
		XCTAssertEqual(bar.identifier, "onboarding-genres-continue")
		XCTAssertTrue(bar.showsFade)
	}

	func testSelectAllIdentifierCarriesTheFamilyKey() {
		XCTAssertEqual(GenresStepView.selectAllIdentifier(for: "hip-hop"), "select-all-hip-hop")
	}

	func testContinueIsDisabledUntilASubgenreIsChosen() throws {
		let model = try model()
		XCTAssertFalse(GenresStepView.isContinueEnabled(model))
		model.toggleSubgenre("Q11401")
		XCTAssertTrue(GenresStepView.isContinueEnabled(model))
		model.toggleSubgenre("Q11401")
		XCTAssertFalse(GenresStepView.isContinueEnabled(model))
	}

	func testListInsetsAreTheFigmaValues() {
		XCTAssertEqual(GenresStepLayout.listInset, 16)
		XCTAssertEqual(GenresStepLayout.cardSpacing, 12)
		XCTAssertEqual(GenresStepLayout.listVerticalInset, 12)
	}

	/// "Tous" chip, then 8 under it and 4 of body spacing, then the chips 8 apart in both directions.
	func testOpenCardBodyMeasuresAreTheFigmaValues() {
		XCTAssertEqual(GenresStepLayout.cardBodySpacing, 4)
		XCTAssertEqual(GenresStepLayout.selectAllRowBottomInset, 8)
		XCTAssertEqual(GenresStepLayout.cardBodySpacing + GenresStepLayout.selectAllRowBottomInset, 12)
		XCTAssertEqual(GenresStepLayout.chipSpacing, 8)
	}

	/// 393 - 2 x 16 = 361, the width of a card in Figma.
	func testACardIs361PointsWideOnA393PointScreen() {
		XCTAssertEqual(393 - 2 * GenresStepLayout.listInset, 361)
	}

	func testHeaderMeasuresAreTheFigmaValues() {
		XCTAssertEqual(GenresStepLayout.contentInset, 24)
		XCTAssertEqual(GenresStepLayout.headerTextSpacing, 8)
		XCTAssertEqual(GenresStepLayout.headerBottomInset, 16)
		XCTAssertEqual(GenresStepLayout.headerTop, 78)
	}

	/// 78 - 59 = 19: the title lands at y 78 under the 59 pt status bar of the 393 x 852 frame.
	func testHeaderIsPushedDownByTheGapBetweenItsFigmaTopAndTheStatusBar() {
		XCTAssertEqual(GenresStepLayout.referenceTopInset, 59)
		XCTAssertEqual(GenresStepLayout.headerTopPadding, 19)
	}

	func testHeaderTextIsTitle1ThenBodyMedium() {
		XCTAssertEqual(GenresStepLayout.titleRole, .title1)
		XCTAssertEqual(GenresStepLayout.titleRole.face, .jetBrainsMonoBold)
		XCTAssertEqual(GenresStepLayout.titleRole.size, 28)
		XCTAssertEqual(GenresStepLayout.titleRole.lineHeight, 34)
		XCTAssertEqual(rgbaHex(GenresStepLayout.titleColor), "f6e9d8ff", "text/primary")
		XCTAssertEqual(GenresStepLayout.subtitleRole, .bodyMedium)
		XCTAssertEqual(GenresStepLayout.subtitleRole.size, 15)
		XCTAssertEqual(GenresStepLayout.subtitleRole.lineHeight, 22)
		XCTAssertEqual(rgbaHex(GenresStepLayout.subtitleColor), "c8b6a3ff", "text/secondary")
	}

	func testHeaderTextsAreTheFigmaOnes() {
		XCTAssertEqual(GenresStepView.title, "Sélectionne tes genres")
		XCTAssertEqual(GenresStepView.subtitle, "Tu recevras une recommandation par jour")
	}

	/// `#3D3429` at the top to `#1A110E` at 33.099 %, read on the root node `316:5066`.
	func testBackgroundIsTheVerticalGradientOfTheRootNode() {
		let stops = GenresStepLayout.backgroundStops
		XCTAssertEqual(stops.count, 2)
		XCTAssertEqual(stops[0].location, 0, accuracy: 0.000001)
		XCTAssertEqual(stops[1].location, 0.33099, accuracy: 0.000001)
		XCTAssertEqual(stops.map { rgbaHex($0.color) }, ["3d3429ff", "1a110eff"])
	}

	/// TRA-767: the counter sits above "Continuer" on this screen, and the bar keeps its fade.
	func testGenresBarReadsTheCounterBeforeTheButton() throws {
		let bar = GenresStepView.actionBar(model: try model()) {}
		XCTAssertEqual(bar.parts, [.counter, .button])
	}
}
