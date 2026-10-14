import XCTest

final class TodayFlowTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	@MainActor
	func testTodayShowsTheNodeOfTheDayAndKeepsItThroughNavigationAndRelaunch() {
		let app = UITestFlows.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)

		// 3. The date and the page of the day.
		let date = element(app, "top-bar-date")
		let title = element(app, "node-title")
		XCTAssertTrue(title.waitForExistence(timeout: 15))
		XCTAssertTrue(date.exists)
		let titleOfTheDay = title.label
		XCTAssertFalse(titleOfTheDay.isEmpty)
		UITestFlows.screenshot(named: "2.x-today", in: self)

		// 4. A chip pushes the linked page, under a breadcrumb.
		tapFirstChip(in: app)
		let breadcrumb = element(app, "top-bar-breadcrumb")
		XCTAssertTrue(breadcrumb.waitForExistence(timeout: 5))
		UITestFlows.screenshot(named: "3.2", in: self)

		// 5. The root crumb goes back to the page of the day.
		app.buttons["top-bar-crumb--1"].tap()
		XCTAssertTrue(breadcrumb.waitForNonExistence(timeout: 5))
		XCTAssertTrue(date.waitForExistence(timeout: 5))
		XCTAssertEqual(title.label, titleOfTheDay)

		// 6. Tapping Today again from a pushed page goes back to the root too.
		tapFirstChip(in: app)
		XCTAssertTrue(breadcrumb.waitForExistence(timeout: 5))
		app.tabBars.buttons["Aujourd’hui"].tap()
		XCTAssertTrue(breadcrumb.waitForNonExistence(timeout: 5))
		XCTAssertTrue(date.waitForExistence(timeout: 5))
		XCTAssertEqual(title.label, titleOfTheDay)

		// 7. Without a reset argument, the same page of the day comes back.
		UITestFlows.relaunch(app)
		XCTAssertTrue(title.waitForExistence(timeout: 15))
		XCTAssertEqual(title.label, titleOfTheDay)
	}

	@MainActor
	func testACatalogWithoutLinkedWorksShowsTheEmptyStateAndOffersTheGenres() {
		let app = UITestFlows.launch(catalog: UITestFlows.catalogWithoutLinkedWorksJSON)
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)

		XCTAssertTrue(element(app, "today-empty").waitForExistence(timeout: 15))
		app.buttons["today-edit-genres"].tap()
		// 2026-10-14 (K.1): the button leads to the Genres tab, whose "Modifier mes genres" edits the profile.
		XCTAssertTrue(app.buttons["genres-edit"].waitForExistence(timeout: 5))
	}

	@MainActor
	private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
		app.descendants(matching: .any)[identifier].firstMatch
	}

	/// The first relation chip of the page, scrolled into view (the hero takes most of the first screen).
	@MainActor
	private func tapFirstChip(in app: XCUIApplication) {
		let chip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'edge-chip-'")).firstMatch
		XCTAssertTrue(chip.waitForExistence(timeout: 5))
		for _ in 0..<6 where !chip.isHittable { app.swipeUp() }
		XCTAssertTrue(chip.isHittable)
		chip.tap()
	}
}
