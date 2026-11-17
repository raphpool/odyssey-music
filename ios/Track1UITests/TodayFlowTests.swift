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

		// 3. The home of the day (TRA-736): a card with the date, the genres, the type, the title and "Découvrir".
		let title = element(app, "today-title")
		let discover = app.buttons["today-discover"]
		XCTAssertTrue(title.waitForExistence(timeout: 15), "today-title")
		XCTAssertTrue(element(app, "today-home").exists, "today-home")
		XCTAssertTrue(element(app, "node-type-badge").exists, "node-type-badge")
		XCTAssertTrue(discover.exists, "today-discover")
		let date = NSPredicate(format: "label MATCHES %@", "[0-9]{1,2} [A-ZÉÛ]{3}")
		XCTAssertTrue(app.descendants(matching: .any).matching(date).firstMatch.exists, "date badge")
		// The genres of the recommended work, not those of the profile (the fixture links every work to `genre-0`).
		XCTAssertTrue(app.staticTexts["Genre 0"].exists, "genre pill")
		let titleOfTheDay = title.label
		XCTAssertFalse(titleOfTheDay.isEmpty)
		// No edge, no fact, no page of the node, no streaming bar.
		let chips = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'edge-chip-'"))
		XCTAssertEqual(chips.count, 0)
		for absent in ["node-title", "facts", "streaming-bar"] {
			XCTAssertFalse(element(app, absent).exists, absent)
		}
		UITestFlows.screenshot(named: "2.x-today", in: self)

		// 4. "Découvrir" opens the reader of the same node.
		UITestFlows.tapWhenReady(discover)
		let player = element(app, "player")
		XCTAssertTrue(player.waitForExistence(timeout: 10), "player")
		let paragraph = element(app, "player-paragraph-0")
		XCTAssertTrue(paragraph.waitForExistence(timeout: 10), "player-paragraph-0")
		XCTAssertTrue(paragraph.label.contains(titleOfTheDay), "\(paragraph.label) is not about \(titleOfTheDay)")
		// R1: the drawn bar is the only one, the native bar must not come back on a pushed page.
		XCTAssertEqual(app.tabBars.count, 0)
		XCTAssertTrue(UITestFlows.tabBar(in: app).exists, "tab-bar")
		UITestFlows.screenshot(named: "3.2", in: self)

		// 5. The back button of the reader goes back to the home of the day.
		UITestFlows.tapWhenReady(app.buttons["player-back"])
		XCTAssertTrue(player.waitForNonExistence(timeout: 5), "player is gone")
		XCTAssertTrue(title.waitForExistence(timeout: 5), "today-title is back")
		XCTAssertEqual(title.label, titleOfTheDay)

		// 6. Tapping Today again from the reader goes back to the home too.
		UITestFlows.tapWhenReady(discover)
		XCTAssertTrue(player.waitForExistence(timeout: 10), "player")
		UITestFlows.tabButton("Aujourd’hui", in: app).tap()
		XCTAssertTrue(player.waitForNonExistence(timeout: 5), "player is gone")
		XCTAssertTrue(title.waitForExistence(timeout: 5), "today-title is back")
		XCTAssertEqual(title.label, titleOfTheDay)

		// 7. Without a reset argument, the same node of the day comes back.
		UITestFlows.relaunch(app)
		XCTAssertTrue(title.waitForExistence(timeout: 15), "today-title")
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
}
