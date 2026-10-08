import XCTest

final class NavigationTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	@MainActor
	func testThreeTabsKeepTheirIndependentNavigationStacks() throws {
		let app = XCUIApplication()
		app.launchArguments = [
			"-AppleLanguages", "(fr)", "-track1-reset-analytics-consent", "-track1-reset-profile",
		]
		app.launch()
		app.buttons["analytics-consent-decline"].tap()
		let applicationWindow = app.windows.firstMatch
		XCTAssertTrue(applicationWindow.waitForExistence(timeout: 2))
		XCTAssertLessThanOrEqual(applicationWindow.frame.minY, 1)
		XCTAssertGreaterThanOrEqual(applicationWindow.frame.height, 800)
		XCTAssertTrue(app.tabBars.buttons["Aujourd’hui"].waitForExistence(timeout: 2))
		XCTAssertFalse(app.otherElements["invalid-configuration"].exists)

		XCTAssertTrue(app.buttons["profile-choose"].waitForExistence(timeout: 2))

		app.tabBars.buttons["Recherche"].tap()
		let searchStatus = app.buttons["entry-status-search"]
		XCTAssertTrue(searchStatus.waitForExistence(timeout: 2))
		searchStatus.tap()
		XCTAssertFalse(searchStatus.exists)

		app.tabBars.buttons["Aujourd’hui"].tap()
		XCTAssertTrue(app.buttons["profile-choose"].waitForExistence(timeout: 2))

		app.tabBars.buttons["Réglages"].tap()
		XCTAssertTrue(app.buttons["profile-settings-edit"].waitForExistence(timeout: 2))
		XCTAssertTrue(app.buttons["analytics-settings"].exists)

		app.tabBars.buttons["Recherche"].tap()
		XCTAssertTrue(app.staticTexts["entry-status-description-search"].waitForExistence(timeout: 2))
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(searchStatus.waitForExistence(timeout: 2))
	}

	@MainActor
	func testTabsRemainAccessibleInDarkModeAndLargeText() throws {
		let app = XCUIApplication()
		app.launchArguments += [
			"-AppleLanguages", "(fr)",
			"-track1-reset-analytics-consent", "-track1-reset-profile",
			"-AppleInterfaceStyle", "Dark",
			"-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
		]
		app.launch()
		app.buttons["analytics-consent-decline"].tap()

		for tab in ["Aujourd’hui", "Recherche", "Réglages"] {
			let button = app.tabBars.buttons[tab]
			XCTAssertTrue(button.waitForExistence(timeout: 2))
			XCTAssertGreaterThanOrEqual(button.frame.height, 44)
			button.tap()
			switch tab {
			case "Aujourd’hui":
				XCTAssertTrue(app.buttons["profile-choose"].waitForExistence(timeout: 2))
			case "Recherche":
				let description = app.staticTexts["Cette entrée est prête à accueillir son contenu."]
				XCTAssertTrue(description.waitForExistence(timeout: 2))
				XCTAssertGreaterThan(description.frame.height, 20)
			case "Réglages":
				XCTAssertTrue(app.buttons["profile-settings-edit"].waitForExistence(timeout: 2))
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
}
