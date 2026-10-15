import XCTest

final class ProfileFlowTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	/// 2026-10-14 (J.4): the first launch chains Welcome (1.1), the families (1.2), one step per family (1.3, 1.4)
	/// and Today, which shows the loading screen (1.6) until the recommendation is there. It replaces the flat
	/// screen of the old flow, which the first launch no longer reaches.
	@MainActor
	func testFirstLaunchChainsTheOnboardingToTodayAndIsNotShownAgain() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)

		// 1.1: the brand moment is the whole app until the person starts.
		let start = app.buttons["onboarding-start"]
		XCTAssertTrue(start.waitForExistence(timeout: 10))
		XCTAssertFalse(app.tabBars.firstMatch.exists)
		UITestFlows.screenshot(named: "1.1", in: self)
		start.tap()

		// 1.2: nothing chosen, nothing to continue with.
		let continueGenres = app.buttons["onboarding-genres-continue"]
		XCTAssertTrue(continueGenres.waitForExistence(timeout: 10))
		XCTAssertFalse(continueGenres.isEnabled)
		UITestFlows.screenshot(named: "1.2a", in: self)
		tapTile("family-0", in: app)
		tapTile("family-1", in: app)
		XCTAssertTrue(continueGenres.isEnabled)
		UITestFlows.screenshot(named: "1.2b", in: self)
		continueGenres.tap()

		// 1.3: the first family, its published genres, all of them at once. The help line says
		// that an empty list would count the same.
		let all = app.buttons["Tous"]
		XCTAssertTrue(all.waitForExistence(timeout: 10))
		XCTAssertTrue(element(app, "subgenre-row-local:genre-0a").exists)
		XCTAssertTrue(app.staticTexts["Sans sous-genre coché, toute la famille compte."].exists)
		all.tap()
		XCTAssertTrue(app.buttons["Tous"].isSelected)
		UITestFlows.screenshot(named: "1.3", in: self)
		UITestFlows.tapWhenReady(app.buttons["onboarding-subgenres-continue"])

		// 1.4: the last family, one genre, and the total carries over from the first step.
		let row = app.descendants(matching: .any)["subgenre-row-local:genre-1a"]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		let counter = app.descendants(matching: .any)["bottom-counter"]
		XCTAssertTrue(counter.waitForExistence(timeout: 5))
		XCTAssertEqual(counter.label, "Total : 2 genres")
		UITestFlows.screenshot(named: "1.4", in: self)
		let finish = app.buttons["onboarding-subgenres-continue"]
		XCTAssertEqual(finish.label, "Terminer")
		finish.tap()

		// 1.6, then Today: the onboarding is gone and the tabs are there.
		UITestFlows.screenshot(named: "1.6", in: self)
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		XCTAssertTrue(app.tabBars.buttons["Aujourd’hui"].exists)
		XCTAssertFalse(app.buttons["onboarding-start"].exists)

		// A launch without reset finds the profile: no onboarding, Today again.
		UITestFlows.relaunch(app, catalog: Self.taxonomyCatalog)
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		XCTAssertFalse(app.buttons["onboarding-start"].exists)

		// The settings count what the saved selection holds: it was written, and read back after the relaunch.
		app.tabBars.buttons["Genres"].tap()
		XCTAssertEqual(openSettings(in: app).value as? String, "2 familles · 2 sous-genres")
	}

	@MainActor
	func testTheBackGestureOfTheSecondStepKeepsTheSelection() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		tapTile("family-0", in: app)
		tapTile("family-1", in: app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-genres-continue"])
		UITestFlows.tapWhenReady(app.buttons["Tous"])
		UITestFlows.tapWhenReady(app.buttons["onboarding-subgenres-continue"])
		let secondStep = app.descendants(matching: .any)["subgenre-row-local:genre-1a"]
		XCTAssertTrue(secondStep.waitForExistence(timeout: 10))

		// The edge swipe is the way back: the bar is hidden and Figma draws no back control.
		// A short press at x = 0 and a fast drag: a slow one is read as a scroll, not as the edge gesture.
		let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
		edge.press(
			forDuration: 0.01, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)),
			withVelocity: .fast, thenHoldForDuration: 0)
		XCTAssertTrue(secondStep.waitForNonExistence(timeout: 10))

		XCTAssertTrue(app.descendants(matching: .any)["subgenre-row-local:genre-0a"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.buttons["Tous"].isSelected)
		let counter = app.descendants(matching: .any)["bottom-counter"]
		XCTAssertEqual(counter.label, "Total : 1 genre")
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
		UITestFlows.declineConsent(app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		tapTile("family-0", in: app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-genres-continue"])
		UITestFlows.tapWhenReady(app.buttons["onboarding-subgenres-continue"])

		// The write failed: the flow stays where it is, and the same button writes again.
		let alert = app.alerts["Enregistrement indisponible"]
		XCTAssertTrue(alert.waitForExistence(timeout: 10))
		XCTAssertFalse(app.tabBars.firstMatch.exists)
		alert.buttons["OK"].tap()
		XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
		UITestFlows.tapWhenReady(app.buttons["onboarding-subgenres-continue"])
		XCTAssertTrue(app.tabBars.buttons["Genres"].waitForExistence(timeout: 10))
	}

	@MainActor
	func testCorruptProfileCanBeExplicitlyPurgedThenRecreated() {
		let app = XCUIApplication()
		app.launchArguments = [
			"-AppleLanguages", "(fr)", "-track1-reset-analytics-consent", "-track1-seed-corrupt-profile",
		]
		app.launchEnvironment = ["TRACK1_PROFILE_CATALOG_JSON": catalogFixture]
		app.launch()
		UITestFlows.declineConsent(app)

		XCTAssertTrue(app.staticTexts["profile-recovery-message"].waitForExistence(timeout: 10))
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

		// 2026-10-14 (J.4): with no profile left the app is the first launch again, not a tab with a button.
		XCTAssertTrue(app.buttons["onboarding-start"].waitForExistence(timeout: 10))
		XCTAssertFalse(app.tabBars.firstMatch.exists)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		tapTile("family-0", in: app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-genres-continue"])
		UITestFlows.tapWhenReady(app.buttons["onboarding-subgenres-continue"])
		XCTAssertTrue(app.tabBars.buttons["Genres"].waitForExistence(timeout: 10))
		app.tabBars.buttons["Genres"].tap()
		_ = openSettings(in: app)
		// A family left whole has no ticked genre: the count says so.
		XCTAssertEqual(app.buttons["profile-settings-edit"].value as? String, "1 famille · 0 sous-genre")
	}

	@MainActor
	func testTheGenresTabShowsTheFamiliesOfTheProfileAndOpensTheSettings() {
		let app = firstProfile()
		app.tabBars.buttons["Genres"].tap()

		XCTAssertTrue(app.staticTexts["Mes genres"].waitForExistence(timeout: 5))
		XCTAssertTrue(tile("family-0", in: app).waitForExistence(timeout: 5))
		XCTAssertFalse(tile("family-1", in: app).exists)
		XCTAssertTrue(app.buttons["genres-edit"].exists)
		UITestFlows.screenshot(named: "3.3-genres", in: self)

		// The settings are the sheet of the icon button, and the analytics row is one of them.
		app.buttons["genres-settings"].tap()
		XCTAssertTrue(app.buttons["analytics-settings"].waitForExistence(timeout: 5))
		app.buttons["Fermer"].tap()
		XCTAssertTrue(app.buttons["genres-edit"].waitForExistence(timeout: 5))
	}

	@MainActor
	func testEditingTheGenresAddsAFamilyThenTodayIsComputedAgain() {
		let app = firstProfile()
		app.tabBars.buttons["Genres"].tap()
		app.buttons["genres-edit"].tap()

		// The edit flow opens on the genre step, with no Welcome: the current family is already chosen.
		XCTAssertTrue(tile("family-1", in: app).waitForExistence(timeout: 5))
		tile("family-1", in: app).tap()
		UITestFlows.screenshot(named: "3.3-edit-genres", in: self)
		app.buttons["Continuer"].tap()
		// One genre step per family: the first one ends on "Continuer", the last one on "Enregistrer".
		XCTAssertTrue(app.buttons["Tous"].waitForExistence(timeout: 5))
		app.buttons["Continuer"].tap()
		XCTAssertTrue(app.buttons["Enregistrer"].waitForExistence(timeout: 5))
		app.buttons["Enregistrer"].tap()

		// The flow ends on Today, which loads the recommendation again for the new revision of the profile.
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		app.tabBars.buttons["Genres"].tap()
		XCTAssertTrue(tile("family-1", in: app).waitForExistence(timeout: 5))
		XCTAssertTrue(tile("family-0", in: app).exists)
	}

	/// 2026-10-15 (TRA-519, plan D4): a catalog whose taxonomy is degraded has no families to offer. The first
	/// launch says so and lets the person try again, rather than showing an empty grid.
	@MainActor
	func testADegradedCatalogMakesTheFirstLaunchUnavailableAndRetryable() {
		let app = UITestFlows.launch(catalog: Self.degradedCatalog)
		UITestFlows.declineConsent(app)

		XCTAssertTrue(element(app, "today-unavailable").waitForExistence(timeout: 10))
		XCTAssertFalse(app.buttons["onboarding-start"].exists)
		app.buttons["today-retry"].tap()
		XCTAssertTrue(element(app, "today-unavailable").waitForExistence(timeout: 10))
		XCTAssertFalse(app.buttons["onboarding-start"].exists)
	}

	/// Same degradation once a profile exists: Today keeps working off the stored `genre_ids`, and the Genres
	/// tab reads as unavailable, with its edit button off, until the taxonomy is back.
	@MainActor
	func testADegradedCatalogKeepsTodayAndMakesTheGenresTabUnavailable() {
		let app = firstProfile()
		UITestFlows.relaunch(app, catalog: Self.degradedCatalog)

		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		app.tabBars.buttons["Genres"].tap()
		XCTAssertTrue(app.buttons["genres-retry"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons["genres-edit"].isEnabled)
	}

	/// A profile of the first parent of the taxonomy catalog, made by the first-launch flow.
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
	@MainActor
	private func tile(_ key: String, in app: XCUIApplication) -> XCUIElement {
		element(app, "genre-tile-\(key)")
	}

	@MainActor
	private func tapTile(_ key: String, in app: XCUIApplication) {
		UITestFlows.tapWhenReady(app.buttons["genre-tile-\(key)"])
	}

	@MainActor
	private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
		app.descendants(matching: .any)[identifier].firstMatch
	}

	/// Three families (`family-0` to `family-2`), each with one published genre (`local:genre-3` to `-5`) whose
	/// slug is a genre node of the catalog: the taxonomy the flow reads (plan D4).
	private var catalogFixture: String {
		"""
		{"version":"v1","revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taxonomy":{"mode":"editorial","version":2,"families":[{"key":"family-0","label":"Family 0","order":1},{"key":"family-1","label":"Family 1","order":2},{"key":"family-2","label":"Family 2","order":3}],"genres":[{"id":"local:genre-3","name":"Genre 3","family":"family-0","slugs":["genre:genre-3"]},{"id":"local:genre-4","name":"Genre 4","family":"family-1","slugs":["genre:genre-4"]},{"id":"local:genre-5","name":"Genre 5","family":"family-2","slugs":["genre:genre-5"]}],"legacySelectionBySlug":{}},"nodes":[{"identity":"genre:genre-0","type":"genre","name":"Genre 0","teaser":null},{"identity":"genre:genre-1","type":"genre","name":"Genre 1","teaser":null},{"identity":"genre:genre-2","type":"genre","name":"Genre 2","teaser":null},{"identity":"genre:genre-3","type":"genre","name":"Genre 3","teaser":null},{"identity":"genre:genre-4","type":"genre","name":"Genre 4","teaser":null},{"identity":"genre:genre-5","type":"genre","name":"Genre 5","teaser":null}],"edges":[]}
		"""
	}

	private static let editorialTaxonomy =
		"""
		{"mode":"editorial","version":2,"families":[{"key":"family-0","label":"Family 0","order":1},{"key":"family-1","label":"Family 1","order":2}],"genres":[{"id":"local:genre-0a","name":"Genre 0a","family":"family-0","slugs":["genre:genre-0a"]},{"id":"local:genre-1a","name":"Genre 1a","family":"family-1","slugs":["genre:genre-1a"]}],"legacySelectionBySlug":{}}
		"""

	private static let degradedTaxonomy = #"{"mode":"degraded","available":true}"#

	/// Two families with one published genre each, and the works of the Today fixtures linked to both genres:
	/// the pick exists for a profile of one family and for a profile of two.
	private static let taxonomyCatalog = catalog(taxonomy: editorialTaxonomy)

	/// The same nodes and edges with the taxonomy the server serves when it cannot build the editorial one.
	private static let degradedCatalog = catalog(taxonomy: degradedTaxonomy)

	private static func catalog(taxonomy: String) -> String {
		"""
		{"version":"v1","revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taxonomy":\(taxonomy),"nodes":[{"identity":"genre:genre-0","type":"genre","name":"Genre 0","teaser":null},{"identity":"genre:genre-1","type":"genre","name":"Genre 1","teaser":null},{"identity":"genre:genre-0a","type":"genre","name":"Genre 0a","teaser":null},{"identity":"genre:genre-1a","type":"genre","name":"Genre 1a","teaser":null},{"identity":"artist:artist-a","type":"artist","name":"Artist A","teaser":null},{"identity":"project:project-a","type":"project","name":"Project A","teaser":null},{"identity":"track:track-a","type":"track","name":"Track A","teaser":null}],"edges":[{"source":"artist:artist-a","target":"genre:genre-0a","type":"genres"},{"source":"project:project-a","target":"genre:genre-0a","type":"genres"},{"source":"track:track-a","target":"genre:genre-0a","type":"genres"},{"source":"artist:artist-a","target":"genre:genre-1a","type":"genres"},{"source":"project:project-a","target":"genre:genre-1a","type":"genres"},{"source":"track:track-a","target":"genre:genre-1a","type":"genres"}]}
		"""
	}
}
