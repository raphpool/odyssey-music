import XCTest

final class NavigationTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	@MainActor
	func testThreeTabsKeepTheirIndependentNavigationStacks() throws {
		let app = XCUIApplication()
		app.launch()
		let applicationWindow = app.windows.firstMatch
		XCTAssertTrue(applicationWindow.waitForExistence(timeout: 2))
		XCTAssertLessThanOrEqual(applicationWindow.frame.minY, 1)
		XCTAssertGreaterThanOrEqual(applicationWindow.frame.height, 800)
		XCTAssertTrue(app.tabBars.buttons["Aujourd’hui"].waitForExistence(timeout: 2))
		XCTAssertFalse(app.otherElements["invalid-configuration"].exists)

		app.buttons["entry-status-today"].tap()
		XCTAssertTrue(app.staticTexts["État de l’entrée"].waitForExistence(timeout: 2))

		app.tabBars.buttons["Recherche"].tap()
		let searchStatus = app.buttons["entry-status-search"]
		XCTAssertTrue(searchStatus.waitForExistence(timeout: 2))
		searchStatus.tap()
		XCTAssertTrue(app.staticTexts["État de l’entrée"].waitForExistence(timeout: 2))

		app.tabBars.buttons["Aujourd’hui"].tap()
		XCTAssertTrue(app.staticTexts["État de l’entrée"].waitForExistence(timeout: 2))
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(app.buttons["entry-status-today"].waitForExistence(timeout: 2))

		app.tabBars.buttons["Réglages"].tap()
		app.buttons["entry-status-settings"].tap()
		XCTAssertTrue(app.staticTexts["État de l’entrée"].waitForExistence(timeout: 2))
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(app.buttons["entry-status-settings"].waitForExistence(timeout: 2))
	}

	@MainActor
	func testTabsRemainAccessibleInDarkModeAndLargeText() throws {
		let app = XCUIApplication()
		app.launchArguments += [
			"-AppleInterfaceStyle", "Dark",
			"-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
		]
		app.launch()

		for tab in ["Aujourd’hui", "Recherche", "Réglages"] {
			let button = app.tabBars.buttons[tab]
			XCTAssertTrue(button.waitForExistence(timeout: 2))
			XCTAssertGreaterThanOrEqual(button.frame.height, 44)
			button.tap()
			let description = app.staticTexts["Cette entrée est prête à accueillir son contenu."]
			XCTAssertTrue(description.waitForExistence(timeout: 2))
			XCTAssertGreaterThan(description.frame.height, 20)
		}

		let screenshot = XCUIScreen.main.screenshot()
		let attachment = XCTAttachment(screenshot: screenshot)
		attachment.name = "dark-accessibility-xxxl-tabs"
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
