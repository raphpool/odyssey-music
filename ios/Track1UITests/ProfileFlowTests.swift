import XCTest

final class ProfileFlowTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

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

		// 2026-10-14 (K.1): the settings are a sheet of the Genres tab, and "Modifier les goûts" opens the
		// edit flow of the taxonomy (genre step, then one step per parent) instead of the flat screen.
		app.tabBars.buttons["Genres"].tap()
		let edit = openSettings(in: app)
		XCTAssertTrue(app.staticTexts["Votre profil musical reste sur ce téléphone."].exists)
		attachScreenshot(named: "profile-settings-saved-fixture")
		edit.tap()
		// Two parents out of three go: the one left has one step, which ends on "Enregistrer".
		XCTAssertTrue(tile("genre:genre-0", in: app).waitForExistence(timeout: 5))
		tile("genre:genre-0", in: app).tap()
		tile("genre:genre-1", in: app).tap()
		app.buttons["Continuer"].tap()
		XCTAssertTrue(app.buttons["Enregistrer"].waitForExistence(timeout: 5))
		app.buttons["Enregistrer"].tap()
		// The sheet closes once the profile is written: only then is it safe to kill the app.
		XCTAssertTrue(app.buttons["Enregistrer"].waitForNonExistence(timeout: 10))

		app.terminate()
		app.launchArguments = ["-AppleLanguages", "(fr)"]
		app.launchEnvironment = ["TRACK1_PROFILE_CATALOG_JSON": catalogFixture]
		app.launch()
		XCTAssertTrue(app.tabBars.buttons["Genres"].waitForExistence(timeout: 5))
		app.tabBars.buttons["Genres"].tap()
		_ = openSettings(in: app)
		XCTAssertEqual(app.buttons["profile-settings-edit"].value as? String, "1 genre sélectionné")
	}

	@MainActor
	func testRefusingAnalyticsStillAllowsSearchWithoutAProfile() {
		let app = launchApp(resetProfile: true)
		app.buttons["analytics-consent-decline"].tap()
		let explore = app.buttons["profile-explore-search"]
		XCTAssertTrue(explore.waitForExistence(timeout: 2))
		explore.tap()
		XCTAssertTrue(app.descendants(matching: .any)["search-sheet"].waitForExistence(timeout: 2))
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
		XCTAssertTrue(app.tabBars.buttons["Genres"].waitForExistence(timeout: 2))
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
		app.tabBars.buttons["Genres"].tap()
		// 2026-10-14 (K.1): the settings, where a corrupt profile is deleted, open from the Genres tab.
		XCTAssertTrue(app.staticTexts["genres-recovery-message"].waitForExistence(timeout: 5))
		app.buttons["genres-settings"].tap()
		let recover = app.buttons["profile-recover"]
		XCTAssertTrue(recover.waitForExistence(timeout: 5))
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
		XCTAssertTrue(app.buttons["genres-settings"].waitForExistence(timeout: 5))
		app.buttons["genres-settings"].tap()
		XCTAssertTrue(app.buttons["profile-settings-edit"].waitForExistence(timeout: 5))
		XCTAssertEqual(app.buttons["profile-settings-edit"].value as? String, "3 genres sélectionnés")
	}

	@MainActor
	func testTheGenresTabShowsTheParentsOfTheProfileAndOpensTheSettings() {
		let app = firstProfile()
		app.tabBars.buttons["Genres"].tap()

		XCTAssertTrue(app.staticTexts["Mes genres"].waitForExistence(timeout: 5))
		XCTAssertTrue(tile("genre:genre-0", in: app).waitForExistence(timeout: 5))
		XCTAssertFalse(tile("genre:genre-1", in: app).exists)
		XCTAssertTrue(app.buttons["genres-edit"].exists)
		UITestFlows.screenshot(named: "3.3-genres", in: self)

		// The settings are the sheet of the icon button, and the analytics row is one of them.
		app.buttons["genres-settings"].tap()
		XCTAssertTrue(app.buttons["analytics-settings"].waitForExistence(timeout: 5))
		app.buttons["Fermer"].tap()
		XCTAssertTrue(app.buttons["genres-edit"].waitForExistence(timeout: 5))
	}

	@MainActor
	func testEditingTheGenresAddsAParentThenTodayIsComputedAgain() {
		let app = firstProfile()
		app.tabBars.buttons["Genres"].tap()
		app.buttons["genres-edit"].tap()

		// The edit flow opens on the genre step, with no Welcome: the current parent is already chosen.
		XCTAssertTrue(tile("genre:genre-1", in: app).waitForExistence(timeout: 5))
		tile("genre:genre-1", in: app).tap()
		UITestFlows.screenshot(named: "3.3-edit-genres", in: self)
		app.buttons["Continuer"].tap()
		// One subgenre step per parent: the first one ends on "Continuer", the last one on "Enregistrer".
		XCTAssertTrue(app.buttons["Tous"].waitForExistence(timeout: 5))
		app.buttons["Continuer"].tap()
		XCTAssertTrue(app.buttons["Enregistrer"].waitForExistence(timeout: 5))
		app.buttons["Enregistrer"].tap()

		// The flow ends on Today, which loads the recommendation again for the new revision of the profile.
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		app.tabBars.buttons["Genres"].tap()
		XCTAssertTrue(tile("genre:genre-1", in: app).waitForExistence(timeout: 5))
		XCTAssertTrue(tile("genre:genre-0", in: app).exists)
	}

	/// A profile of the first parent of the taxonomy catalog, made by the screen that still creates profiles.
	@MainActor
	private func firstProfile() -> XCUIApplication {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		return app
	}

	/// The settings sheet of the Genres tab; returns its "Goûts musicaux" row.
	@MainActor
	private func openSettings(in app: XCUIApplication) -> XCUIElement {
		app.buttons["genres-settings"].tap()
		let edit = app.buttons["profile-settings-edit"]
		XCTAssertTrue(edit.waitForExistence(timeout: 5))
		return edit
	}

	/// A tile is a button on the genre step and plain content on the tab: any element type will do.
	private func tile(_ identity: String, in app: XCUIApplication) -> XCUIElement {
		element(app, "genre-tile-\(identity)")
	}

	private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
		app.descendants(matching: .any)[identifier]
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

	/// Three parents (genres 0 to 2), each with one subgenre (3 to 5): the taxonomy the edit flow reads (D13).
	private var catalogFixture: String {
		"""
		{"version":"v1","revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taxonomy":{"mode":"degraded","available":true},"nodes":[{"identity":"genre:genre-0","type":"genre","name":"Genre 0","teaser":null},{"identity":"genre:genre-1","type":"genre","name":"Genre 1","teaser":null},{"identity":"genre:genre-2","type":"genre","name":"Genre 2","teaser":null},{"identity":"genre:genre-3","type":"genre","name":"Genre 3","teaser":null},{"identity":"genre:genre-4","type":"genre","name":"Genre 4","teaser":null},{"identity":"genre:genre-5","type":"genre","name":"Genre 5","teaser":null}],"edges":[{"source":"genre:genre-0","target":"genre:genre-3","type":"subgenres"},{"source":"genre:genre-1","target":"genre:genre-4","type":"subgenres"},{"source":"genre:genre-2","target":"genre:genre-5","type":"subgenres"}]}
		"""
	}

	/// Two parents with a subgenre each, and the works of the Today fixtures linked to both: the pick exists
	/// for a profile of one parent and for a profile of two.
	private static let taxonomyCatalog = """
		{"version":"v1","revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taxonomy":{"mode":"degraded","available":true},"nodes":[{"identity":"genre:genre-0","type":"genre","name":"Genre 0","teaser":null},{"identity":"genre:genre-1","type":"genre","name":"Genre 1","teaser":null},{"identity":"genre:genre-0a","type":"genre","name":"Genre 0a","teaser":null},{"identity":"genre:genre-1a","type":"genre","name":"Genre 1a","teaser":null},{"identity":"artist:artist-a","type":"artist","name":"Artist A","teaser":null},{"identity":"project:project-a","type":"project","name":"Project A","teaser":null},{"identity":"track:track-a","type":"track","name":"Track A","teaser":null}],"edges":[{"source":"genre:genre-0","target":"genre:genre-0a","type":"subgenres"},{"source":"genre:genre-1","target":"genre:genre-1a","type":"subgenres"},{"source":"artist:artist-a","target":"genre:genre-0","type":"genres"},{"source":"project:project-a","target":"genre:genre-0","type":"genres"},{"source":"track:track-a","target":"genre:genre-0","type":"genres"},{"source":"artist:artist-a","target":"genre:genre-1","type":"genres"},{"source":"project:project-a","target":"genre:genre-1","type":"genres"},{"source":"track:track-a","target":"genre:genre-1","type":"genres"}]}
		"""

	@MainActor
	private func attachScreenshot(named name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
