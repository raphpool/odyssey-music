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

	func testTheSummaryIsSingularForZeroAndOne() {
		XCTAssertEqual(OnboardingCopy.selectionSummary(families: 1, genres: 1), "1 famille · 1 sous-genre")
		// A family left whole has no ticked genre: the count says 0, in the singular.
		XCTAssertEqual(OnboardingCopy.selectionSummary(families: 1, genres: 0), "1 famille · 0 sous-genre")
	}

	func testANegativeSummaryCountReadsAsZero() {
		XCTAssertEqual(OnboardingCopy.selectionSummary(families: -1, genres: -4), "0 famille · 0 sous-genre")
	}

	func testTheHelpLineTellsThatAnEmptyListIsTheWholeFamily() {
		XCTAssertEqual(OnboardingCopy.wholeFamilyHint, "Sans sous-genre coché, toute la famille compte.")
	}
}
