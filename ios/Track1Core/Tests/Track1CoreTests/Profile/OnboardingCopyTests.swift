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
}
