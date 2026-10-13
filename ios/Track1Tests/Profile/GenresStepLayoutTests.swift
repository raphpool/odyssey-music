import CoreGraphics
import Track1Core
import XCTest

@testable import Track1

/// Genres step (`176:80`), TRA-403. Sizes are the Figma ones: a 393 pt screen gives a 345 pt column and
/// 164 x 176 tiles; the iPhone SE (375 pt) gives 327 pt, and the height follows the 164:176 ratio.
@MainActor
final class GenresStepLayoutTests: XCTestCase {
	private let hipHop = NodeIdentity(rawValue: "genre:hip-hop")!

	/// Hip-Hop has a subgenre and no parent, so it is the only tile.
	private func model() throws -> OnboardingFlowModel {
		let json = """
			{"version": "v1", "revision": "sha256:\(String(repeating: "0123456789abcdef", count: 4))",
			"taxonomy": {"mode": "degraded", "available": true},
			"nodes": [
				{"identity": "genre:hip-hop", "type": "genre", "name": "Hip-hop", "teaser": null},
				{"identity": "genre:trap", "type": "genre", "name": "Trap", "teaser": null}
			],
			"edges": [{"source": "genre:hip-hop", "target": "genre:trap", "type": "subgenres"}]}
			"""
		let catalog = try JSONDecoder().decode(Catalog.self, from: Data(json.utf8))
		return OnboardingFlowModel(taxonomy: GenreTaxonomy(catalog: catalog))
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

	func testContinueIsDisabledUntilAParentIsChosen() throws {
		let model = try model()
		XCTAssertFalse(GenresStepView.isContinueEnabled(model))
		model.toggleParent(hipHop)
		XCTAssertTrue(GenresStepView.isContinueEnabled(model))
		model.toggleParent(hipHop)
		XCTAssertFalse(GenresStepView.isContinueEnabled(model))
	}
}
