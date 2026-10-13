import XCTest

final class NavigationTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	// 2026-10-13 (TRA-398): the name is pinned by ios/scripts/check.sh and test/ios-check.test.ts (Preview pass),
	// so it stays although the test now covers Today / Genres / Search and the search sheet.
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
		XCTAssertFalse(app.otherElements["invalid-configuration"].exists)

		let today = app.tabBars.buttons["Aujourd’hui"]
		XCTAssertTrue(today.waitForExistence(timeout: 2))
		XCTAssertTrue(app.tabBars.buttons["Genres"].exists)
		XCTAssertTrue(app.tabBars.buttons["Recherche"].exists)
		XCTAssertFalse(app.tabBars.buttons["Réglages"].exists)
		XCTAssertTrue(app.buttons["profile-choose"].waitForExistence(timeout: 2))

		app.tabBars.buttons["Genres"].tap()
		XCTAssertTrue(app.buttons["profile-settings-edit"].waitForExistence(timeout: 2))
		XCTAssertTrue(app.buttons["analytics-settings"].exists)

		today.tap()
		XCTAssertTrue(app.buttons["profile-choose"].waitForExistence(timeout: 2))

		app.tabBars.buttons["Recherche"].tap()
		let sheet = app.descendants(matching: .any)["search-sheet"]
		XCTAssertTrue(sheet.waitForExistence(timeout: 2))
		dismiss(sheet)
		// The sheet did not take the selection: Today is still the tab under it.
		XCTAssertTrue(today.isSelected)
		XCTAssertTrue(app.buttons["profile-choose"].waitForExistence(timeout: 2))
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

		for tab in ["Aujourd’hui", "Genres", "Recherche"] {
			let button = app.tabBars.buttons[tab]
			XCTAssertTrue(button.waitForExistence(timeout: 2))
			XCTAssertGreaterThanOrEqual(button.frame.height, 44)
			button.tap()
			switch tab {
			case "Aujourd’hui":
				XCTAssertTrue(app.buttons["profile-choose"].waitForExistence(timeout: 2))
			case "Genres":
				XCTAssertTrue(app.buttons["profile-settings-edit"].waitForExistence(timeout: 2))
			case "Recherche":
				let sheet = app.descendants(matching: .any)["search-sheet"]
				XCTAssertTrue(sheet.waitForExistence(timeout: 2))
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

	/// Swipes the sheet down from its empty area; a tap outside does not exist on a full-height sheet.
	@MainActor
	private func dismiss(_ sheet: XCUIElement) {
		let start = sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
		let end = sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
		start.press(forDuration: 0.1, thenDragTo: end)
		XCTAssertTrue(sheet.waitForNonExistence(timeout: 2))
	}
}
