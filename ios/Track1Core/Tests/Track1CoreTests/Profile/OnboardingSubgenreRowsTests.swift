import XCTest

@testable import Track1Core

@MainActor
final class OnboardingSubgenreRowsTests: XCTestCase {
	private let hipHop = NodeIdentity(rawValue: "genre:hip-hop")!
	private let jazz = NodeIdentity(rawValue: "genre:jazz")!
	private let trap = NodeIdentity(rawValue: "genre:trap")!
	private let bebop = NodeIdentity(rawValue: "genre:bebop")!

	private func model() throws -> OnboardingFlowModel {
		OnboardingFlowModel(taxonomy: GenreTaxonomy(catalog: try OnboardingFixture.catalog()))
	}

	func testTheRowsOfAStepAreTheSubgenresOfItsSelectedParentInDisplayOrder() throws {
		let model = try model()
		model.toggleParent(hipHop)

		let rows = model.subgenreChoices(of: hipHop)
		XCTAssertEqual(rows.map(\.name), ["Boom bap", "Drill", "Trap"])
		XCTAssertEqual(rows.first?.definition, "Rap sampled from soul and jazz records.")
	}

	func testAParentThatIsNotSelectedHasNoRows() throws {
		let model = try model()
		model.toggleParent(hipHop)

		XCTAssertEqual(model.subgenreChoices(of: jazz), [])
		model.toggleParent(hipHop)
		XCTAssertEqual(model.subgenreChoices(of: hipHop), [])
	}

	func testARowIsSelectedOnceToggledAndStaysSelectedAcrossSteps() throws {
		let model = try model()
		model.toggleParent(hipHop)
		model.toggleParent(jazz)
		XCTAssertFalse(model.isSubgenreSelected(trap))

		model.toggleSubgenre(trap, of: hipHop)
		model.toggleSubgenre(bebop, of: jazz)
		// Going back to the first step reads the same selection.
		XCTAssertTrue(model.isSubgenreSelected(trap))
		XCTAssertTrue(model.isSubgenreSelected(bebop))
		XCTAssertEqual(model.selectedSubgenreCount, 2)

		model.toggleSubgenre(trap, of: hipHop)
		XCTAssertFalse(model.isSubgenreSelected(trap))
		XCTAssertEqual(model.selectedSubgenreCount, 1)
	}

	func testTheCounterOfAStepReadsTheTotalAcrossParents() throws {
		let model = try model()
		model.toggleParent(hipHop)
		model.toggleParent(jazz)
		model.toggleAll(of: hipHop)
		model.toggleSubgenre(bebop, of: jazz)

		XCTAssertEqual(model.selectedSubgenreCount, 4)
		XCTAssertEqual(OnboardingCopy.counter(model.selectedSubgenreCount), "Total : 4 genres")
	}

	func testStepsAreVisitedInSelectionOrderAndTheFlowEndsAfterTheLastOne() throws {
		let model = try model()
		model.toggleParent(jazz)
		model.toggleParent(hipHop)

		XCTAssertEqual(model.subgenreSteps.first, jazz)
		XCTAssertEqual(model.subgenreStep(after: jazz), hipHop)
		XCTAssertNil(model.subgenreStep(after: hipHop), "nothing follows the last parent")
		XCTAssertNil(model.subgenreStep(after: bebop), "a genre that is not a step has no successor")
	}

	func testTheLastStepEndsWithTerminerAndTheDraftHoldsTheSelection() throws {
		let model = try model()
		model.toggleParent(hipHop)
		model.toggleParent(jazz)
		model.toggleSubgenre(bebop, of: jazz)

		XCTAssertEqual(model.ctaTitle(forStep: 0), "Continuer")
		XCTAssertEqual(model.ctaTitle(forStep: model.subgenreSteps.count - 1), "Terminer")
		XCTAssertEqual(model.makeDraft().genreIDs, [hipHop, jazz, bebop])
	}
}
