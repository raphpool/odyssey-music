import XCTest

/// Launch and first-run steps shared by the UI journeys that start from a fresh install (H.2, then I.2 and J.4).
///
/// The data is injected at the `ContentReaders` seam (plan D3), so no step touches the network: the catalog
/// feeds the onboarding and the daily pick, and the node and link fixtures answer every page the journey can
/// reach. The pick itself is random per install (it hashes the local profile ID), so a fixture has to serve
/// every work the catalog links to a genre, not one of them.
enum UITestFlows {
	private static let genre0 = "genre:genre-0"
	private static let artist = "artist:artist-a"
	private static let project = "project:project-a"
	private static let track = "track:track-a"
	private static let label = "label:label-a"
	/// Two families, each with one published genre: the editorial taxonomy the catalog serves (plan D4). The
	/// slug of a published genre is a genre node of the catalog, so the first family derives `genre:genre-0a`.
	private static let parents = ["genre:genre-0", "genre:genre-1"]
	private static let subgenres = ["genre:genre-0a", "genre:genre-1a"]
	private static let genres = parents + subgenres
	/// Computed: a stored `[String: Any]` is not `Sendable`, which a static property must be.
	private static var editorialTaxonomy: [String: Any] {
		[
			"mode": "editorial", "version": 2,
			"families": [
				["key": "family-0", "label": "Family 0", "order": 1],
				["key": "family-1", "label": "Family 1", "order": 2],
			],
			"genres": [
				["id": "local:genre-0a", "name": "Genre 0a", "family": "family-0", "slugs": [subgenres[0]]],
				["id": "local:genre-1a", "name": "Genre 1a", "family": "family-1", "slugs": [subgenres[1]]],
			],
			"legacySelectionBySlug": [String: [String]](),
		]
	}

	/// The two families and their genres, one work of each recommendable type linked to the first genre by
	/// `genres` edges, and a label, so that the pages of the five node types exist.
	static let catalogJSON = catalog(
		slugs: genres + [artist, project, track, label], linked: [artist, project, track])

	/// The same genres and an artist linked to none: nothing to recommend.
	static let catalogWithoutLinkedWorksJSON = catalog(slugs: genres + [artist], linked: [])

	/// Every page links to others, as the pipeline's nodes do; the three listenable types have links.
	static let fixturesJSON: String = {
		let pages: [String: (facts: [String: String], edges: [String: [String]])] = [
			genre0: (["era": "1990s"], ["key_artists": [artist], "landmark_projects": [project]]),
			artist: (
				["origin": "Paris"],
				["genres": [genre0], "labels": [label], "discography": [project], "notable_tracks": [track]]
			),
			project: (
				["year": "2001"],
				["artists": [artist], "label": [label], "genres": [genre0], "tracklist": [track]]
			),
			track: (
				["year": "2001"],
				["artists": [artist], "project": [project], "label": [label], "genres": [genre0]]
			),
			label: (["founded": "1995"], ["genres": [genre0], "roster": [artist], "notable_releases": [project]]),
		]
		let nodes = Dictionary(
			uniqueKeysWithValues: pages.map { ($0.key, nodeBody($0.key, $0.value.facts, $0.value.edges)) })
		let links = Dictionary(uniqueKeysWithValues: [artist, project, track].map { ($0, linksBody($0)) })
		return json(["nodes": nodes, "links": links])
	}()

	/// A first launch: consent, profile and daily recommendation are all reset. `reminders` is what the fake
	/// notification center answers to the opt-in screen, `grant` or `deny` (TRA-746): the system prompt cannot be
	/// driven reliably by XCUITest, so no journey ever meets it.
	@MainActor
	static func launch(
		catalog: String = catalogJSON, extraArguments: [String] = [], reminders: String = "grant"
	) -> XCUIApplication {
		let app = XCUIApplication()
		app.launchArguments =
			[
				"-AppleLanguages", "(fr)", "-track1-reset-analytics-consent", "-track1-reset-profile",
				"-track1-reset-daily-recommendation",
			] + extraArguments
		app.launchEnvironment = environment(catalog: catalog, reminders: reminders)
		app.launch()
		return app
	}

	/// Starts the app again on what the first launch stored: no reset argument, unless `extraArguments` has one.
	@MainActor
	static func relaunch(
		_ app: XCUIApplication, catalog: String = catalogJSON, extraArguments: [String] = [],
		reminders: String = "grant"
	) {
		app.terminate()
		app.launchArguments = ["-AppleLanguages", "(fr)"] + extraArguments
		app.launchEnvironment = environment(catalog: catalog, reminders: reminders)
		app.launch()
	}

	/// Waits for the decline button to be gone, which makes the step explicit and gives a clearer failure
	/// message than a later tap that finds nothing. It does not delay the tap on Welcome by itself: the consent
	/// leaves the tree right after the tap (see `startOnboarding` for the wait that matters).
	@MainActor
	static func declineConsent(_ app: XCUIApplication) {
		let identifier = "analytics-consent-decline"
		let decline = app.buttons[identifier]
		XCTAssertTrue(decline.waitForExistence(timeout: 10), "\(identifier) did not appear")
		decline.tap()
		XCTAssertTrue(
			decline.waitForNonExistence(timeout: 10), "\(identifier) is still on screen after the decline tap")
	}

