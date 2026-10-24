import XCTest

final class NavigationTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	// 2026-10-13 (TRA-398): the name is pinned by ios/scripts/check.sh and test/ios-check.test.ts (Preview pass),
	// so it stays although the test now covers Today / Genres / Search and the search sheet.
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
		XCTAssertTrue(today.waitForExistence(timeout: 10))
		XCTAssertTrue(UITestFlows.tabButton("Genres", in: app).exists)
		XCTAssertTrue(UITestFlows.tabButton("Recherche", in: app).exists)
		XCTAssertFalse(UITestFlows.tabButton("Réglages", in: app).exists)
		XCTAssertTrue(todayPage(in: app).waitForExistence(timeout: 15))

		UITestFlows.tabButton("Genres", in: app).tap()
		XCTAssertTrue(app.buttons["genres-edit"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["genres-settings"].exists)

		today.tap()
		XCTAssertTrue(todayPage(in: app).waitForExistence(timeout: 15))

		UITestFlows.tabButton("Recherche", in: app).tap()
		let sheet = app.descendants(matching: .any)["search-sheet"]
		XCTAssertTrue(sheet.waitForExistence(timeout: 2))
		dismiss(sheet)
		// The sheet did not take the selection: Today is still the tab under it.
		XCTAssertTrue(today.isSelected)
		XCTAssertTrue(todayPage(in: app).waitForExistence(timeout: 15))
	}

	@MainActor
	func testTabsRemainAccessibleInDarkModeAndLargeText() throws {
		let app = UITestFlows.launch(extraArguments: [
			"-AppleInterfaceStyle", "Dark",
			"-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
		])
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)

		for tab in ["Aujourd’hui", "Genres", "Recherche"] {
			let button = UITestFlows.tabButton(tab, in: app)
			XCTAssertTrue(button.waitForExistence(timeout: 10))
			XCTAssertGreaterThanOrEqual(button.frame.height, 44)
			button.tap()
			switch tab {
			case "Aujourd’hui":
				XCTAssertTrue(todayPage(in: app).waitForExistence(timeout: 15))
			case "Genres":
				XCTAssertTrue(app.buttons["genres-settings"].waitForExistence(timeout: 5))
			case "Recherche":
				let sheet = app.descendants(matching: .any)["search-sheet"]
				XCTAssertTrue(sheet.waitForExistence(timeout: 2))
				// I.2: the field is the first thing of the sheet, and it stays reachable at the largest size.
				XCTAssertTrue(app.descendants(matching: .any)["search-field"].waitForExistence(timeout: 5))
				dismiss(sheet)
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

	/// I.2: "Rechercher" on an empty field closes the sheet, the third way out with the swipe and the scrim.
	@MainActor
	func testSearchKeyOnAnEmptyFieldClosesTheSheet() throws {
		let app = UITestFlows.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)

		XCTAssertTrue(UITestFlows.tabButton("Recherche", in: app).waitForExistence(timeout: 10))
		UITestFlows.tabButton("Recherche", in: app).tap()
		let sheet = app.descendants(matching: .any)["search-sheet"]
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		let field = app.textFields["search-field"]
		XCTAssertTrue(field.waitForExistence(timeout: 5))
		// The return key of the field is the "Rechercher" key; a hardware keyboard has no on-screen one.
		field.typeText("\n")

		XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
		XCTAssertTrue(UITestFlows.tabButton("Aujourd’hui", in: app).isSelected)
	}

	/// The page of the day: Today only has one once the first launch has written the profile.
	@MainActor
	private func todayPage(in app: XCUIApplication) -> XCUIElement {
		app.descendants(matching: .any)["node-title"].firstMatch
	}

	/// Swipes the sheet down from its top edge; a tap outside does not exist on a full-height sheet.
	// 2026-10-13 (TRA-398): a 0.1 s press then a drag at 500 px/s from 30 % of the sheet left it open on
	// iOS 26.4 (ios-check #374): the start landed on the search field and the drag was too slow to cross the
	// dismissal threshold. Start in the handle area, drag fast to the bottom of the screen, and fall back on a
	// fast swipe.
	@MainActor
	private func dismiss(_ sheet: XCUIElement) {
		let start = sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02))
		let end = XCUIApplication().coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98))
		start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
		if !sheet.waitForNonExistence(timeout: 3) {
			sheet.swipeDown(velocity: .fast)
		}
		XCTAssertTrue(sheet.waitForNonExistence(timeout: 3))
	}
}
