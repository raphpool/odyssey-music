import CoreGraphics
import Track1Core
import XCTest

@testable import Track1

/// Genres step (`176:80`), TRA-403. Sizes are the Figma ones: a 393 pt screen gives a 345 pt column and
/// 164 x 176 tiles; the iPhone SE (375 pt) gives 327 pt, and the height follows the 164:176 ratio.
@MainActor
final class GenresStepLayoutTests: XCTestCase {
	/// One editorial family with one published genre, so a single tile is there to toggle.
	private func model() throws -> GenreOnboardingModel {
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
		return GenreOnboardingModel(taxonomy: try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog)))
	}

	func testTileSizeOnA345PointColumn() {
		let size = GenresStepLayout.tileSize(containerWidth: 345)
		XCTAssertEqual(size.width, 164.5, accuracy: 0.01)
		// 164.5 x 176 / 164 = 176.5366: the ticket's "~176,5" is rounded, the ratio is the contract.
		XCTAssertEqual(size.height, 176.54, accuracy: 0.01)
	}

	func testTileSizeOnAnIPhoneSEColumn() {
		let size = GenresStepLayout.tileSize(containerWidth: 327)
		XCTAssertEqual(size.width, 155.5, accuracy: 0.01)
		XCTAssertEqual(size.height, 166.88, accuracy: 0.01)
	}

	func testTwoTilesAndTheGutterFillTheColumn() {
		let size = GenresStepLayout.tileSize(containerWidth: 300)
		XCTAssertEqual(2 * size.width + GenresStepLayout.gutter, 300, accuracy: 0.01)
	}

	func testAColumnNarrowerThanTheGutterGivesAnEmptySizeNotANegativeOne() {
		for width: CGFloat in [16, 0, -40] {
			let size = GenresStepLayout.tileSize(containerWidth: width)
			XCTAssertEqual(size.width, 0, accuracy: 0.01)
			XCTAssertEqual(size.height, 0, accuracy: 0.01)
		}
	}

	func testGenresBarHasItsOwnIdentifierAndKeepsTheFade() throws {
		let bar = GenresStepView.actionBar(model: try model()) {}
		XCTAssertEqual(bar.identifier, "onboarding-genres-continue")
		XCTAssertTrue(bar.showsFade)
	}

	func testContinueIsDisabledUntilAFamilyIsChosen() throws {
		let model = try model()
		XCTAssertFalse(GenresStepView.isContinueEnabled(model))
		model.toggleFamily("hip-hop")
		XCTAssertTrue(GenresStepView.isContinueEnabled(model))
		model.toggleFamily("hip-hop")
		XCTAssertFalse(GenresStepView.isContinueEnabled(model))
	}
}
