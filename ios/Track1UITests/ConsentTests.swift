import XCTest

final class ConsentTests: XCTestCase {
	func testAcceptingConsentUnblocksTheApp() {
		let app = launchApp()
		app.buttons["analytics-consent-accept"].tap()
		XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 2))
	}

	func testDecliningConsentUnblocksTheApp() {
		let app = launchApp()
		app.buttons["analytics-consent-decline"].tap()
		XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 2))
	}

	func testConsentCanBeChangedFromSettings() {
		let app = launchApp()
		app.buttons["analytics-consent-decline"].tap()
		app.tabBars.buttons["Genres"].tap()
		app.buttons["analytics-settings"].tap()
		app.buttons["analytics-consent-accept"].tap()
		XCTAssertTrue(app.tabBars.firstMatch.exists)
	}

	private func launchApp() -> XCUIApplication {
		let app = XCUIApplication()
		app.launchArguments = ["-AppleLanguages", "(fr)", "-track1-reset-analytics-consent"]
		app.launch()
		return app
	}
}
