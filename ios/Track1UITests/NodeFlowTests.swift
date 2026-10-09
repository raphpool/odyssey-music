import XCTest

final class NodeFlowTests: XCTestCase {
	@MainActor
	func testDetailOpensRelationAndReturnsToItsSource() {
		let app = launchNode("artist:fixture-artist")
		XCTAssertTrue(app.staticTexts["Fixture Artist"].waitForExistence(timeout: 2))
		XCTAssertTrue(app.images["node-image-unavailable"].waitForExistence(timeout: 2))
		attachScreenshot(of: app, named: "artist-with-image-fallback")

		XCTAssertTrue(app.buttons["Ouvrir Ambient"].waitForExistence(timeout: 2))
		app.buttons["Ouvrir Ambient"].tap()
		XCTAssertTrue(app.staticTexts["Une fiche de relation."].waitForExistence(timeout: 2))
		XCTAssertTrue(app.images["node-image-unavailable"].waitForExistence(timeout: 2))
		attachScreenshot(of: app, named: "relation-destination")
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(app.staticTexts["Une introduction fiable."].waitForExistence(timeout: 2))
		assertNoUnexpectedFixtureRequests(in: app)
	}

	@MainActor
	func testMissingNodeShowsItsNonGeneratingState() {
		let app = launchNode("artist:missing")
		XCTAssertTrue(app.staticTexts["Fiche indisponible"].waitForExistence(timeout: 2))
		attachScreenshot(of: app, named: "missing-node")
		assertNoUnexpectedFixtureRequests(in: app)
	}

	@MainActor
	func testUnavailableNodeShowsItsFailureState() {
		let app = launchNode("artist:unavailable")
		XCTAssertTrue(app.staticTexts["Impossible de charger cette fiche"].waitForExistence(timeout: 2))
		attachScreenshot(of: app, named: "unavailable-node")
		assertNoUnexpectedFixtureRequests(in: app)
	}

	@MainActor
	func testNodeStackSurvivesTabSwitching() {
		let app = launchNode("artist:fixture-artist")
		XCTAssertTrue(app.staticTexts["Fixture Artist"].waitForExistence(timeout: 2))

		app.tabBars.buttons["Aujourd’hui"].tap()
		XCTAssertTrue(app.buttons["profile-choose"].waitForExistence(timeout: 2))
		app.tabBars.buttons["Recherche"].tap()
		XCTAssertTrue(app.staticTexts["Fixture Artist"].waitForExistence(timeout: 2))
		assertNoUnexpectedFixtureRequests(in: app)
	}

	private func launchNode(_ identity: String) -> XCUIApplication {
		let app = XCUIApplication()
		app.launchArguments = [
			"-AppleLanguages", "(fr)",
			"-track1-reset-analytics-consent", "-track1-reset-profile",
			"-track1-ui-test-node", identity,
		]
		app.launch()
		XCTAssertTrue(app.buttons["analytics-consent-decline"].waitForExistence(timeout: 2))
		app.buttons["analytics-consent-decline"].tap()
		return app
	}

	private func assertNoUnexpectedFixtureRequests(in app: XCUIApplication) {
		let count = app.staticTexts["node-ui-test-unexpected-request-count"]
		let expectedZero = NSPredicate(format: "label == %@", "0")
		let expectation = XCTNSPredicateExpectation(predicate: expectedZero, object: count)
		XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 2), .completed)
		XCTAssertEqual(count.label, "0")
	}

	private func attachScreenshot(of app: XCUIApplication, named name: String) {
		let attachment = XCTAttachment(screenshot: app.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
