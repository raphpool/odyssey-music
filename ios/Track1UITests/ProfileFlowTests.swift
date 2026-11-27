import XCTest

final class ProfileFlowTests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	/// 2026-10-14 (J.4): the first launch chains Welcome (1.1), the genre accordion (1.2) and Today, which shows
	/// the loading screen (1.6) until the recommendation is there. TRA-639: the accordion is the only genre
	/// screen. TRA-735: the pseudo (1.3) and the disc (1.4) come between Welcome and the genres, in that order,
	/// and each screen is checked before the next one exists. TRA-746: the notification opt-in follows the
	/// genres, the fake center grants it, and it is not shown again at the next launch.
	@MainActor
	func testFirstLaunchChainsTheOnboardingToTodayAndIsNotShownAgain() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)

		// 1.1: the brand moment is the whole app until the person starts.
		let start = app.buttons["onboarding-start"]
		XCTAssertTrue(start.waitForExistence(timeout: 10))
		XCTAssertFalse(UITestFlows.tabBar(in: app).exists)
		UITestFlows.screenshot(named: "1.1", in: self)
		UITestFlows.startOnboarding(app)

		// 1.3: the pseudo. Nothing typed, nothing to continue with, and no later screen yet.
		let pseudoField = app.textFields[UITestFlows.pseudoFieldIdentifier]
		XCTAssertTrue(pseudoField.waitForExistence(timeout: 10))
		XCTAssertTrue(element(app, "onboarding-pseudo-title").exists)
		XCTAssertFalse(app.buttons["onboarding-pseudo-continue"].isEnabled)
		XCTAssertFalse(element(app, "onboarding-disc-slot").exists)
		XCTAssertFalse(app.buttons[UITestFlows.genresContinueIdentifier].exists)
		UITestFlows.screenshot(named: "1.3", in: self)
		pseudoField.tap()
		pseudoField.typeText("Raph\n")

		// 1.4: the disc. None chosen, nothing to continue with; a tile fills the slot and opens the button.
		let slot = element(app, "onboarding-disc-slot")
		let continueDisc = app.buttons[UITestFlows.discContinueIdentifier]
		XCTAssertTrue(slot.waitForExistence(timeout: 10))
		XCTAssertFalse(continueDisc.isEnabled)
		XCTAssertFalse(app.buttons[UITestFlows.genresContinueIdentifier].exists)
		UITestFlows.screenshot(named: "1.4", in: self)
		UITestFlows.tapWhenReady(app.buttons["onboarding-disc-coral"])
		XCTAssertTrue(app.buttons["onboarding-disc-coral"].isSelected)
		XCTAssertTrue(continueDisc.isEnabled)
		continueDisc.tap()

		// 1.2: every card is closed, nothing chosen, nothing to continue with.
		let continueGenres = app.buttons[UITestFlows.genresContinueIdentifier]
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

		// The opt-in follows the genres, before any tab: the profile is written when this step ends.
		let continueNotifications = app.buttons[UITestFlows.notificationsContinueIdentifier]
		XCTAssertTrue(continueNotifications.waitForExistence(timeout: 10))
		XCTAssertTrue(element(app, UITestFlows.notificationsIdentifier).exists)
		XCTAssertFalse(UITestFlows.tabBar(in: app).exists)
		UITestFlows.screenshot(named: "1.7", in: self)
		continueNotifications.tap()

		// 1.6, then Today: the onboarding is gone and the tabs are there.
		UITestFlows.screenshot(named: "1.6", in: self)
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		XCTAssertTrue(UITestFlows.tabButton("Aujourd’hui", in: app).exists)
		XCTAssertFalse(app.buttons["onboarding-start"].exists)

		// A launch without reset finds the profile: no onboarding, Today again.
		UITestFlows.relaunch(app, catalog: Self.taxonomyCatalog)
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		XCTAssertFalse(app.buttons["onboarding-start"].exists)
		XCTAssertFalse(pseudoField.exists)
		// The fake center starts undecided at every launch: only the flag keeps the opt-in from coming back.
		XCTAssertFalse(element(app, UITestFlows.notificationsIdentifier).exists)

		// The Genres tab counts what the saved selection holds: it was written, and read back after the relaunch.
		// 2026-11-17 (TRA-737): the settings no longer carry this count, the cards of the tab do.
		UITestFlows.tabButton("Genres", in: app).tap()
		let family0 = card("family-0", in: app)
		let family1 = card("family-1", in: app)
		XCTAssertTrue(family0.waitForExistence(timeout: 10))
		XCTAssertTrue(family0.label.hasSuffix(", 2 sélectionnés"), family0.label)
		XCTAssertTrue(family1.label.hasSuffix(", 1 sélectionné"), family1.label)
	}

	/// TRA-735: the stack goes back one step at a time, and keeps what was chosen. The unfolded state of the
	/// cards does not survive a return to the genres (the screen is built again, closed), the selection does: it
	/// lives in the model of the flow. The disc stays chosen and the pseudo stays in the field: they live in the
	/// answers of the flow, which the screens only read. The pseudo is not "Slim Shady", the placeholder of the
	/// field, which an empty field would also report as its value.
	@MainActor
	func testTheBackGestureToWelcomeKeepsTheSelection() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app, pseudo: "Raph", disc: "mint")
		tapCard("family-0", in: app)
		let chip = element(app, "subgenre-chip-local:genre-0a")
		UITestFlows.tapWhenReady(app.buttons["subgenre-chip-local:genre-0a"])

		// The edge swipe is the way back: the bar is hidden and Figma draws no back control. From the genres it
		// goes to the disc, which is still chosen.
		swipeBack(in: app)
		XCTAssertTrue(chip.waitForNonExistence(timeout: 10), "back from the genres")
		let mint = app.buttons["onboarding-disc-mint"]
		XCTAssertTrue(mint.waitForExistence(timeout: 10), "the disc step is shown")
		XCTAssertTrue(mint.isSelected, "the disc is still chosen")
		XCTAssertTrue(
			app.buttons[UITestFlows.discContinueIdentifier].isEnabled, "the disc step can be left")

		// From the disc it goes to the pseudo, with the text that was typed.
		swipeBack(in: app)
		let pseudoField = app.textFields[UITestFlows.pseudoFieldIdentifier]
		XCTAssertTrue(pseudoField.waitForExistence(timeout: 10), "back to the pseudo")
		XCTAssertEqual(pseudoField.value as? String, "Raph")

		// From the pseudo it goes to Welcome.
		swipeBack(in: app)
		let start = app.buttons["onboarding-start"]
		XCTAssertTrue(start.waitForExistence(timeout: 10), "back to Welcome")

		// Forward again: the pseudo and the disc are as they were, and so is the genre that was ticked.
		UITestFlows.startOnboarding(app)
		XCTAssertEqual(pseudoField.value as? String, "Raph")
		pseudoField.tap()
		pseudoField.typeText("\n")
		XCTAssertTrue(
			app.buttons["onboarding-disc-mint"].waitForExistence(timeout: 10), "forward to the disc again")
		XCTAssertTrue(app.buttons["onboarding-disc-mint"].isSelected, "the disc is kept")
		UITestFlows.tapWhenReady(app.buttons[UITestFlows.discContinueIdentifier])
		// The card is closed again, and still counts the genre that was ticked.
		let family0 = card("family-0", in: app)
		XCTAssertTrue(family0.waitForExistence(timeout: 10), "forward to the genres again")
		XCTAssertFalse(chip.exists)
		XCTAssertTrue(family0.label.contains("1 sélectionné"), family0.label)
		XCTAssertEqual(family0.value as? String, "replié")
		let counter = element(app, "bottom-counter")
		XCTAssertTrue(counter.waitForExistence(timeout: 5), "the counter is shown")
		XCTAssertEqual(counter.label, "Total : 1 genre")
	}

	/// TRA-735: each validated step is written as a draft, so a relaunch reopens on the first step that was not
	/// validated, with the answers already given. The app is stopped on the disc screen: the pseudo was validated.
	/// Every assertion carries a message: the CI log only names the test, and two steps share a kind of assertion.
	@MainActor
	func testRelaunchingAfterThePseudoReopensOnTheDiscWithThePseudoKept() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.startOnboarding(app)
		let pseudoField = app.textFields[UITestFlows.pseudoFieldIdentifier]
		pseudoField.tap()
		pseudoField.typeText("Raph\n")
		XCTAssertTrue(element(app, "onboarding-disc-slot").waitForExistence(timeout: 10), "disc before relaunch")

		UITestFlows.relaunch(app, catalog: Self.taxonomyCatalog)
		XCTAssertTrue(element(app, "onboarding-disc-slot").waitForExistence(timeout: 15), "disc after relaunch")
		XCTAssertFalse(app.buttons["onboarding-start"].exists, "Welcome after relaunch")
		XCTAssertFalse(app.buttons[UITestFlows.discContinueIdentifier].isEnabled, "disc already chosen")

		// The pseudo is behind the disc, in the stack, as it was the first time.
		swipeBack(in: app)
		XCTAssertTrue(pseudoField.waitForExistence(timeout: 10), "pseudo after the back gesture")
		XCTAssertEqual(pseudoField.value as? String, "Raph")
	}

	/// TRA-735: the disc was validated too, so the flow reopens on the genres, with the disc behind them.
	@MainActor
	func testRelaunchingAfterTheDiscReopensOnTheGenresWithTheDiscKept() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app, pseudo: "Raph", disc: "violet")

		UITestFlows.relaunch(app, catalog: Self.taxonomyCatalog)
		let genres = app.buttons[UITestFlows.genresContinueIdentifier]
		XCTAssertTrue(genres.waitForExistence(timeout: 15), "genres after relaunch")
		XCTAssertFalse(app.buttons["onboarding-start"].exists, "Welcome after relaunch")

		swipeBack(in: app)
		XCTAssertTrue(
			app.buttons["onboarding-disc-violet"].waitForExistence(timeout: 10), "disc after the back gesture")
		XCTAssertTrue(app.buttons["onboarding-disc-violet"].isSelected, "disc kept")
	}

	/// TRA-735: erasing the profile from the settings leaves the history of recommendations on disk. The profile
	/// that replaces it must not be served the work picked for the first one: with a catalog that has no work to
	/// recommend, its Today is empty, where the history of the first profile would have shown its work.
	@MainActor
	func testANewProfileStartsWithAnEmptyHistoryOfRecommendations() {
		let app = UITestFlows.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))

		UITestFlows.tabButton("Genres", in: app).tap()
		app.buttons["genres-settings"].tap()
		UITestFlows.tapWhenReady(app.buttons["profile-clear"])
		app.alerts.buttons["Effacer"].tap()
		XCTAssertTrue(app.buttons["onboarding-start"].waitForExistence(timeout: 10))

		UITestFlows.relaunch(app, catalog: UITestFlows.catalogWithoutLinkedWorksJSON)
		UITestFlows.completeOnboarding(app)
		XCTAssertTrue(element(app, "today-empty").waitForExistence(timeout: 15))
		XCTAssertFalse(element(app, "today-title").exists)
	}

	/// TRA-746: a refusal leads to Today as a yes does. The screen reads in the order of the ticket: the title,
	/// the subtitle, the preview of the notification, then the button.
	@MainActor
	func testRefusingTheNotificationsOpensTodayAsWell() {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog, reminders: "deny")
		UITestFlows.declineConsent(app)
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
		tapCard("family-0", in: app)
		UITestFlows.tapWhenReady(app.buttons["subgenre-chip-local:genre-0a"])
		UITestFlows.tapWhenReady(app.buttons[UITestFlows.genresContinueIdentifier])

		let continueNotifications = app.buttons[UITestFlows.notificationsContinueIdentifier]
		XCTAssertTrue(continueNotifications.waitForExistence(timeout: 10))
		let title = app.staticTexts["Obtiens ta recommandation quotidienne"]
		let subtitle = app.staticTexts["Chaque jour, un track ou album de tes genres sélectionnés"]
		let preview = app.descendants(matching: .any).matching(
			NSPredicate(format: "label BEGINSWITH %@", "Exemple de notification")
		).firstMatch
		XCTAssertTrue(title.exists)
		XCTAssertTrue(subtitle.exists)
		XCTAssertTrue(preview.exists)
		XCTAssertLessThan(title.frame.maxY, subtitle.frame.minY)
		XCTAssertLessThan(subtitle.frame.maxY, preview.frame.minY)
		XCTAssertLessThan(preview.frame.maxY, continueNotifications.frame.minY)
		UITestFlows.screenshot(named: "1.7-refused", in: self)
		continueNotifications.tap()

		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		XCTAssertTrue(UITestFlows.tabButton("Aujourd’hui", in: app).exists)
		XCTAssertFalse(element(app, UITestFlows.notificationsIdentifier).exists)
	}

	/// TRA-746: a profile made before the screen existed has no flag. It sees the screen once, over the tabs,
	/// and its answer leads back to Today; the launch after, it is not shown again. The profile here is made by
	/// the first-launch flow, then the flag is lowered by the launch argument that stands for the older build.
	@MainActor
	func testAProfileMadeBeforeTheOptInSeesItOnceThenNeverAgain() {
		let app = firstProfile()
		UITestFlows.relaunch(
			app, catalog: Self.taxonomyCatalog, extraArguments: ["-track1-reset-reminder-prompt"])

		let continueNotifications = app.buttons[UITestFlows.notificationsContinueIdentifier]
		XCTAssertTrue(continueNotifications.waitForExistence(timeout: 15), "the opt-in over the tabs")
		XCTAssertFalse(app.buttons["onboarding-start"].exists)
		UITestFlows.screenshot(named: "1.7-existing-profile", in: self)
		continueNotifications.tap()
		XCTAssertTrue(continueNotifications.waitForNonExistence(timeout: 10))
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))

		UITestFlows.relaunch(app, catalog: Self.taxonomyCatalog)
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		XCTAssertFalse(element(app, UITestFlows.notificationsIdentifier).exists)
		XCTAssertFalse(continueNotifications.exists)
	}

	/// The edge swipe: a short press at x = 0 and a fast drag, a slow one is read as a scroll, not as the
	/// gesture.
	@MainActor
	private func swipeBack(in app: XCUIApplication) {
		let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
		edge.press(
			forDuration: 0.01, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)),
			withVelocity: .fast, thenHoldForDuration: 0)
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
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
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
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
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
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
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
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
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

	/// 2026-10-24 (TRA-679): at the largest text size a row holds about 11 characters, so the longest real subgenre
	/// name folds on several lines. The chip was posed in a one-line slot and its pill, grown from the top left
	/// corner, covered the next chip and left the card. The chip must stay inside its card, take the height of its
	/// lines and leave the next chip under it, 8 pt below (7 allows for rounding). "Genre 0b" fits on one line, so
	/// its height is that of a one-line pill (a line of text plus 20 pt of padding and border), and the long chip has
	/// to hold at least two lines, that is `2 * b.height - 20`: 21 leaves 1 pt for rounding. The capture
	/// `1.2-chips-xxxl` is the proof to read for the shape.
	@MainActor
	func testASubgenreNameWiderThanTheRowFoldsInsideItsCardAtTheLargestTextSize() {
		let app = UITestFlows.launch(
			catalog: Self.longChipCatalog,
			extraArguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
		UITestFlows.declineConsent(app)
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
		let bar = app.buttons["onboarding-genres-continue"]
		let family0 = card("family-0", in: app)
		let chipA = app.buttons["subgenre-chip-local:genre-0a"]
		let chipB = app.buttons["subgenre-chip-local:genre-0b"]

		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		XCTAssertTrue(chipA.waitForExistence(timeout: 10))
		XCTAssertTrue(chipB.waitForExistence(timeout: 10))

		let h0 = UITestFlows.settledFrame(of: family0, timeout: 10)
		let a = UITestFlows.settledFrame(of: chipA, timeout: 10)
		let b = UITestFlows.settledFrame(of: chipB, timeout: 10)
		XCTAssertGreaterThanOrEqual(a.minX, h0.minX - 1, "the long chip starts inside its card")
		XCTAssertLessThanOrEqual(a.maxX, h0.maxX + 1, "the long chip ends inside its card")
		XCTAssertGreaterThanOrEqual(a.height, 2 * b.height - 21, "the long name is folded, not cut: \(a) and \(b)")
		XCTAssertFalse(a.intersects(b), "the chips overlap: \(a) and \(b)")
		XCTAssertGreaterThanOrEqual(b.minY, a.maxY + 7, "the next chip starts under the folded one: \(a) and \(b)")
		// The measures above are of frames; the capture is of the screen: bring the second chip above the bar.
		for _ in 0..<4 where chipB.frame.maxY > bar.frame.minY - 24 {
			app.swipeUp()
		}
		UITestFlows.screenshot(named: "1.2-chips-xxxl", in: self)
	}

	/// 2026-10-24 (TRA-700, review of TRA-679): at AX2 "Mauritanian Traditional" folds on two lines (about 184 x
	/// 78.67 pt) in a pill narrower than the 330 pt row, and "Sai" (71.33 x 49.33 pt) shares that row. The layout
	/// centered "Sai" on the folded pill, at mid-height beside it; the onboarding aligns it at the top. Both chips
	/// are read as frames, `a` folded and `b` short, and the preconditions (`a` at least 15 pt taller, `b` on the
	/// right of `a`) keep the test from passing on two chips that do not share a row. 1 pt is for rounding: on
	/// `main` the gap is half the difference in height, about 15 pt. The sizes come from the `ios-check` run of
	/// PR #649 (see `sharedRowChipTaxonomy`). The capture `1.2-chips-shared-row` is the proof to read for the shape.
	@MainActor
	func testAShortChipSharingItsRowWithAFoldedChipIsAlignedOnTopOfIt() {
		let app = UITestFlows.launch(
			catalog: Self.sharedRowChipCatalog,
			extraArguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"])
		UITestFlows.declineConsent(app)
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
		let bar = app.buttons["onboarding-genres-continue"]
		let family0 = card("family-0", in: app)
		let chipA = app.buttons["subgenre-chip-local:genre-0a"]
		let chipB = app.buttons["subgenre-chip-local:genre-0b"]

		UITestFlows.tapAboveBar(family0, bar: bar, in: app)
		XCTAssertTrue(chipA.waitForExistence(timeout: 10))
		XCTAssertTrue(chipB.waitForExistence(timeout: 10))

		let a = UITestFlows.settledFrame(of: chipA, timeout: 10)
		let b = UITestFlows.settledFrame(of: chipB, timeout: 10)
		XCTAssertGreaterThanOrEqual(a.height, b.height + 15, "the long name is folded: \(a) and \(b)")
		XCTAssertGreaterThan(b.minX, a.maxX, "the chips share a row: \(a) and \(b)")
		XCTAssertLessThanOrEqual(abs(b.minY - a.minY), 1, "the short chip is at the top of the row: \(a) and \(b)")
		// The measures above are of frames; the capture is of the screen: bring the chips above the bar.
		for _ in 0..<4 where chipA.frame.maxY > bar.frame.minY - 24 {
			app.swipeUp()
		}
		UITestFlows.screenshot(named: "1.2-chips-shared-row", in: self)
	}

	/// 2026-10-24 (TRA-666, plan D4): the Genres tab draws the same cards as the onboarding, so a collapsed card
	/// has the size it has there, for a name that fits on one line (ticked genre, badge) and for one that folds.
	/// The sizes are measured on the first launch, before "Continuer", then in the tab. A gap in height is a
	/// defect of the tab to report, not a tolerance to widen. 2026-11-17 (TRA-737): the cards are in the tab
	/// itself, since the edit sheet is gone.
	@MainActor
	func testTheGenresTabDrawsTheSameCardHeaderAsTheOnboarding() {
		let app = UITestFlows.launch(catalog: Self.longLabelsCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
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
		UITestFlows.passNotifications(app)
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		UITestFlows.tabButton("Genres", in: app).tap()

		// The tab opens on the same cards, closed, and the first still counts the genre that is ticked.
		XCTAssertTrue(family0.waitForExistence(timeout: 10))
		XCTAssertEqual(family0.value as? String, "replié")
		XCTAssertTrue(family0.label.contains("1 sélectionné"), family0.label)
		XCTAssertEqual(family1.value as? String, "replié")
		XCTAssertFalse(family1.label.contains("sélectionné"), family1.label)
		let tab0 = UITestFlows.settledFrame(of: family0, timeout: 10)
		let tab1 = UITestFlows.settledFrame(of: family1, timeout: 10)
		XCTAssertEqual(tab0.width, onboarding0.width, accuracy: 1)
		XCTAssertEqual(tab0.height, onboarding0.height, accuracy: 1)
		XCTAssertEqual(tab1.width, onboarding1.width, accuracy: 1)
		XCTAssertEqual(tab1.height, onboarding1.height, accuracy: 1)
		UITestFlows.screenshot(named: "3.3-genres-long-family", in: self)
	}

	/// 2026-11-17 (TRA-737): the write that fails is the one of "Sauvegarder", on a saved profile. The first
	/// launch writes the profile normally; the app is then started again with the hook that fails the next
	/// write of the profile file, which nothing has touched yet. The ticks are kept, the alert is the existing
	/// one, and the same button writes again.
	@MainActor
	func testFailedProfileWriteShowsAnErrorAndCanBeRetried() {
		let app = firstProfile()
		app.terminate()
		app.launchArguments = ["-AppleLanguages", "(fr)", "-track1-fail-next-profile-write"]
		app.launch()
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		UITestFlows.tabButton("Genres", in: app).tap()
		let save = app.buttons[Self.saveIdentifier]
		tapCard("family-1", in: app)
		UITestFlows.tapAboveBar(app.buttons["subgenre-chip-local:genre-1a"], bar: save, in: app)
		UITestFlows.tapWhenReady(save)

		// The write failed: the page stays where it is with its ticks, and the same button writes again.
		let alert = app.alerts["Enregistrement indisponible"]
		XCTAssertTrue(alert.waitForExistence(timeout: 10))
		XCTAssertTrue(UITestFlows.tabBar(in: app).exists)
		alert.buttons["OK"].tap()
		XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
		XCTAssertTrue(app.buttons["subgenre-chip-local:genre-1a"].isSelected)
		XCTAssertTrue(save.isEnabled)
		UITestFlows.tapWhenReady(save)
		XCTAssertTrue(waitUntil { !save.isEnabled }, "saved on the second try")
		XCTAssertFalse(alert.exists)
		XCTAssertTrue(card("family-1", in: app).label.hasSuffix(", 1 sélectionné"), card("family-1", in: app).label)
	}

	/// 2026-11-17 (TRA-746): on the first launch the profile is written when the opt-in step ends, so a failed
	/// write shows the existing alert on that screen and the same "Continuer" writes again.
	@MainActor
	func testFailedFirstProfileWriteAtTheEndOfTheOnboardingCanBeRetried() {
		let app = XCUIApplication()
		app.launchArguments = [
			"-AppleLanguages", "(fr)", "-track1-reset-analytics-consent", "-track1-reset-profile",
			"-track1-fail-next-profile-write",
		]
		app.launchEnvironment = [
			"TRACK1_PROFILE_CATALOG_JSON": catalogFixture, UITestFlows.reminderCenterKey: "grant",
		]
		app.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
		tapCard("family-0", in: app)
		UITestFlows.tapWhenReady(app.buttons["subgenre-chip-local:genre-3"])
		UITestFlows.tapWhenReady(app.buttons["onboarding-genres-continue"])
		// TRA-746: the profile is written when the opt-in ends, so that is where the write fails.
		UITestFlows.passNotifications(app)

		// The write failed: the opt-in stays on screen, before any tab, and its button writes again.
		let alert = app.alerts["Enregistrement indisponible"]
		XCTAssertTrue(alert.waitForExistence(timeout: 10), "the failed write shows the alert")
		XCTAssertTrue(
			app.buttons[UITestFlows.notificationsContinueIdentifier].exists, "the opt-in is still on screen")
		alert.buttons["OK"].tap()
		XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
		UITestFlows.tapWhenReady(app.buttons[UITestFlows.notificationsContinueIdentifier])
		XCTAssertTrue(UITestFlows.tabButton("Genres", in: app).waitForExistence(timeout: 10))
	}

	@MainActor
	func testCorruptProfileCanBeExplicitlyPurgedThenRecreated() {
		let app = XCUIApplication()
		app.launchArguments = [
			"-AppleLanguages", "(fr)", "-track1-reset-analytics-consent", "-track1-seed-corrupt-profile",
		]
		app.launchEnvironment = [
			"TRACK1_PROFILE_CATALOG_JSON": catalogFixture, UITestFlows.reminderCenterKey: "grant",
		]
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
		UITestFlows.startOnboarding(app)
		UITestFlows.passPseudoAndDisc(app)
		tapCard("family-0", in: app)
		UITestFlows.tapWhenReady(app.buttons["subgenre-chip-local:genre-3"])
		UITestFlows.tapWhenReady(app.buttons["onboarding-genres-continue"])
		UITestFlows.passNotifications(app)
		XCTAssertTrue(UITestFlows.tabButton("Genres", in: app).waitForExistence(timeout: 10))
		UITestFlows.tabButton("Genres", in: app).tap()
		XCTAssertTrue(card("family-0", in: app).waitForExistence(timeout: 10))
		XCTAssertTrue(card("family-0", in: app).label.hasSuffix(", 1 sélectionné"), card("family-0", in: app).label)
	}

	/// TRA-737: the tab is the profile page: the disc and the pseudo, "Tes genres" with every card, and the
	/// tenure at the foot. Nothing is saved yet, so "Sauvegarder" is off. The settings are the sheet of the icon
	/// button, and no longer hold a row that edits the genres.
	@MainActor
	func testTheGenresTabShowsTheFamiliesOfTheProfileAndOpensTheSettings() {
		let app = firstProfile()
		UITestFlows.tabButton("Genres", in: app).tap()

		let header = element(app, "profile-header")
		XCTAssertTrue(header.waitForExistence(timeout: 5), "profile-header")
		XCTAssertTrue(header.label.hasPrefix("Raph, "), header.label)
		XCTAssertTrue(app.staticTexts["Tes genres"].exists, "section title")
		XCTAssertFalse(app.staticTexts["Mes genres"].exists, "the old title is gone")
		// Every card of the taxonomy is there, not only the ones of the profile; the first counts its genre.
		XCTAssertTrue(card("family-0", in: app).exists)
		XCTAssertTrue(card("family-1", in: app).exists)
		XCTAssertTrue(card("family-0", in: app).label.contains("1 sélectionné"), card("family-0", in: app).label)
		XCTAssertFalse(card("family-1", in: app).label.contains("sélectionné"), card("family-1", in: app).label)
		XCTAssertFalse(element(app, "genre-tile-family-0").exists, "no read-only tile")
		// The tenure, as one sentence: the profile was created during this run, so it is the first day.
		let tenure = element(app, "profile-tenure")
		XCTAssertTrue(tenure.waitForExistence(timeout: 5), "profile-tenure")
		XCTAssertEqual(tenure.label, "Tu explores track1 depuis 1 jour")
		let save = app.buttons[Self.saveIdentifier]
		XCTAssertTrue(save.exists)
		XCTAssertEqual(save.label, "Sauvegarder")
		XCTAssertFalse(save.isEnabled)
		UITestFlows.screenshot(named: "3.3-genres", in: self)

		// The settings are the sheet of the icon button, and the analytics row is one of them.
		app.buttons["genres-settings"].tap()
		XCTAssertTrue(app.buttons["analytics-settings"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons["profile-settings-edit"].exists, "the genres are edited on the tab")
		app.buttons["Fermer"].tap()
		XCTAssertTrue(header.waitForExistence(timeout: 5))
	}

	/// TRA-737: a tick on the tab writes nothing; "Sauvegarder" does. After it the page stays where it is, the
	/// button goes off, and Today, which reads the new revision of the profile, computes the pick again.
	@MainActor
	func testEditingTheGenresAddsAFamilyThenTodayIsComputedAgain() {
		let app = firstProfile()
		UITestFlows.tabButton("Genres", in: app).tap()
		let save = app.buttons[Self.saveIdentifier]

		// The cards are closed and the first counts the genre that is already ticked.
		let family0 = card("family-0", in: app)
		let family1 = card("family-1", in: app)
		XCTAssertTrue(family0.waitForExistence(timeout: 5))
		XCTAssertTrue(family0.label.contains("1 sélectionné"))
		XCTAssertFalse(element(app, "subgenre-chip-local:genre-0a").exists)
		XCTAssertFalse(save.isEnabled)
		UITestFlows.tapAboveBar(family1, bar: save, in: app)
		UITestFlows.tapAboveBar(app.buttons["subgenre-chip-local:genre-1a"], bar: save, in: app)
		XCTAssertTrue(waitUntil { save.isEnabled }, "a new genre opens the button")
		UITestFlows.screenshot(named: "3.3-edit-genres", in: self)
		save.tap()

		// Saved in place: no jump to Today, the button is off again, and the card counts the new genre.
		XCTAssertTrue(waitUntil { !save.isEnabled }, "the button goes off once saved")
		XCTAssertTrue(save.exists, "still on the Genres tab")
		XCTAssertFalse(app.alerts.firstMatch.exists)
		XCTAssertTrue(family1.label.hasSuffix(", 1 sélectionné"), family1.label)

		// Today loads the recommendation again for the new revision of the profile.
		UITestFlows.tabButton("Aujourd’hui", in: app).tap()
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		UITestFlows.tabButton("Genres", in: app).tap()
		XCTAssertTrue(family0.label.hasSuffix(", 1 sélectionné"), family0.label)
		XCTAssertTrue(family1.label.hasSuffix(", 1 sélectionné"), family1.label)
		XCTAssertFalse(save.isEnabled)
	}

	/// TRA-737: "Sauvegarder" is on only when the selection differs from the saved one and holds a genre. A tick
	/// then the same tick again is back to the saved selection; unticking the only genre leaves nothing to save.
	/// A selection that is not saved stays when the tab is left, as long as the app lives.
	@MainActor
	func testTheSaveButtonFollowsTheDifferenceWithTheSavedSelection() {
		let app = firstProfile()
		UITestFlows.tabButton("Genres", in: app).tap()
		let save = app.buttons[Self.saveIdentifier]
		let chip1a = app.buttons["subgenre-chip-local:genre-1a"]
		let chip0a = app.buttons["subgenre-chip-local:genre-0a"]
		XCTAssertTrue(save.waitForExistence(timeout: 5))
		XCTAssertFalse(save.isEnabled, "nothing changed")

		// A tick opens the button, and the same tick again closes it.
		UITestFlows.tapAboveBar(card("family-1", in: app), bar: save, in: app)
		UITestFlows.tapAboveBar(chip1a, bar: save, in: app)
		XCTAssertTrue(waitUntil { save.isEnabled }, "genre ticked")
		UITestFlows.tapAboveBar(chip1a, bar: save, in: app)
		XCTAssertTrue(waitUntil { !save.isEnabled }, "back to the saved selection")

		// Unticking the only saved genre leaves nothing: there is nothing to save.
		UITestFlows.tapAboveBar(card("family-0", in: app), bar: save, in: app)
		UITestFlows.tapAboveBar(chip0a, bar: save, in: app)
		XCTAssertFalse(chip0a.isSelected)
		XCTAssertFalse(save.isEnabled, "nothing ticked")

		// A new tick on top of the empty selection opens it, and leaving the tab keeps it.
		UITestFlows.tapAboveBar(chip1a, bar: save, in: app)
		XCTAssertTrue(waitUntil { save.isEnabled }, "one genre, another than the saved one")
		UITestFlows.tabButton("Aujourd’hui", in: app).tap()
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		UITestFlows.tabButton("Genres", in: app).tap()
		XCTAssertTrue(card("family-1", in: app).waitForExistence(timeout: 5))
		XCTAssertTrue(card("family-1", in: app).label.hasSuffix(", 1 sélectionné"), card("family-1", in: app).label)
		XCTAssertFalse(card("family-0", in: app).label.contains("sélectionné"), card("family-0", in: app).label)
		XCTAssertTrue(save.isEnabled, "the selection in progress is kept")
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

	/// Same degradation once a profile exists and the first launch has left its snapshot on disk: the network
	/// reader of this launch cannot produce any card, so the families can only come from the disk. The tab
	/// keeps the last taxonomy, with "Sauvegarder" off since nothing has changed (TRA-828).
	@MainActor
	func testADegradedCatalogAfterAFirstLaunchKeepsTheGenresTabOnItsLastTaxonomy() {
		let app = firstProfile()
		UITestFlows.relaunch(app, catalog: Self.degradedCatalog)

		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		UITestFlows.tabButton("Genres", in: app).tap()
		XCTAssertTrue(card("family-0", in: app).waitForExistence(timeout: 5))
		XCTAssertTrue(card("family-1", in: app).exists)
		XCTAssertFalse(app.buttons["genres-retry"].exists)
		XCTAssertTrue(app.buttons[Self.saveIdentifier].exists)
		XCTAssertFalse(app.buttons[Self.saveIdentifier].isEnabled)
	}

	/// The same degradation without a snapshot (a device updated from a build that had none): Today keeps
	/// working off the stored `genre_ids`, and the Genres tab reads as unavailable, with "Sauvegarder" off,
	/// until the taxonomy is back.
	@MainActor
	func testADegradedCatalogWithoutASnapshotMakesTheGenresTabUnavailable() {
		let app = firstProfile()
		UITestFlows.relaunch(app, catalog: Self.degradedCatalog, extraArguments: ["-track1-reset-genre-catalog"])

		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		UITestFlows.tabButton("Genres", in: app).tap()
		XCTAssertTrue(app.buttons["genres-retry"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons[Self.saveIdentifier].isEnabled)
	}

	/// A profile of the first parent of the taxonomy catalog, made by the first-launch flow.
	@MainActor
	private func firstProfile() -> XCUIApplication {
		let app = UITestFlows.launch(catalog: Self.taxonomyCatalog)
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		XCTAssertTrue(element(app, "today-title").waitForExistence(timeout: 15))
		return app
	}

	/// "Sauvegarder", the bar of the Genres tab. The identifier is the one of the "Modifier mes genres" button
	/// it replaces (`GenresTabView.saveIdentifier`): `NavigationTests` and `TodayFlowTests` read it too.
	private static let saveIdentifier = "genres-edit"

	/// Polls `condition` until it holds, up to `timeout`: a button goes off or on a frame after the tap.
	@MainActor
	private func waitUntil(timeout: TimeInterval = 10, _ condition: () -> Bool) -> Bool {
		let deadline = Date().addingTimeInterval(timeout)
		while Date() < deadline {
			if condition() { return true }
			Thread.sleep(forTimeInterval: 0.1)
		}
		return condition()
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

	/// `editorialTaxonomy` with the longest real subgenre name (`data/genre-taxonomy.json`, 31 characters) for
	/// `local:genre-0a`: only that `name` changes.
	private static let longChipTaxonomy =
		"""
		{"mode":"editorial","version":2,"families":[{"key":"family-0","label":"Family 0","order":1},{"key":"family-1","label":"Family 1","order":2}],"genres":[{"id":"local:genre-0a","name":"North American Indigenous Music","family":"family-0","slugs":["genre:genre-0a"]},{"id":"local:genre-0b","name":"Genre 0b","family":"family-0","slugs":["genre:genre-0b"]},{"id":"local:genre-1a","name":"Genre 1a","family":"family-1","slugs":["genre:genre-1a"]}],"legacySelectionBySlug":{}}
		"""

	/// `editorialTaxonomy` with a folded name for `local:genre-0a` and a short one for `local:genre-0b`. Sizes
	/// measured by `ios-check` on PR #649 (iPhone 17 Pro, AX2, 2026-10-24): a one-line chip is 49.33 pt high,
	/// "Japanese Traditional" (20 characters) is 316 pt wide on one line in a 330 pt column, so about 14.7 pt per
	/// character plus 22 pt, and "Sai" is 71.33 pt wide. "Mauritanian Traditional" (23 characters) is about 360 pt
	/// on one line, more than the column, and folds on its two words of 11 characters: about 184 pt wide and
	/// 78.67 pt high. "Sai" fits beside it (184 + 8 + 71.33 = 263 pt), and the chips share a row for any column
	/// from 263 to 359 pt. (The first fixture, "Japanese Traditional", fitted on one line: a macOS probe had
	/// overestimated the font at AX2.) Only those two `name`s change.
	private static let sharedRowChipTaxonomy =
		"""
		{"mode":"editorial","version":2,"families":[{"key":"family-0","label":"Family 0","order":1},{"key":"family-1","label":"Family 1","order":2}],"genres":[{"id":"local:genre-0a","name":"Mauritanian Traditional","family":"family-0","slugs":["genre:genre-0a"]},{"id":"local:genre-0b","name":"Sai","family":"family-0","slugs":["genre:genre-0b"]},{"id":"local:genre-1a","name":"Genre 1a","family":"family-1","slugs":["genre:genre-1a"]}],"legacySelectionBySlug":{}}
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

	private static let longChipCatalog = catalog(taxonomy: longChipTaxonomy)

	private static let sharedRowChipCatalog = catalog(taxonomy: sharedRowChipTaxonomy)

	/// The same nodes and edges with the taxonomy the server serves when it cannot build the editorial one.
	private static let degradedCatalog = catalog(taxonomy: degradedTaxonomy)

	private static func catalog(taxonomy: String) -> String {
		"""
		{"version":"v1","revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taxonomy":\(taxonomy),"nodes":[{"identity":"genre:genre-0","type":"genre","name":"Genre 0","teaser":null},{"identity":"genre:genre-1","type":"genre","name":"Genre 1","teaser":null},{"identity":"genre:genre-0a","type":"genre","name":"Genre 0a","teaser":null},{"identity":"genre:genre-0b","type":"genre","name":"Genre 0b","teaser":null},{"identity":"genre:genre-1a","type":"genre","name":"Genre 1a","teaser":null},{"identity":"artist:artist-a","type":"artist","name":"Artist A","teaser":null},{"identity":"project:project-a","type":"project","name":"Project A","teaser":null},{"identity":"track:track-a","type":"track","name":"Track A","teaser":null}],"edges":[{"source":"artist:artist-a","target":"genre:genre-0a","type":"genres"},{"source":"project:project-a","target":"genre:genre-0a","type":"genres"},{"source":"track:track-a","target":"genre:genre-0a","type":"genres"},{"source":"artist:artist-a","target":"genre:genre-1a","type":"genres"},{"source":"project:project-a","target":"genre:genre-1a","type":"genres"},{"source":"track:track-a","target":"genre:genre-1a","type":"genres"}]}
		"""
	}
}
