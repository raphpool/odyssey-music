import XCTest

@testable import Track1Core

final class OnboardingCopyTests: XCTestCase {
	func testZeroIsSingularInFrench() {
		XCTAssertEqual(OnboardingCopy.counter(0), "Total : 0 genre")
	}

	func testOneIsSingular() {
		XCTAssertEqual(OnboardingCopy.counter(1), "Total : 1 genre")
	}

	func testTwoAndMoreArePlural() {
		XCTAssertEqual(OnboardingCopy.counter(2), "Total : 2 genres")
		XCTAssertEqual(OnboardingCopy.counter(34), "Total : 34 genres")
	}

	func testANegativeCountReadsAsZero() {
		XCTAssertEqual(OnboardingCopy.counter(-3), "Total : 0 genre")
	}

	func testTheSummaryCountsFamiliesAndGenres() {
		XCTAssertEqual(OnboardingCopy.selectionSummary(families: 2, genres: 5), "2 familles · 5 sous-genres")
	}

	func testTheSummaryIsSingularForOne() {
		XCTAssertEqual(OnboardingCopy.selectionSummary(families: 1, genres: 1), "1 famille · 1 sous-genre")
	}

	func testTheSummaryLeavesOutTheGenresWhenNoneIsTicked() {
		// A family left whole counts for all of its genres: there is no ticked count to show.
		XCTAssertEqual(OnboardingCopy.selectionSummary(families: 1, genres: 0), "1 famille")
		XCTAssertEqual(OnboardingCopy.selectionSummary(families: 3, genres: 0), "3 familles")
	}

	func testANegativeSummaryCountReadsAsZero() {
		XCTAssertEqual(OnboardingCopy.selectionSummary(families: -1, genres: -4), "0 famille")
	}

	func testTheHelpLineTellsThatAnEmptyListIsTheWholeFamily() {
		XCTAssertEqual(OnboardingCopy.wholeFamilyHint, "Sans sous-genre coché, toute la famille compte.")
	}
}
