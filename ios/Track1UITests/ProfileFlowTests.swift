import XCTest

final class ProfileFlowTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	/// 2026-10-14 (J.4): the first launch chains Welcome (1.1), the genre accordion (1.2) and Today, which shows
	/// the loading screen (1.6) until the recommendation is there. It replaces the flat screen of the old flow,
	/// which the first launch no longer reaches. TRA-639: the accordion is the only genre screen.
	@MainActor
	func testFirstLaunchChainsTheOnboardingToTodayAndIsNotShownAgain() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)

		// 1.1: the brand moment is the whole app until the person starts.
		let start = app.buttons["onboarding-start"]
		XCTAssertTrue(start.waitForExistence(timeout: 10))
		XCTAssertFalse(UITestFlows.tabBar(in: app).exists)
		UITestFlows.screenshot(named: "1.1", in: self)
		start.tap()

		// 1.2: every card is closed, nothing chosen, nothing to continue with.
		let continueGenres = app.buttons["onboarding-genres-continue"]
		XCTAssertTrue(continueGenres.waitForExistence(timeout: 10))
		XCTAssertFalse(continueGenres.isEnabled)
		XCTAssertEqual(continueGenres.label, "Continuer")
		XCTAssertFalse(element(app, "subgenre-chip-local:genre-0a").exists)
		XCTAssertTrue(card("family-0", in: app).label.contains("2 sous-genres"))
		XCTAssertTrue(card("family-1", in: app).label.contains("1 sous-genre"))
		UITestFlows.screenshot(named: "1.2a", in: self)

		// "Tous" ticks both genres of the first card; the second card gets one genre by hand.
		tapCard("family-0", in: app)
		let all = app.buttons["select-all-family-0"]
		UITestFlows.tapWhenReady(all)
		XCTAssertTrue(all.isSelected)
		XCTAssertTrue(app.buttons["subgenre-chip-local:genre-0a"].isSelected)
		XCTAssertTrue(app.buttons["subgenre-chip-local:genre-0b"].isSelected)
		tapCard("family-1", in: app)
		UITestFlows.tapWhenReady(app.buttons["subgenre-chip-local:genre-1a"])
		let counter = element(app, "bottom-counter")
		XCTAssertTrue(counter.waitForExistence(timeout: 5))
		XCTAssertEqual(counter.label, "Total : 3 genres")
		XCTAssertTrue(continueGenres.isEnabled)
		XCTAssertEqual(continueGenres.label, "Continuer")
		UITestFlows.screenshot(named: "1.2b", in: self)
		continueGenres.tap()

		// 1.6, then Today: the onboarding is gone and the tabs are there.
		UITestFlows.screenshot(named: "1.6", in: self)
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		XCTAssertTrue(UITestFlows.tabButton("Aujourd’hui", in: app).exists)
		XCTAssertFalse(app.buttons["onboarding-start"].exists)

		// A launch without reset finds the profile: no onboarding, Today again.
		UITestFlows.relaunch(app, catalog: Self.taxonomyCatalog)
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		XCTAssertFalse(app.buttons["onboarding-start"].exists)

		// The settings count what the saved selection holds: it was written, and read back after the relaunch.
		UITestFlows.tabButton("Genres", in: app).tap()
		XCTAssertEqual(openSettings(in: app).value as? String, "2 familles · 3 sous-genres")
	}

	/// The unfolded state does not survive a return to Welcome (the screen is built again, closed), the
	/// selection does: it lives in the model of the flow.
	@MainActor
	func testTheBackGestureToWelcomeKeepsTheSelection() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		tapCard("family-0", in: app)
		let chip = element(app, "subgenre-chip-local:genre-0a")
		UITestFlows.tapWhenReady(app.buttons["subgenre-chip-local:genre-0a"])

		// The edge swipe is the way back: the bar is hidden and Figma draws no back control.
		// A short press at x = 0 and a fast drag: a slow one is read as a scroll, not as the edge gesture.
		let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
		edge.press(
			forDuration: 0.01, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)),
			withVelocity: .fast, thenHoldForDuration: 0)
		XCTAssertTrue(chip.waitForNonExistence(timeout: 10))

		let start = app.buttons["onboarding-start"]
		XCTAssertTrue(start.waitForExistence(timeout: 10))
		start.tap()
		// The card is closed again, and still counts the genre that was ticked.
		let family0 = card("family-0", in: app)
		XCTAssertTrue(family0.waitForExistence(timeout: 10))
		XCTAssertFalse(chip.exists)
		XCTAssertTrue(family0.label.contains("1 sélectionné"))
		XCTAssertEqual(family0.value as? String, "replié")
		let counter = element(app, "bottom-counter")
		XCTAssertTrue(counter.waitForExistence(timeout: 5))
		XCTAssertEqual(counter.label, "Total : 1 genre")
	}

	/// 2026-10-20 (TRA-640): "Tous" ticks every genre of its card, ticks them off again when they are all
	/// ticked, and reads as ticked when the person ticked the last one by hand (the state is derived from the
	/// selection). The count of the header is read off the label of the card: the header is one button, so the
	/// texts drawn in it ("(2)") are not elements of their own, and the label spells the same
	/// count in words ("2 sélectionnés"). Every tap goes through `tapAboveBar`: the pinned bar takes the touch of
	/// whatever is under it.
	@MainActor
	func testSelectAllTogglesEverySubgenreOfTheCardBothWays() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		let bar = app.buttons["onboarding-genres-continue"]
		let family0 = card("family-0", in: app)
		let all = app.buttons["select-all-family-0"]
		let chipA = app.buttons["subgenre-chip-local:genre-0a"]
		let chipB = app.buttons["subgenre-chip-local:genre-0b"]
		let counter = element(app, "bottom-counter")

		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		XCTAssertTrue(all.waitForExistence(timeout: 10))
		XCTAssertTrue(chipA.waitForExistence(timeout: 10))
		XCTAssertTrue(chipB.waitForExistence(timeout: 10))
		XCTAssertFalse(all.isSelected)
		XCTAssertFalse(bar.isEnabled)

		// Nothing ticked: "Tous" ticks both genres, the header counts two, the CTA opens.
		UITestFlows.tapAboveBar(all, bar: bar, in: app)
		XCTAssertTrue(all.isSelected)
		XCTAssertTrue(chipA.isSelected)
		XCTAssertTrue(chipB.isSelected)
		XCTAssertTrue(family0.label.hasSuffix(", 2 sélectionnés"), family0.label)
		XCTAssertTrue(counter.waitForExistence(timeout: 5))
		XCTAssertEqual(counter.label, "Total : 2 genres")
		XCTAssertTrue(bar.isEnabled)

		// Everything ticked: the same chip ticks everything off, and the CTA closes again.
		UITestFlows.tapAboveBar(all, bar: bar, in: app)
		XCTAssertFalse(all.isSelected)
		XCTAssertFalse(chipA.isSelected)
		XCTAssertFalse(chipB.isSelected)
		XCTAssertFalse(family0.label.contains("sélectionné"), family0.label)
		XCTAssertEqual(counter.label, "Total : 0 genre")
		XCTAssertFalse(bar.isEnabled)

		// One genre by hand: the count is singular and "Tous" stays off, since one genre is still missing.
		UITestFlows.tapAboveBar(chipA, bar: bar, in: app)
		XCTAssertTrue(family0.label.hasSuffix(", 1 sélectionné"), family0.label)
		XCTAssertFalse(all.isSelected)

		// The last genre by hand: "Tous" is ticked without being touched.
		UITestFlows.tapAboveBar(chipB, bar: bar, in: app)
		XCTAssertTrue(all.isSelected)
	}

	/// 2026-10-20 (TRA-640, plan Q2): opening a card does not close the others, and closing a card keeps what
	/// was ticked in it: the header and the total still count it, and the chip is ticked again when the card
	/// reopens. The label of a card names its genre count whether it is open or not, so the closed state is
	/// read off the value ("replié") and off the chip, which only exists while its card is open.
	@MainActor
	func testCardsOpenTogetherAndKeepTheirSelectionWhenCollapsed() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		let bar = app.buttons["onboarding-genres-continue"]
		let family0 = card("family-0", in: app)
		let family1 = card("family-1", in: app)
		let chip0a = element(app, "subgenre-chip-local:genre-0a")
		let chip0aButton = app.buttons["subgenre-chip-local:genre-0a"]
		let chip1a = element(app, "subgenre-chip-local:genre-1a")

		// Both cards open at once: the chips of the two exist together.
		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		XCTAssertTrue(chip0a.waitForExistence(timeout: 10))
		UITestFlows.tapAboveBar(family1, bar: bar, in: app)
		XCTAssertTrue(chip1a.waitForExistence(timeout: 10))
		XCTAssertTrue(chip0a.exists)
		XCTAssertEqual(family0.value as? String, "déplié")
		XCTAssertEqual(family1.value as? String, "déplié")
		UITestFlows.screenshot(named: "1.2-accordion", in: self)

		UITestFlows.tapAboveBar(chip0aButton, bar: bar, in: app)

		// The first card closes: its chip is gone, its selection is not, and the second card is untouched.
		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		XCTAssertTrue(chip0a.waitForNonExistence(timeout: 10))
		XCTAssertEqual(family0.value as? String, "replié")
		XCTAssertTrue(family0.label.hasSuffix(", 1 sélectionné"), family0.label)
		XCTAssertTrue(family0.label.contains("2 sous-genres"), family0.label)
		let counter = element(app, "bottom-counter")
		XCTAssertTrue(counter.waitForExistence(timeout: 5))
		XCTAssertEqual(counter.label, "Total : 1 genre")
		XCTAssertTrue(chip1a.exists)
		XCTAssertEqual(family1.value as? String, "déplié")

		// It opens again with its genre still ticked.
		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		XCTAssertTrue(chip0a.waitForExistence(timeout: 10))
		XCTAssertTrue(chip0aButton.isSelected)
	}

	/// 2026-10-23: "(1 sélectionné)" next to "Rock alternatif / Punk" made the header fold on two lines (363 pt asked
	/// for 302). The badge is the bare number now and is never compressed, so a name that fits on one line keeps
	/// its one line once a genre is ticked. Heights are read on the collapsed header, which carries the identifier.
	@MainActor
	func testTheBadgeAddsNoLineToAFamilyNameThatFitsOnOne() {
		let app = UITestFlows.launch(catalog: Self.longLabelsCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		let bar = app.buttons["onboarding-genres-continue"]
		let family0 = card("family-0", in: app)
		let chip = app.buttons["subgenre-chip-local:genre-0a"]
		let before = UITestFlows.settledFrame(of: family0).height

		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		UITestFlows.tapAboveBar(chip, bar: bar, in: app)
		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		XCTAssertTrue(chip.waitForNonExistence(timeout: 10))
		XCTAssertEqual(family0.value as? String, "replié")
		XCTAssertTrue(family0.label.hasSuffix(", 1 sélectionné"), family0.label)
		XCTAssertEqual(UITestFlows.settledFrame(of: family0).height, before, accuracy: 1)
		UITestFlows.screenshot(named: "1.2-badge", in: self)

		// 2026-10-24 (TRA-664 review): the header of the long name (two or three lines, no badge) drew its text over
		// the count line while its frame was right, so the frame check above cannot see it: the capture is the
		// proof to read, along with the unit tests of the header layout.
		let longName = card("family-1", in: app)
		XCTAssertTrue(longName.waitForExistence(timeout: 5))
		let capture = XCTAttachment(screenshot: longName.screenshot())
		capture.name = "1.2-long-name-collapsed"
		capture.lifetime = .keepAlways
		add(capture)
	}

	/// 2026-10-24 (TRA-666, plan D5): a family name longer than the line folds onto more lines (the header grows by
	/// a title line, 22 pt at the default text size), stays inside the screen and as wide as the other cards, and
	/// still counts the ticked genre once the card closes, with the height it had before (the badge is expected
	/// to add no line, plan D5). Nothing is asserted on where the badge sits, since its text is not an element:
	/// the capture `1.2-long-family` is what shows it.
	@MainActor
	func testALongFamilyNameWrapsAndKeepsItsBadge() {
		let app = UITestFlows.launch(catalog: Self.longLabelsCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		let bar = app.buttons["onboarding-genres-continue"]
		let shortName = card("family-0", in: app)
		let longName = card("family-1", in: app)
		let chip = app.buttons["subgenre-chip-local:genre-1a"]

		let shortFrame = UITestFlows.settledFrame(of: shortName, timeout: 10)
		let before = UITestFlows.settledFrame(of: longName, timeout: 10)
		XCTAssertEqual(before.width, shortFrame.width, accuracy: 1)
		XCTAssertLessThanOrEqual(before.maxX, app.frame.maxX)
		XCTAssertGreaterThanOrEqual(before.height, shortFrame.height + 21, "the long name is folded, not cut")

		UITestFlows.tapAboveBar(longName, bar: bar, in: app)
		UITestFlows.tapAboveBar(chip, bar: bar, in: app)
		UITestFlows.tapAboveBar(longName, bar: bar, in: app)
		XCTAssertTrue(chip.waitForNonExistence(timeout: 10))
		XCTAssertEqual(longName.value as? String, "replié")
		XCTAssertTrue(longName.label.hasSuffix(", 1 sélectionné"), longName.label)

		// Back to the top of the list: the taps above scrolled it, and the capture is of the headers.
		app.swipeDown()
		let after = UITestFlows.settledFrame(of: longName, timeout: 10)
		XCTAssertEqual(after.width, before.width, accuracy: 1)
		XCTAssertEqual(after.height, before.height, accuracy: 1)
		UITestFlows.screenshot(named: "1.2-long-family", in: self)
	}

	/// 2026-10-24 (TRA-666, plan D4): the edit sheet of the Genres tab draws the same `GenresStepView`, so a
	/// collapsed card has the size it has in the onboarding, for a name that fits on one line (ticked genre,
	/// badge) and for one that folds. The sizes are measured on the first launch, before "Continuer", then in the
	/// sheet. A gap in height is a defect of the sheet to report, not a tolerance to widen.
	@MainActor
	func testTheEditSheetDrawsTheSameCardHeaderAsTheOnboarding() {
		let app = UITestFlows.launch(catalog: Self.longLabelsCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		let bar = app.buttons["onboarding-genres-continue"]
		let family0 = card("family-0", in: app)
		let family1 = card("family-1", in: app)
		let chip = app.buttons["subgenre-chip-local:genre-0a"]

		// Family 0 ticked and closed again (the header animates its height as it closes), family 1 untouched.
		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		UITestFlows.tapAboveBar(chip, bar: bar, in: app)
		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		XCTAssertTrue(chip.waitForNonExistence(timeout: 10))
		let onboarding0 = UITestFlows.settledFrame(of: family0, timeout: 10)
		let onboarding1 = UITestFlows.settledFrame(of: family1, timeout: 10)

		UITestFlows.tapWhenReady(bar)
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		app.tabBars.buttons["Genres"].tap()
		UITestFlows.tapWhenReady(app.buttons["genres-edit"])

		// The sheet opens on the same cards, closed, and the first still counts the genre that is ticked.
		XCTAssertTrue(family0.waitForExistence(timeout: 10))
		XCTAssertEqual(family0.value as? String, "replié")
		XCTAssertTrue(family0.label.contains("1 sélectionné"), family0.label)
		XCTAssertEqual(family1.value as? String, "replié")
		XCTAssertFalse(family1.label.contains("sélectionné"), family1.label)
		let sheet0 = UITestFlows.settledFrame(of: family0, timeout: 10)
		let sheet1 = UITestFlows.settledFrame(of: family1, timeout: 10)
		XCTAssertEqual(sheet0.width, onboarding0.width, accuracy: 1)
		XCTAssertEqual(sheet0.height, onboarding0.height, accuracy: 1)
		XCTAssertEqual(sheet1.width, onboarding1.width, accuracy: 1)
		XCTAssertEqual(sheet1.height, onboarding1.height, accuracy: 1)
		UITestFlows.screenshot(named: "3.3-edit-long-family", in: self)
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
		tapCard("family-0", in: app)
		UITestFlows.tapWhenReady(app.buttons["subgenre-chip-local:genre-3"])
		UITestFlows.tapWhenReady(app.buttons["onboarding-genres-continue"])

		// The write failed: the flow stays where it is, and the same button writes again.
		let alert = app.alerts["Enregistrement indisponible"]
		XCTAssertTrue(alert.waitForExistence(timeout: 10))
		XCTAssertFalse(UITestFlows.tabBar(in: app).exists)
		alert.buttons["OK"].tap()
		XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
		UITestFlows.tapWhenReady(app.buttons["onboarding-genres-continue"])
		XCTAssertTrue(UITestFlows.tabButton("Genres", in: app).waitForExistence(timeout: 10))
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
		UITestFlows.tabButton("Genres", in: app).tap()
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
		XCTAssertFalse(UITestFlows.tabBar(in: app).exists)
		UITestFlows.tapWhenReady(app.buttons["onboarding-start"])
		tapCard("family-0", in: app)
		UITestFlows.tapWhenReady(app.buttons["subgenre-chip-local:genre-3"])
		UITestFlows.tapWhenReady(app.buttons["onboarding-genres-continue"])
		XCTAssertTrue(UITestFlows.tabButton("Genres", in: app).waitForExistence(timeout: 10))
		UITestFlows.tabButton("Genres", in: app).tap()
		_ = openSettings(in: app)
		XCTAssertEqual(app.buttons["profile-settings-edit"].value as? String, "1 famille · 1 sous-genre")
	}

	@MainActor
	func testTheGenresTabShowsTheFamiliesOfTheProfileAndOpensTheSettings() {
		let app = firstProfile()
		UITestFlows.tabButton("Genres", in: app).tap()

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
		UITestFlows.tabButton("Genres", in: app).tap()
		app.buttons["genres-edit"].tap()

		// The edit flow opens on the accordion, with no Welcome: the card of the current family is closed
		// and counts the genre that is already ticked.
		let family0 = card("family-0", in: app)
		XCTAssertTrue(family0.waitForExistence(timeout: 5))
		XCTAssertTrue(family0.label.contains("1 sélectionné"))
		XCTAssertFalse(element(app, "subgenre-chip-local:genre-0a").exists)
		tapCard("family-1", in: app)
		UITestFlows.tapWhenReady(app.buttons["subgenre-chip-local:genre-1a"])
		UITestFlows.screenshot(named: "3.3-edit-genres", in: self)
		// The edit flow ends on "Enregistrer", the button the first launch labels "Continuer".
		let save = app.buttons["onboarding-genres-continue"]
		XCTAssertEqual(save.label, "Enregistrer")
		save.tap()

		// The flow ends on Today, which loads the recommendation again for the new revision of the profile.
		XCTAssertTrue(element(app, "node-title").waitForExistence(timeout: 15))
		UITestFlows.tabButton("Genres", in: app).tap()
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
		UITestFlows.tabButton("Genres", in: app).tap()
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

	/// A tile of the Genres tab, plain content rather than a button: any element type will do.
	@MainActor
	private func tile(_ key: String, in app: XCUIApplication) -> XCUIElement {
		element(app, "genre-tile-\(key)")
	}

	/// The header of an accordion card on the genre screen: its label reads "<name>, <N> sous-genres", then
	/// ", <M> sélectionnés" once something is ticked; its value is "replié" or "déplié".
	@MainActor
	private func card(_ key: String, in app: XCUIApplication) -> XCUIElement {
		app.buttons["genre-card-\(key)"]
	}

	@MainActor
	private func tapCard(_ key: String, in app: XCUIApplication) {
		UITestFlows.tapWhenReady(card(key, in: app))
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
		{"mode":"editorial","version":2,"families":[{"key":"family-0","label":"Family 0","order":1},{"key":"family-1","label":"Family 1","order":2}],"genres":[{"id":"local:genre-0a","name":"Genre 0a","family":"family-0","slugs":["genre:genre-0a"]},{"id":"local:genre-0b","name":"Genre 0b","family":"family-0","slugs":["genre:genre-0b"]},{"id":"local:genre-1a","name":"Genre 1a","family":"family-1","slugs":["genre:genre-1a"]}],"legacySelectionBySlug":{}}
		"""

	/// `editorialTaxonomy` with two long family names: only the `label`s change.
	private static let longLabelsTaxonomy =
		"""
		{"mode":"editorial","version":2,"families":[{"key":"family-0","label":"Rock alternatif / Punk","order":1},{"key":"family-1","label":"Musiques traditionnelles d'Afrique et d'Orient","order":2}],"genres":[{"id":"local:genre-0a","name":"Genre 0a","family":"family-0","slugs":["genre:genre-0a"]},{"id":"local:genre-0b","name":"Genre 0b","family":"family-0","slugs":["genre:genre-0b"]},{"id":"local:genre-1a","name":"Genre 1a","family":"family-1","slugs":["genre:genre-1a"]}],"legacySelectionBySlug":{}}
		"""

	private static let degradedTaxonomy = #"{"mode":"degraded","available":true}"#

	/// Two families, with two published genres for the first and one for the second, and the works of the Today
	/// fixtures linked to the first genre of each: the pick exists for a profile of one family and for a
	/// profile of two.
	private static let taxonomyCatalog = catalog(taxonomy: editorialTaxonomy)

	private static let longLabelsCatalog = catalog(taxonomy: longLabelsTaxonomy)

	/// The same nodes and edges with the taxonomy the server serves when it cannot build the editorial one.
	private static let degradedCatalog = catalog(taxonomy: degradedTaxonomy)

	private static func catalog(taxonomy: String) -> String {
		"""
		{"version":"v1","revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taxonomy":\(taxonomy),"nodes":[{"identity":"genre:genre-0","type":"genre","name":"Genre 0","teaser":null},{"identity":"genre:genre-1","type":"genre","name":"Genre 1","teaser":null},{"identity":"genre:genre-0a","type":"genre","name":"Genre 0a","teaser":null},{"identity":"genre:genre-0b","type":"genre","name":"Genre 0b","teaser":null},{"identity":"genre:genre-1a","type":"genre","name":"Genre 1a","teaser":null},{"identity":"artist:artist-a","type":"artist","name":"Artist A","teaser":null},{"identity":"project:project-a","type":"project","name":"Project A","teaser":null},{"identity":"track:track-a","type":"track","name":"Track A","teaser":null}],"edges":[{"source":"artist:artist-a","target":"genre:genre-0a","type":"genres"},{"source":"project:project-a","target":"genre:genre-0a","type":"genres"},{"source":"track:track-a","target":"genre:genre-0a","type":"genres"},{"source":"artist:artist-a","target":"genre:genre-1a","type":"genres"},{"source":"project:project-a","target":"genre:genre-1a","type":"genres"},{"source":"track:track-a","target":"genre:genre-1a","type":"genres"}]}
		"""
	}
}
