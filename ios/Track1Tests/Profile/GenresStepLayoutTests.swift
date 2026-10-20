import Track1Core
import XCTest

@testable import Track1

/// Genres step (`243:1585`), TRA-403 then TRA-639. The accordion list takes the Figma margins (`243:1671`):
/// 16 pt from the screen edges, 4 pt between two cards, 12 pt above and below the list.
@MainActor
final class GenresStepLayoutTests: XCTestCase {
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
		XCTAssertEqual(GenresStepLayout.cardSpacing, 4)
		XCTAssertEqual(GenresStepLayout.listVerticalInset, 12)
	}
}