	/// 2026-10-24 (TRA-683, ios-check of #578, run 40042347277): the tap on `onboarding-start` was synthesized
	/// 1.5 s after the decline and nothing followed, the app stayed on Welcome for the 10 s wait on the next
	/// screen. Welcome is reached through the `.loading` to `.onboarding` gate (a 0.35 s opacity fade) and
	/// `FirstLaunchOnboardingView` then goes `.ready`, so the button can exist, enabled, before it takes
	/// touches. The tap is therefore checked by its effect (the pseudo screen, since TRA-735), and sent again at
	/// most twice while Welcome is still there. A retap is safe: `OnboardingFlowView` only leaves a step that is
	/// on screen, so a tap during a push that is already requested does nothing. A green run does not prove the
	/// race is gone: it is intermittent, and this only narrows it.
	@MainActor
	static func startOnboarding(_ app: XCUIApplication) {
		let start = app.buttons["onboarding-start"]
		let pseudo = app.textFields[pseudoFieldIdentifier]
		tapWhenReady(start)
		var retries = 0
		while !pseudo.waitForExistence(timeout: 3), start.exists, retries < 2 {
			retries += 1
			start.tap()
		}
		XCTAssertTrue(
			pseudo.waitForExistence(timeout: 10),
			"onboarding-start tapped \(retries + 1)x, no pseudo screen")
	}

	static let pseudoFieldIdentifier = "onboarding-pseudo-field"
	static let discContinueIdentifier = "onboarding-disc-continue"
	static let genresContinueIdentifier = "onboarding-genres-continue"
	static let notificationsIdentifier = "onboarding-notifications"
	static let notificationsContinueIdentifier = "onboarding-notifications-continue"
	/// The variable the app reads to swap the system notification center for a fake (TRA-746).
	static let reminderCenterKey = "TRACK1_FAKE_REMINDER_CENTER"

	/// The pseudo and the disc, from the pseudo screen to the genre screen: the pseudo is typed and sent with
	/// the return key (the bar of the screen is under the software keyboard, as in the mock-up), the disc is a
	/// tile of the grid, then "Continuer". Every journey that goes through the onboarding and cares about the
	/// genres uses it. `disc` is the raw value of a `ProfileDisc`.
	@MainActor
	static func passPseudoAndDisc(_ app: XCUIApplication, pseudo: String = "Raph", disc: String = "blue") {
		let field = app.textFields[pseudoFieldIdentifier]
		XCTAssertTrue(field.waitForExistence(timeout: 10), "\(pseudoFieldIdentifier) did not appear")
		field.tap()
		field.typeText(pseudo + "\n")
		tapWhenReady(app.buttons["onboarding-disc-\(disc)"])
		tapWhenReady(app.buttons[discContinueIdentifier])
		XCTAssertTrue(
			app.buttons[genresContinueIdentifier].waitForExistence(timeout: 10), "no genre screen after the disc")
	}

	/// The tab bar and its buttons: the only place the tests ask for them, so a change of bar touches these two
	/// bodies and no journey. The bar is drawn by `Track1TabBar` (no native `UITabBar`): its container is the
	/// `tab-bar` element and each tab is a button found by `AppTab.accessibilityIdentifier`. `title` is the
	/// label of the tab (`AppTab.title`: "Aujourd’hui" with U+2019, "Genres", "Recherche"). Every tab mounts its
	/// own bar (2026-10-24, TRA-671), so the queries take `firstMatch` in case a tab left behind is still in the tree.
	@MainActor
	static func tabBar(in app: XCUIApplication) -> XCUIElement {
		app.otherElements["tab-bar"].firstMatch
	}

	private static let tabIdentifiers = [
		"Aujourd’hui": "tab-today",
		"Genres": "tab-genres",
		"Recherche": "tab-search",
	]

	/// A title that is not a tab ("Réglages": there is none, D8) is looked up as it is and finds nothing.
	@MainActor
	static func tabButton(_ title: String, in app: XCUIApplication) -> XCUIElement {
		app.buttons[tabIdentifiers[title] ?? title].firstMatch
	}

	/// The first launch up to the end of the flow: Welcome, the pseudo, the disc, the first family opened, one
	/// of its genres ticked. Every step waits for the next one: the push and unfold animations are not instant.
	@MainActor
	static func completeOnboarding(_ app: XCUIApplication) {
		startOnboarding(app)
		passPseudoAndDisc(app)
		let bar = app.buttons[genresContinueIdentifier]
		tapAboveBar(app.buttons["genre-card-family-0"], bar: bar, in: app)
		tapAboveBar(app.buttons["subgenre-chip-local:genre-0a"], bar: bar, in: app)
		tapWhenReady(bar)
		passNotifications(app)
	}

	/// The opt-in screen that ends the first launch (TRA-746): "Continuer" asks the fake center, and the answer
	/// leads to the tabs either way. The profile is written when this step ends, not the genre one.
	@MainActor
	static func passNotifications(_ app: XCUIApplication) {
		tapWhenReady(app.buttons[notificationsContinueIdentifier])
	}

