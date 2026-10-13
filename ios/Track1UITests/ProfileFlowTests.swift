import XCTest

final class ProfileFlowTests: XCTestCase {
	@MainActor
	func testSelectionThresholdModificationCancellationAndRelaunch() {
		let app = launchApp(resetProfile: true)
		app.buttons["analytics-consent-decline"].tap()
		app.buttons["profile-choose"].tap()

		let firstGenre = app.buttons["genre-genre:genre-0"]
		XCTAssertTrue(firstGenre.waitForExistence(timeout: 2))
		// 2026-10-13: the minimum is one genre (D13, TRA-402); it used to need three.
		XCTAssertFalse(app.buttons["profile-continue"].isEnabled)
		firstGenre.tap()
		XCTAssertTrue(app.buttons["profile-continue"].isEnabled)
		app.buttons["genre-genre:genre-1"].tap()
		app.buttons["genre-genre:genre-2"].tap()
		XCTAssertTrue(app.buttons["profile-continue"].isEnabled)
		attachScreenshot(named: "profile-selection-saved-fixture")
		app.buttons["profile-continue"].tap()

		app.tabBars.buttons["Réglages"].tap()
		let edit = app.buttons["profile-settings-edit"]
		XCTAssertTrue(edit.waitForExistence(timeout: 2))
		XCTAssertTrue(app.staticTexts["Votre profil musical reste sur ce téléphone."].exists)
		attachScreenshot(named: "profile-settings-saved-fixture")
		edit.tap()
		app.buttons["genre-genre:genre-0"].tap()
		app.buttons["genre-genre:genre-3"].tap()
		app.buttons["profile-continue"].tap()

		edit.tap()
		app.buttons["genre-genre:genre-1"].tap()
		app.buttons["Annuler"].tap()
		XCTAssertTrue(edit.waitForExistence(timeout: 2))

		app.terminate()
		app.launchArguments = ["-AppleLanguages", "(fr)"]
		app.launchEnvironment = ["TRACK1_PROFILE_CATALOG_JSON": catalogFixture]
		app.launch()
		XCTAssertTrue(app.tabBars.buttons["Réglages"].waitForExistence(timeout: 2))
		app.tabBars.buttons["Réglages"].tap()
		XCTAssertEqual(app.buttons["profile-settings-edit"].value as? String, "3 genres sélectionnés")
	}

	@MainActor
	func testRefusingAnalyticsStillAllowsSearchWithoutAProfile() {
		let app = launchApp(resetProfile: true)
		app.buttons["analytics-consent-decline"].tap()
		let explore = app.buttons["profile-explore-search"]
		XCTAssertTrue(explore.waitForExistence(timeout: 2))
		explore.tap()
		XCTAssertTrue(app.buttons["entry-status-search"].waitForExistence(timeout: 2))
	}

	@MainActor
	func testFailedProfileWriteShowsAnErrorAndCanBeRetried() {
		let app = XCUIApplication()
		app.launchArguments = [
			"-AppleLanguages", "(fr)", "-track1-reset-analytics-consent", "-track1-reset-profile",
			"-track1-fail-next-profile-write",
		]
		app.launchEnvironment = ["TRACK1_PROFILE_CATALOG_JSON": catalogFixture]
		app.launch()
		app.buttons["analytics-consent-decline"].tap()
		app.buttons["profile-choose"].tap()
		for index in 0..<3 {
			app.buttons["genre-genre:genre-\(index)"].tap()
		}
		app.buttons["profile-continue"].tap()

		XCTAssertTrue(app.staticTexts["profile-storage-error"].waitForExistence(timeout: 2))
		XCTAssertFalse(app.buttons["profile-continue"].exists)

		app.buttons["Réessayer"].tap()
		XCTAssertTrue(app.buttons["profile-continue"].waitForExistence(timeout: 2))
		app.buttons["profile-continue"].tap()
		XCTAssertTrue(app.tabBars.buttons["Réglages"].waitForExistence(timeout: 2))
	}

	@MainActor
	func testCorruptProfileCanBeExplicitlyPurgedThenRecreated() {
		let app = XCUIApplication()
		app.launchArguments = [
			"-AppleLanguages", "(fr)", "-track1-reset-analytics-consent", "-track1-seed-corrupt-profile",
		]
		app.launchEnvironment = ["TRACK1_PROFILE_CATALOG_JSON": catalogFixture]
		app.launch()
		app.buttons["analytics-consent-decline"].tap()

		XCTAssertTrue(app.staticTexts["profile-recovery-message"].waitForExistence(timeout: 2))
		app.tabBars.buttons["Réglages"].tap()
		let recover = app.buttons["profile-recover"]
		XCTAssertTrue(recover.waitForExistence(timeout: 2))
		recover.tap()
		app.alerts.buttons["Annuler"].tap()
		XCTAssertTrue(recover.exists)
		recover.tap()
		app.alerts.buttons["Effacer"].tap()

		let edit = app.buttons["profile-settings-edit"]
		XCTAssertTrue(edit.waitForExistence(timeout: 2))
		edit.tap()
		for index in 0..<3 {
			app.buttons["genre-genre:genre-\(index)"].tap()
		}
		app.buttons["profile-continue"].tap()
		XCTAssertTrue(app.buttons["profile-settings-edit"].waitForExistence(timeout: 2))
		XCTAssertEqual(app.buttons["profile-settings-edit"].value as? String, "3 genres sélectionnés")
	}

	@MainActor
	private func launchApp(resetProfile: Bool) -> XCUIApplication {
		let app = XCUIApplication()
		app.launchArguments = ["-AppleLanguages", "(fr)", "-track1-reset-analytics-consent"]
		if resetProfile { app.launchArguments.append("-track1-reset-profile") }
		app.launchEnvironment = ["TRACK1_PROFILE_CATALOG_JSON": catalogFixture]
		app.launch()
		return app
	}

	private var catalogFixture: String {
		"""
		{"version":"v1","revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taxonomy":{"mode":"degraded","available":true},"nodes":[{"identity":"genre:genre-0","type":"genre","name":"Genre 0","teaser":null},{"identity":"genre:genre-1","type":"genre","name":"Genre 1","teaser":null},{"identity":"genre:genre-2","type":"genre","name":"Genre 2","teaser":null},{"identity":"genre:genre-3","type":"genre","name":"Genre 3","teaser":null}],"edges":[]}
		"""
	}

	@MainActor
	private func attachScreenshot(named name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
