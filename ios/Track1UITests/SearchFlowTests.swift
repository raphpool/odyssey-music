import XCTest

/// The search sheet (I.2), on the fixtures of the UI tests: no step touches the network (plan D3).
///
/// The journeys start from the first launch (J.4: there are no tabs before a profile): the sheet opens over
/// the tab that is selected, whatever it shows, and a page pushed from it must work the same over the page of
/// the day. The launch is the one of
/// `UITestFlows`, plus the `search` and `unavailable` sections and a page whose only relation leads nowhere.
final class SearchFlowTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	@MainActor
	func testSearchOpensACachedResultThenARelationThenGoesBackAndOffersThePageAsARecent() {
		let app = launch()

		// 1. The sheet opens with the field focused. No recent yet: no line.
		app.tabBars.buttons["Recherche"].tap()
		let sheet = element(app, "search-sheet")
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		let field = app.textFields["search-field"]
		XCTAssertTrue(field.waitForExistence(timeout: 5))
		XCTAssertTrue(waitForKeyboardFocus(field))
		XCTAssertFalse(element(app, "search-row-0").exists)

		// 2. The fixture query. The cached hit is the only row; capture D7 "3.1".
		field.typeText("artist")
		let row = element(app, "search-row-0")
		XCTAssertTrue(row.waitForExistence(timeout: 5))
		XCTAssertTrue(row.label.contains("Artist A"))
		UITestFlows.screenshot(named: "3.1", in: self)

		// 3. The sheet closes and the page opens on the current tab.
		row.tap()
		XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))
		let title = element(app, "node-title")
		XCTAssertTrue(title.waitForExistence(timeout: 10))
		XCTAssertEqual(title.label, "Artist A")
		XCTAssertTrue(element(app, "top-bar-breadcrumb").waitForExistence(timeout: 5))

		// 4. A chip pushes a related page; the crumb of the first page goes back to it.
		tapFirstChip(in: app)
		XCTAssertTrue(waitForCrumb(app, index: 1))
		XCTAssertNotEqual(title.label, "Artist A")
		app.buttons["top-bar-crumb-0"].tap()
		XCTAssertTrue(app.buttons["top-bar-crumb-0"].waitForNonExistence(timeout: 5))
		XCTAssertEqual(title.label, "Artist A")

		// 5. An empty query lists the pages seen, the one of the search among them.
		app.tabBars.buttons["Recherche"].tap()
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		let recent = app.buttons.matching(
			NSPredicate(format: "identifier BEGINSWITH 'search-row-' AND label CONTAINS 'Artist A'")
		).firstMatch
		XCTAssertTrue(recent.waitForExistence(timeout: 5))
	}

	@MainActor
	func testACatalogResultWithoutACardIsDisabledAndOpensNothing() {
		let app = launch()

		app.tabBars.buttons["Recherche"].tap()
		let field = app.textFields["search-field"]
		XCTAssertTrue(field.waitForExistence(timeout: 5))
		field.typeText("mezzanine")

		let row = element(app, "search-missing-0")
		XCTAssertTrue(row.waitForExistence(timeout: 5))
		XCTAssertFalse(element(app, "search-row-0").exists)
		XCTAssertFalse(row.isEnabled)
		XCTAssertTrue(row.label.contains("Pas encore de fiche"))

		row.tap()
		// Nothing to wait for: the tap must have no effect, and a page would be there within a second.
		XCTAssertFalse(element(app, "node-title").waitForExistence(timeout: 2))
		XCTAssertFalse(element(app, "node-failed").exists)
		XCTAssertTrue(element(app, "search-sheet").exists)
	}

	@MainActor
	func testAnUnavailablePageShowsItsRetryAndARelationToNowhereShowsMissing() {
		let app = launch()

		// A cached hit whose page the server cannot serve (`unavailable`).
		app.tabBars.buttons["Recherche"].tap()
		var field = app.textFields["search-field"]
		XCTAssertTrue(field.waitForExistence(timeout: 5))
		field.typeText("ghost")
		let ghost = element(app, "search-row-0")
		XCTAssertTrue(ghost.waitForExistence(timeout: 5))
		ghost.tap()
		XCTAssertTrue(element(app, "node-failed").waitForExistence(timeout: 10))
		XCTAssertTrue(element(app, "node-retry").exists)

		// The page that exists links to an identity the fixtures do not know.
		app.tabBars.buttons["Recherche"].tap()
		field = app.textFields["search-field"]
		XCTAssertTrue(field.waitForExistence(timeout: 5))
		field.typeText("lonely")
		let lonely = element(app, "search-row-0")
		XCTAssertTrue(lonely.waitForExistence(timeout: 5))
		lonely.tap()
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 10))
		tapFirstChip(in: app)
		XCTAssertTrue(element(app, "node-missing").waitForExistence(timeout: 10))
	}

	@MainActor
	func testTheFieldIsInTheSheetInDarkModeAndAtTheLargestTextSize() {
		let app = launch(extraArguments: [
			"-AppleInterfaceStyle", "Dark",
			"-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
		])

		app.tabBars.buttons["Recherche"].tap()
		XCTAssertTrue(element(app, "search-sheet").waitForExistence(timeout: 5))
		XCTAssertTrue(element(app, "search-field").waitForExistence(timeout: 5))
		UITestFlows.screenshot(named: "3.1-dark-xxxl", in: self)
	}

	// MARK: - Launch

	/// `UITestFlows.launch` with the search fixtures: its launch is private to the fixture it serves, so the
	/// same arguments are set here with the merged document, then consent is declined.
	@MainActor
	private func launch(extraArguments: [String] = []) -> XCUIApplication {
		let app = XCUIApplication()
		app.launchArguments =
			[
				"-AppleLanguages", "(fr)", "-track1-reset-analytics-consent", "-track1-reset-profile",
				"-track1-reset-daily-recommendation",
			] + extraArguments
		app.launchEnvironment = [
			"TRACK1_PROFILE_CATALOG_JSON": UITestFlows.catalogJSON,
			"TRACK1_UI_TEST_FIXTURES_JSON": Self.fixtures,
		]
		app.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		XCTAssertTrue(app.tabBars.buttons["Recherche"].waitForExistence(timeout: 10))
		return app
	}

	/// `UITestFlows.fixturesJSON` plus what the search needs: the hits of four queries, the identity that is
	/// unavailable, and an artist whose only relation points at a genre that has no page.
	private static let fixtures: String = {
		func hit(_ source: String, _ type: String, _ name: String, slug: String? = nil) -> [String: Any] {
			var hit: [String: Any] = ["source": source, "type": type, "name": name]
			if let slug { hit["slug"] = slug }
			return hit
		}
		func body(_ query: String, _ hits: [[String: Any]]) -> [String: Any] {
			let cached = hits.filter { $0["source"] as? String == "cache" }.count
			return ["q": query, "hits": hits, "sources": ["cache": cached, "catalog": hits.count - cached]]
		}
		guard
			var root = (try? JSONSerialization.jsonObject(with: Data(UITestFlows.fixturesJSON.utf8)))
				as? [String: Any],
			var nodes = root["nodes"] as? [String: Any],
			var lonely = nodes["artist:artist-a"] as? [String: Any],
			var lonelyNode = lonely["node"] as? [String: Any]
		else { preconditionFailure("The base fixtures are not the document the search fixtures extend") }
		lonelyNode["id"] = "artist:lonely"
		lonelyNode["name"] = "Lonely"
		lonelyNode["edges"] = ["genres": [["slug": "genre:absent", "type": "genre", "name": "Absent"]]]
		lonely["node"] = lonelyNode
		nodes["artist:lonely"] = lonely
		root["nodes"] = nodes
		root["unavailable"] = ["artist:ghost"]
		root["search"] = [
			"artist": body("artist", [hit("cache", "artist", "Artist A", slug: "artist:artist-a")]),
			"mezzanine": body("mezzanine", [hit("catalog", "project", "Mezzanine")]),
			"ghost": body("ghost", [hit("cache", "artist", "Ghost", slug: "artist:ghost")]),
			"lonely": body("lonely", [hit("cache", "artist", "Lonely", slug: "artist:lonely")]),
		]
		guard let data = try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]) else {
			preconditionFailure("The search fixtures are not valid JSON")
		}
		return String(decoding: data, as: UTF8.self)
	}()

	// MARK: - Helpers

	@MainActor
	private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
		app.descendants(matching: .any)[identifier].firstMatch
	}

	/// The sheet focuses its field after the presentation, so the keyboard is awaited, not assumed.
	@MainActor
	private func waitForKeyboardFocus(_ field: XCUIElement) -> Bool {
		let focused = NSPredicate(format: "hasKeyboardFocus == true")
		return XCTWaiter().wait(
			for: [XCTNSPredicateExpectation(predicate: focused, object: field)], timeout: 5) == .completed
	}

	@MainActor
	private func waitForCrumb(_ app: XCUIApplication, index: Int) -> Bool {
		element(app, "top-bar-crumb-\(index)").waitForExistence(timeout: 10)
	}

	/// The first relation chip of the page, scrolled into view (the hero takes most of the first screen).
	@MainActor
	private func tapFirstChip(in app: XCUIApplication) {
		let chip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'edge-chip-'")).firstMatch
		XCTAssertTrue(chip.waitForExistence(timeout: 10))
		for _ in 0..<6 where !chip.isHittable { app.swipeUp() }
		XCTAssertTrue(chip.isHittable)
		chip.tap()
	}
}