	/// 2026-10-20 (TRA-639, ios-check): at the largest text size the header of the genre screen fills the
	/// first screen, so the cards, then the chips of the open card, start under the pinned action bar, which
	/// takes the touch (the large text test of `NavigationTests` waited 10 s for a chip that never showed).
	/// The list is scrolled until the element clears the bar and the 24 pt above its button, as a person would.
	@MainActor
	static func tapAboveBar(_ element: XCUIElement, bar: XCUIElement, in app: XCUIApplication) {
		XCTAssertTrue(element.waitForExistence(timeout: 10), "\(element) did not appear")
		XCTAssertTrue(bar.waitForExistence(timeout: 10), "\(bar) did not appear")
		for _ in 0..<8 where element.frame.maxY > bar.frame.minY - 24 {
			app.swipeUp()
		}
		XCTAssertLessThanOrEqual(element.frame.maxY, bar.frame.minY - 24, "\(element) stays under the action bar")
		element.tap()
	}

	/// Waits for `element` to be there and enabled (the CTA of a step is disabled until a genre is chosen).
	@MainActor
	static func tapWhenReady(_ element: XCUIElement, timeout: TimeInterval = 10) {
		XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(element) did not appear")
		XCTAssertTrue(element.isEnabled, "\(element) is disabled")
		element.tap()
	}

	/// The frame of `element` once two reads 100 ms apart are equal (the header animates its height when a
	/// card closes); fails the test after `timeout`.
	@MainActor
	static func settledFrame(of element: XCUIElement, timeout: TimeInterval = 3) -> CGRect {
		XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(element) did not appear")
		let deadline = Date().addingTimeInterval(timeout)
		var previous = element.frame
		while Date() < deadline {
			Thread.sleep(forTimeInterval: 0.1)
			let current = element.frame
			if current == previous { return current }
			previous = current
		}
		XCTFail("\(element) kept moving for \(timeout) s")
		return previous
	}

	@MainActor
	static func screenshot(named name: String, in test: XCTestCase) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		test.add(attachment)
	}

	// MARK: - Fixtures

	private static func environment(catalog: String, reminders: String) -> [String: String] {
		[
			"TRACK1_PROFILE_CATALOG_JSON": catalog, "TRACK1_UI_TEST_FIXTURES_JSON": fixturesJSON,
			reminderCenterKey: reminders,
		]
	}

	/// "artist:artist-a" is "Artist A": the name is read off the slug, so a fixture needs no second list.
	private static func name(of slug: String) -> String {
		String(slug.drop { $0 != ":" }.dropFirst()).replacingOccurrences(of: "-", with: " ").capitalized
	}

	private static func type(ofSlug slug: String) -> String {
		String(slug.prefix { $0 != ":" })
	}

	/// `linked` works get a `genres` edge to the first published genre, the one the first family derives.
	private static func catalog(slugs: [String], linked: [String]) -> String {
		json([
			"version": "v1",
			"revision": "sha256:" + String(repeating: "a", count: 64),
			"taxonomy": editorialTaxonomy,
			"nodes": slugs.map {
				["identity": $0, "type": type(ofSlug: $0), "name": name(of: $0), "teaser": NSNull()]
			},
			// The works linked to the first genre carry the `genres` edge the pick follows.
			"edges": linked.map { ["source": $0, "target": subgenres[0], "type": "genres"] },
		])
	}

	private static func edge(_ slug: String) -> [String: Any] {
		["slug": slug, "type": type(ofSlug: slug), "name": name(of: slug)]
	}

	private static func nodeBody(_ slug: String, _ facts: [String: String], _ edges: [String: [String]])
		-> [String: Any]
	{
		// Rule 6 of the Data contract: a single-valued edge is an object, not a list.
		let singles: Set = ["label", "project"]
		let edgeValues = Dictionary(
			uniqueKeysWithValues: edges.map { field, slugs -> (String, Any) in
				(field, singles.contains(field) ? edge(slugs[0]) : slugs.map(edge))
			})
		return [
			"node": [
				"id": slug, "type": type(ofSlug: slug), "name": name(of: slug), "teaser": "Teaser of \(name(of: slug)).",
				"article": "Article of \(name(of: slug)).", "citations": [Any](), "facts": facts, "edges": edgeValues,
				"materialized_at": "2026-01-01T00:00:00Z", "image_url": NSNull(),
			],
			"source": "cache",
		]
	}

	private static func linksBody(_ slug: String) -> [String: Any] {
		let kind = type(ofSlug: slug) == "project" ? "album" : type(ofSlug: slug)
		return [
			"slug": slug, "spotify": "https://open.spotify.com/\(kind)/fixture", "apple": NSNull(),
			"sources": [String: Any](), "resolvedAt": "2026-01-01T00:00:00Z",
		]
	}

	private static func json(_ object: [String: Any]) -> String {
		guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
			preconditionFailure("The UI test fixture is not valid JSON")
		}
		return String(decoding: data, as: UTF8.self)
	}
}
