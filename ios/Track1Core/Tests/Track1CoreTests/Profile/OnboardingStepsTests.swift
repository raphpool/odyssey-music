import XCTest

@testable import Track1Core

final class OnboardingStepsTests: XCTestCase {
	// MARK: - Order

	func testTheOrderHasFourStepsWithoutNotifications() {
		XCTAssertEqual(OnboardingSteps.order(includesNotifications: false), [.welcome, .pseudo, .disc, .genres])
	}

	func testTheOrderHasFiveStepsWithNotificationsLast() {
		XCTAssertEqual(
			OnboardingSteps.order(includesNotifications: true),
			[.welcome, .pseudo, .disc, .genres, .notifications]
		)
	}

	func testEveryStepIDIsPartOfTheFullOrder() {
		XCTAssertEqual(Set(OnboardingSteps.order(includesNotifications: true)), Set(OnboardingStepID.allCases))
	}

	// MARK: - Next and previous

	func testNextWalksTheOrderWithoutNotifications() {
		XCTAssertEqual(OnboardingSteps.next(after: .welcome, includesNotifications: false), .pseudo)
		XCTAssertEqual(OnboardingSteps.next(after: .pseudo, includesNotifications: false), .disc)
		XCTAssertEqual(OnboardingSteps.next(after: .disc, includesNotifications: false), .genres)
	}

	func testNextAfterGenresIsNilWithoutNotificationsAndNotificationsWithThem() {
		XCTAssertNil(OnboardingSteps.next(after: .genres, includesNotifications: false))
		XCTAssertEqual(OnboardingSteps.next(after: .genres, includesNotifications: true), .notifications)
	}

	func testNextAfterNotificationsIsNilWhetherOrNotTheyAreIncluded() {
		// Absent from the order in the first case, last of it in the second.
		XCTAssertNil(OnboardingSteps.next(after: .notifications, includesNotifications: false))
		XCTAssertNil(OnboardingSteps.next(after: .notifications, includesNotifications: true))
	}

	func testPreviousWalksTheOrderBackwards() {
		XCTAssertNil(OnboardingSteps.previous(before: .welcome, includesNotifications: false))
		XCTAssertEqual(OnboardingSteps.previous(before: .pseudo, includesNotifications: false), .welcome)
		XCTAssertEqual(OnboardingSteps.previous(before: .disc, includesNotifications: false), .pseudo)
		XCTAssertEqual(OnboardingSteps.previous(before: .genres, includesNotifications: false), .disc)
	}

	func testPreviousOfNotificationsExistsOnlyWhenTheyAreIncluded() {
		XCTAssertEqual(OnboardingSteps.previous(before: .notifications, includesNotifications: true), .genres)
		XCTAssertNil(OnboardingSteps.previous(before: .notifications, includesNotifications: false))
	}

	// MARK: - Locks

	func testWelcomeAndNotificationsCanAlwaysBeLeft() {
		for step in [OnboardingStepID.welcome, .notifications] {
			XCTAssertTrue(OnboardingSteps.canLeave(step, pseudo: nil, disc: nil, selectedGenres: 0))
		}
	}

	func testThePseudoStepIsLockedUntilAVisiblePseudoIsTyped() {
		XCTAssertFalse(OnboardingSteps.canLeave(.pseudo, pseudo: nil, disc: .blue, selectedGenres: 3))
		XCTAssertFalse(OnboardingSteps.canLeave(.pseudo, pseudo: "", disc: .blue, selectedGenres: 3))
		XCTAssertFalse(OnboardingSteps.canLeave(.pseudo, pseudo: "   ", disc: .blue, selectedGenres: 3))
		XCTAssertFalse(OnboardingSteps.canLeave(.pseudo, pseudo: "\u{200B}", disc: .blue, selectedGenres: 3))
		XCTAssertTrue(OnboardingSteps.canLeave(.pseudo, pseudo: "Raph", disc: nil, selectedGenres: 0))
		XCTAssertTrue(OnboardingSteps.canLeave(.pseudo, pseudo: "  Raph  ", disc: nil, selectedGenres: 0))
	}

	func testTheDiscStepIsLockedUntilADiscIsPicked() {
		XCTAssertFalse(OnboardingSteps.canLeave(.disc, pseudo: "Raph", disc: nil, selectedGenres: 3))
		for disc in ProfileDisc.allCases {
			XCTAssertTrue(OnboardingSteps.canLeave(.disc, pseudo: nil, disc: disc, selectedGenres: 0))
		}
	}

	func testTheGenresStepNeedsAtLeastOneGenre() {
		XCTAssertFalse(OnboardingSteps.canLeave(.genres, pseudo: "Raph", disc: .blue, selectedGenres: 0))
		XCTAssertTrue(OnboardingSteps.canLeave(.genres, pseudo: nil, disc: nil, selectedGenres: 1))
		XCTAssertTrue(OnboardingSteps.canLeave(.genres, pseudo: nil, disc: nil, selectedGenres: 5))
	}
}
