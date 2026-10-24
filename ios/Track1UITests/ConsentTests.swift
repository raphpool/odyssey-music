import XCTest

// 2026-10-14 (J.4): the app shows the onboarding, not the tabs, until there is a profile. Each test goes
// through the first launch on the fixtures to reach the tabs, as the consent no longer leads to them directly.
final class ConsentTests: XCTestCase {
	@MainActor
	func testAcceptingConsentUnblocksTheApp() {
		let app = UITestFlows.launch()
		app.buttons["analytics-consent-accept"].tap()
		UITestFlows.completeOnboarding(app)
		XCTAssertTrue(UITestFlows.tabBar(in: app).waitForExistence(timeout: 10))
	}

	@MainActor
	func testDecliningConsentUnblocksTheApp() {
		let app = UITestFlows.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		XCTAssertTrue(UITestFlows.tabBar(in: app).waitForExistence(timeout: 10))
	}

	@MainActor
	func testConsentCanBeChangedFromSettings() {
		let app = UITestFlows.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		XCTAssertTrue(UITestFlows.tabButton("Genres", in: app).waitForExistence(timeout: 10))
		UITestFlows.tabButton("Genres", in: app).tap()
		// K.1: the settings are the sheet of the Genres tab.
		app.buttons["genres-settings"].tap()
		XCTAssertTrue(app.buttons["analytics-settings"].waitForExistence(timeout: 5))
		app.buttons["analytics-settings"].tap()
		app.buttons["analytics-consent-accept"].tap()
		XCTAssertTrue(UITestFlows.tabBar(in: app).exists)
	}
}
