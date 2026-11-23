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

	/// TRA-795: the first build never moved the focus off the opening sentence. The sentence whose frame holds
	/// the reading centre (387 pt from the top, `PlayerMetrics.readingCenter`) is the focus, and it alone.
	/// TRA-801: the scroll is a carousel, so a swipe is exactly one sentence, whatever its speed: the build of
	/// 11/23 could carry several sentences at once, or stop between two.
	@MainActor
	func testThePlayerStepsOneSentenceAtATimeAndFocusesTheOneAtTheReadingCenter() {
		let app = UITestFlows.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		UITestFlows.tapWhenReady(app.buttons["today-discover"])
		XCTAssertTrue(element(app, "player-paragraph-0").waitForExistence(timeout: 10), "player-paragraph-0")

		let opening = settledFocus(in: app)
		XCTAssertEqual(opening.focused, [0], "the first sentence is the focus when the reader opens")
		XCTAssertEqual(opening.centered, [0], "the first sentence is at the reading centre when it opens")

		// One swipe up: exactly the next sentence, and it holds the reading centre once the scroll has stopped.
		app.swipeUp()
		let first = settledFocus(in: app, movedFrom: opening.focused)
		XCTAssertEqual(first.focused, [1], "one swipe up moves the focus by exactly one sentence")
		XCTAssertEqual(first.centered, [1], "the focus holds the reading centre after the stop")

		// Two swipes up in a row, without waiting for the first scroll to settle in between: two sentences.
		// XCUITest may let the first one stop before the second; the touch mid-flight is in `PlayerScrollTests`.
		app.swipeUp()
		app.swipeUp()
		let second = settledFocus(in: app, movedFrom: first.focused)
		XCTAssertEqual(second.focused, [3], "two swipes up in a row move the focus by two sentences")
		XCTAssertEqual(second.centered, [3], "the focus holds the reading centre after the stop")

		// One swipe down goes back by one.
		app.swipeDown()
		let back = settledFocus(in: app, movedFrom: second.focused)
		XCTAssertEqual(back.focused, [2], "one swipe down moves the focus back by one sentence")
		XCTAssertEqual(back.centered, [2], "the focus holds the reading centre after the stop")
	}

	/// The sentences that expose the "focus" value, and those whose frame holds the reading centre. Read again
	/// until two reads 0.2 s apart agree on one sentence or `timeout` runs out: the scroll decelerates, then
	/// snaps, and a read in the middle of it must not be taken for the stop. With `start`, the sentence the
	/// swipe began on, a read that still shows it is not the stop either: the scroll may not have begun yet.
	@MainActor
	private func settledFocus(
		in app: XCUIApplication, movedFrom start: [Int]? = nil, timeout: TimeInterval = 5
	) -> (focused: [Int], centered: [Int]) {
		let deadline = Date().addingTimeInterval(timeout)
		var previous: (focused: [Int], centered: [Int])?
		while true {
			let reading = readFocus(in: app)
			let agrees = reading.focused.count == 1 && reading.focused == reading.centered && reading.focused != start
			if agrees, let previous, previous == reading { return reading }
			previous = reading
			if Date() >= deadline { return reading }
			Thread.sleep(forTimeInterval: 0.2)
		}
	}

	@MainActor
	private func readFocus(in app: XCUIApplication) -> (focused: [Int], centered: [Int]) {
		let center = 387.0
		let paragraphs = (0..<UITestFlows.articleSentenceCount).map { element(app, "player-paragraph-\($0)") }
		let present = paragraphs.enumerated().filter { $0.element.exists }
		let focused = present.filter { ($0.element.value as? String) == "focus" }.map(\.offset)
		let centered = present.filter { $0.element.frame.minY <= center && center <= $0.element.frame.maxY }
			.map(\.offset)
		return (focused, centered)
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

	// 2026-11-21 (TRA-796, TestFlight build 1, iPhone 393 x 852): the Now bar of the reader ended at 762, over
	// the tab bar that starts at 744. The window's bottom safe area read 0, so the reader counted 91 pt under
	// its bar instead of 113. Figma leaves 5 pt between the two (`PlayerMetrics.nowBarGap`).
	@MainActor
	func testThePlayerNowBarEndsAboveTheTabBar() {
		let app = openPlayer()
		let nowBar = element(app, "player-now-bar")
		XCTAssertTrue(nowBar.waitForExistence(timeout: 10), "player-now-bar")
		XCTAssertTrue(UITestFlows.tabBar(in: app).exists, "tab-bar")
		let nowBarFrame = UITestFlows.settledFrame(of: nowBar)
		let tabBarFrame = UITestFlows.settledFrame(of: UITestFlows.tabBar(in: app))
		// Half a point of slack for the rounding of the frames; the overlap of the bug was 18 pt.
		XCTAssertLessThanOrEqual(
			nowBarFrame.maxY + Self.nowBarGap, tabBarFrame.minY + 0.5,
			"player-now-bar \(nowBarFrame) is not \(Self.nowBarGap) pt above tab-bar \(tabBarFrame)")
	}

	// 2026-11-21 (TRA-796): with a home indicator the bar adds nothing under its pill, which then ends where
	// the window's safe area starts. The `tab-bar` frame cannot tell: its fade runs to the screen edge. So the
	// pill is read from the selected tab, which sits `Self.pillPadding` above the pill's bottom.
	@MainActor
	func testTheTabBarPillEndsAtTheWindowSafeArea() {
		let app = UITestFlows.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		let tab = UITestFlows.tabButton("Aujourd’hui", in: app)
		XCTAssertTrue(tab.waitForExistence(timeout: 15), "tab-today")
		let window = app.windows.firstMatch
		XCTAssertTrue(window.waitForExistence(timeout: 2))
		let pillBottom = UITestFlows.settledFrame(of: tab).maxY + Self.pillPadding
		XCTAssertEqual(
			pillBottom, window.frame.maxY - Self.homeIndicatorInset, accuracy: 1,
			"The pill ends at \(pillBottom) in a window of \(window.frame)")
	}

	/// `PlayerMetrics.nowBarGap`.
	private static let nowBarGap: CGFloat = 5
	/// `Track1TabBarMetrics.pillPadding`.
	private static let pillPadding: CGFloat = 4
	/// The bottom safe area of the iPhone 17 Pro in portrait, the only device of ios-check.
	private static let homeIndicatorInset: CGFloat = 34

	/// From the first launch to the reader of the node of the day. Its Now bar appears once `/links` answers.
	@MainActor
	private func openPlayer() -> XCUIApplication {
		let app = UITestFlows.launch()
		UITestFlows.declineConsent(app)
		UITestFlows.completeOnboarding(app)
		let discover = app.buttons["today-discover"]
		XCTAssertTrue(discover.waitForExistence(timeout: 15), "today-discover")
		UITestFlows.tapWhenReady(discover)
		XCTAssertTrue(element(app, "player-paragraph-0").waitForExistence(timeout: 10), "player-paragraph-0")
		return app
	}

	@MainActor
	private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
		app.descendants(matching: .any)[identifier].firstMatch
	}
}
