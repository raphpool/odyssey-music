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
	private static let genres = (0..<3).map { "genre:genre-\($0)" }

	/// Three genres, one work of each recommendable type linked to the first one by `genres` edges, and a
	/// label, so that the pages of the five node types exist.
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

	/// A first launch: consent, profile and daily recommendation are all reset.
	@MainActor
	static func launch(catalog: String = catalogJSON) -> XCUIApplication {
		let app = XCUIApplication()
		app.launchArguments = [
			"-AppleLanguages", "(fr)", "-track1-reset-analytics-consent", "-track1-reset-profile",
			"-track1-reset-daily-recommendation",
		]
		app.launchEnvironment = environment(catalog: catalog)
		app.launch()
		return app
	}

	/// Starts the app again on what the first launch stored: no reset argument.
	@MainActor
	static func relaunch(_ app: XCUIApplication, catalog: String = catalogJSON) {
		app.terminate()
		app.launchArguments = ["-AppleLanguages", "(fr)"]
		app.launchEnvironment = environment(catalog: catalog)
		app.launch()
	}

	@MainActor
	static func declineConsent(_ app: XCUIApplication) {
		app.buttons["analytics-consent-decline"].tap()
	}

	/// Picks the first genre of the catalog, the minimum of the profile (D13).
	@MainActor
	static func completeOnboarding(_ app: XCUIApplication) {
		app.buttons["profile-choose"].tap()
		app.buttons["genre-\(genre0)"].tap()
		app.buttons["profile-continue"].tap()
	}

	@MainActor
	static func screenshot(named name: String, in test: XCTestCase) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		test.add(attachment)
	}

	// MARK: - Fixtures

	private static func environment(catalog: String) -> [String: String] {
		["TRACK1_PROFILE_CATALOG_JSON": catalog, "TRACK1_UI_TEST_FIXTURES_JSON": fixturesJSON]
	}

	/// "artist:artist-a" is "Artist A": the name is read off the slug, so a fixture needs no second list.
	private static func name(of slug: String) -> String {
		String(slug.drop { $0 != ":" }.dropFirst()).replacingOccurrences(of: "-", with: " ").capitalized
	}

	private static func type(ofSlug slug: String) -> String {
		String(slug.prefix { $0 != ":" })
	}

	/// `linked` works get a `genres` edge to the first genre.
	private static func catalog(slugs: [String], linked: [String]) -> String {
		json([
			"version": "v1",
			"revision": "sha256:" + String(repeating: "a", count: 64),
			"taxonomy": ["mode": "degraded", "available": true],
			"nodes": slugs.map {
				["identity": $0, "type": type(ofSlug: $0), "name": name(of: $0), "teaser": NSNull()]
			},
			"edges": linked.map { ["source": $0, "target": genre0, "type": "genres"] },
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
