import XCTest

final class NavigationTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	// 2026-10-13 (TRA-398): the name is pinned by ios/scripts/check.sh and test/ios-check.test.ts (Preview pass),
	// so it stays although the test now covers the two tabs, Today and Genres (TRA-771: Search left the bar).
	@MainActor
	func testThreeTabsKeepTheirIndependentNavigationStacks() throws {
		// 2026-10-14 (J.4): there are no tabs before a profile, so the journey starts from the first launch.
		let app = UITestFlows.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		let applicationWindow = app.windows.firstMatch
		XCTAssertTrue(applicationWindow.waitForExistence(timeout: 2))
		XCTAssertLessThanOrEqual(applicationWindow.frame.minY, 1)
		XCTAssertGreaterThanOrEqual(applicationWindow.frame.height, 800)
		XCTAssertFalse(app.otherElements["invalid-configuration"].exists)

		let today = UITestFlows.tabButton("Aujourd’hui", in: app)
		let genres = UITestFlows.tabButton("Genres", in: app)
		XCTAssertTrue(today.waitForExistence(timeout: 10))
		XCTAssertTrue(genres.exists)
		// TRA-771: two tabs and nothing else, in particular no Search entry whatever its element type.
		XCTAssertFalse(app.descendants(matching: .any)["tab-search"].exists)
		XCTAssertFalse(UITestFlows.tabButton("Réglages", in: app).exists)
		XCTAssertTrue(todayPage(in: app).waitForExistence(timeout: 15))
		XCTAssertTrue(today.isSelected)
		XCTAssertFalse(genres.isSelected)

		genres.tap()
		XCTAssertTrue(app.buttons["genres-edit"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["genres-settings"].exists)
		XCTAssertTrue(genres.isSelected)
		XCTAssertFalse(today.isSelected)

		today.tap()
		XCTAssertTrue(todayPage(in: app).waitForExistence(timeout: 15))
		XCTAssertTrue(today.isSelected)

		// Both tabs still show their root when selected again. No page is pushed here: the independence of the
		// stacks themselves is checked on the router, in `AppRouterNodeTests`.
		genres.tap()
		XCTAssertTrue(app.buttons["genres-edit"].waitForExistence(timeout: 5))
	}

	@MainActor
	func testTabsRemainAccessibleInDarkModeAndLargeText() throws {
		let app = UITestFlows.launch(extraArguments: [
			"-AppleInterfaceStyle", "Dark",
			"-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
		])
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)

		for tab in ["Aujourd’hui", "Genres"] {
			let button = UITestFlows.tabButton(tab, in: app)
			XCTAssertTrue(button.waitForExistence(timeout: 10))
			XCTAssertGreaterThanOrEqual(button.frame.height, 44)
			button.tap()
			switch tab {
			case "Aujourd’hui":
				XCTAssertTrue(todayPage(in: app).waitForExistence(timeout: 15))
			case "Genres":
				XCTAssertTrue(app.buttons["genres-settings"].waitForExistence(timeout: 5))
			default:
				XCTFail("Unexpected tab")
			}
		}

		let screenshot = XCUIScreen.main.screenshot()
		let attachment = XCTAttachment(screenshot: screenshot)
		attachment.name = "dark-accessibility-xxxl-tabs"
		attachment.lifetime = .keepAlways
		add(attachment)
	}

	/// The page of the day: Today only has one once the first launch has written the profile.
	@MainActor
	private func todayPage(in app: XCUIApplication) -> XCUIElement {
		app.descendants(matching: .any)["node-title"].firstMatch
	}
}
