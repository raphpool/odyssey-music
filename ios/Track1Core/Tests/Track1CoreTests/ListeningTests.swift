import XCTest

@testable import Track1Core

@MainActor
final class ListeningTests: XCTestCase {
	private let spotifyTrack = "https://open.spotify.com/track/123"
	private let appleAlbum = "https://music.apple.com/fr/album/example/1"

	// MARK: - actions(for:name:links:)

	func testArtistWithExactLinksYieldsTwoExactActionsCarryingTheReceivedURLs() throws {
		let links = try Self.links(spotify: spotifyTrack, apple: appleAlbum)

		let actions = ListeningActions.actions(for: .artist, name: "Aphex Twin", links: links)

		XCTAssertEqual(
			actions,
			[
				ListeningAction(
					provider: .spotify, url: try XCTUnwrap(URL(string: spotifyTrack)), linkKind: .exact,
					title: "Écouter sur Spotify"),
				ListeningAction(
					provider: .appleMusic, url: try XCTUnwrap(URL(string: appleAlbum)), linkKind: .exact,
					title: "Écouter sur Apple Music"),
			])
	}

	func testMissingOrEmptyLinksYieldTwoSearchActions() throws {
		let expected = [
			ListeningAction(
				provider: .spotify, url: try XCTUnwrap(URL(string: "https://open.spotify.com/search/Aphex%20Twin")),
				linkKind: .search, title: "Rechercher sur Spotify"),
			ListeningAction(
				provider: .appleMusic,
				url: try XCTUnwrap(URL(string: "https://music.apple.com/search?term=Aphex%20Twin")),
				linkKind: .search, title: "Rechercher sur Apple Music"),
		]

		XCTAssertEqual(ListeningActions.actions(for: .artist, name: "Aphex Twin", links: nil), expected)
		XCTAssertEqual(
			ListeningActions.actions(
				for: .artist, name: "Aphex Twin", links: try Self.links(spotify: nil, apple: nil)),
			expected)
	}

	func testOnlyTheMissingProviderFallsBackToSearch() throws {
		let links = try Self.links(spotify: spotifyTrack, apple: nil)

		let actions = ListeningActions.actions(for: .track, name: "Windowlicker", links: links)

		XCTAssertEqual(actions.map(\.provider), [.spotify, .appleMusic])
		XCTAssertEqual(actions.map(\.linkKind), [.exact, .search])
		XCTAssertEqual(actions.last?.url.absoluteString, "https://music.apple.com/search?term=Windowlicker")
	}

	func testGenreAndLabelNeverYieldAnAction() throws {
		let links = try Self.links(spotify: spotifyTrack, apple: appleAlbum)

		for type in [NodeType.genre, .label] {
			XCTAssertEqual(ListeningActions.actions(for: type, name: "Techno", links: links), [])
			XCTAssertEqual(ListeningActions.actions(for: type, name: "Techno", links: nil), [])
		}
	}

	func testEveryListenableTypeYieldsSpotifyThenAppleMusic() {
		for type in [NodeType.artist, .project, .track] {
			XCTAssertEqual(
				ListeningActions.actions(for: type, name: "Burial", links: nil).map(\.provider),
				ListeningProvider.allCases)
		}
	}

	func testBlankNameYieldsNoSearchActionButKeepsExactLinks() throws {
		XCTAssertEqual(ListeningActions.actions(for: .artist, name: "   \n\t ", links: nil), [])
		XCTAssertEqual(ListeningActions.actions(for: .artist, name: "", links: nil), [])

		let links = try Self.links(spotify: spotifyTrack, apple: nil)
		let actions = ListeningActions.actions(for: .artist, name: " ", links: links)
		XCTAssertEqual(actions.map(\.linkKind), [.exact])
		XCTAssertEqual(actions.map(\.provider), [.spotify])
	}

	// MARK: - searchURL(for:name:)

	func testSearchEncodingMatchesEncodeURIComponent() {
		let cases: [(name: String, encoded: String)] = [
			("AC/DC", "AC%2FDC"),
			("Sigur Rós", "Sigur%20R%C3%B3s"),
			("R&B ?", "R%26B%20%3F"),
			("Guns N' Roses", "Guns%20N'%20Roses"),
			("  Windowlicker \n", "Windowlicker"),
			("A-B_C.D!E~F*G'H(I)J", "A-B_C.D!E~F*G'H(I)J"),
			("a+b=c#d%e@f:g;h,i$j", "a%2Bb%3Dc%23d%25e%40f%3Ag%3Bh%2Ci%24j"),
			("a\"b<c>d[e]f\\g^h`i{j|k}", "a%22b%3Cc%3Ed%5Be%5Df%5Cg%5Eh%60i%7Bj%7Ck%7D"),
			("日本 🎵", "%E6%97%A5%E6%9C%AC%20%F0%9F%8E%B5"),
		]

		for (name, encoded) in cases {
			XCTAssertEqual(
				ListeningActions.searchURL(for: .spotify, name: name)?.absoluteString,
				"https://open.spotify.com/search/\(encoded)", name)
			XCTAssertEqual(
				ListeningActions.searchURL(for: .appleMusic, name: name)?.absoluteString,
				"https://music.apple.com/search?term=\(encoded)", name)
		}
	}

	func testSearchURLIsNilForABlankName() {
		for provider in ListeningProvider.allCases {
			XCTAssertNil(ListeningActions.searchURL(for: provider, name: " \n"))
		}
	}

	func testEverySearchURLIsSafeForItsOwnProvider() throws {
		for provider in ListeningProvider.allCases {
			let url = try XCTUnwrap(ListeningActions.searchURL(for: provider, name: "AC/DC & Co. ?"))
			XCTAssertTrue(ListeningActions.isSafe(url, for: provider))
		}
	}

	// MARK: - isSafe

	func testSpotifySafetyRefusesLookalikeAndUnsafeURLs() throws {
		let refused = [
			"http://open.spotify.com/x",
			"https://open.spotify.com.evil.example/x",
			"https://evil.open.spotify.com/x",
			"https://evilopen.spotify.com/x",
			"https://evil.example/open.spotify.com",
			"https://evil.example/?u=https://open.spotify.com/x",
			"https://u:p@open.spotify.com/x",
			"https://u@open.spotify.com/x",
			"https://open.spotify.com:444/x",
			"https://open.spotify.com:443/x",
			"https://music.apple.com/x",
			"spotify:track:123",
			"ftp://open.spotify.com/x",
		]
		for value in refused {
			let url = try XCTUnwrap(URL(string: value), value)
			XCTAssertFalse(ListeningActions.isSafe(url, for: .spotify), value)
		}

		for value in ["https://open.spotify.com/x", "https://OPEN.SPOTIFY.COM/track/1?si=a#b"] {
			let url = try XCTUnwrap(URL(string: value), value)
			XCTAssertTrue(ListeningActions.isSafe(url, for: .spotify), value)
		}
	}

	func testAppleMusicSafetyIsBoundToItsOwnHost() throws {
		let apple = try XCTUnwrap(URL(string: appleAlbum))
		let spotify = try XCTUnwrap(URL(string: spotifyTrack))
		let suffixed = try XCTUnwrap(URL(string: "https://music.apple.com.evil.example/x"))

		XCTAssertTrue(ListeningActions.isSafe(apple, for: .appleMusic))
		XCTAssertFalse(ListeningActions.isSafe(apple, for: .spotify))
		XCTAssertFalse(ListeningActions.isSafe(spotify, for: .appleMusic))
		XCTAssertFalse(ListeningActions.isSafe(suffixed, for: .appleMusic))
	}

	// MARK: - open

	func testUnsafeURLNeverReachesTheOSAndRecordsASingleUnsafeURLFailure() async throws {
		let hostile = ListeningAction(
			provider: .spotify, url: try XCTUnwrap(URL(string: "https://open.spotify.com.evil.example/track/123")),
			linkKind: .exact, title: "Écouter sur Spotify")
		let recorder = Recorder()
		var openCalls = 0

		let outcome = await ListeningActions.open(
			hostile, node: try Self.identity("track:windowlicker"), context: .independent(source: .home),
			openURL: { _ in
				openCalls += 1
				return true
			},
			recordEvent: recorder.record)

		XCTAssertEqual(outcome, .unsafeURL)
		XCTAssertEqual(openCalls, 0)
		XCTAssertEqual(recorder.events.map(\.name), [.externalListeningFailed])
		XCTAssertEqual(
			recorder.events.first?.properties,
			[
				"node_id": .string("track:windowlicker"), "node_type": .string("track"),
				"provider": .string("spotify"), "link_kind": .string("exact"), "error_code": .string("unsafe_url"),
			])
		XCTAssertTrue(recorder.events.allSatisfy(AnalyticsValidation.accepts))
	}

	func testAProviderURLUsedWithAnotherProviderIsUnsafe() async throws {
		let mismatched = ListeningAction(
			provider: .appleMusic, url: try XCTUnwrap(URL(string: spotifyTrack)), linkKind: .exact,
			title: "Écouter sur Apple Music")
		let recorder = Recorder()
		var openCalls = 0

		let outcome = await ListeningActions.open(
			mismatched, node: try Self.identity("track:windowlicker"), context: .independent(source: .home),
			openURL: { _ in
				openCalls += 1
				return true
			},
			recordEvent: recorder.record)

		XCTAssertEqual(outcome, .unsafeURL)
		XCTAssertEqual(openCalls, 0)
		XCTAssertEqual(recorder.events.map(\.name), [.externalListeningFailed])
	}

	func testOSRefusalRecordsASingleOpenFailed() async throws {
		let action = try XCTUnwrap(ListeningActions.actions(for: .artist, name: "Burial", links: nil).last)
		let recorder = Recorder()
		var opened = [URL]()

		let outcome = await ListeningActions.open(
			action, node: try Self.identity("artist:burial"), context: .independent(source: .search),
			openURL: { url in
				opened.append(url)
				return false
			},
			recordEvent: recorder.record)

		XCTAssertEqual(outcome, .openFailed)
		XCTAssertEqual(opened, [action.url])
		XCTAssertEqual(recorder.events.map(\.name), [.externalListeningFailed])
		XCTAssertEqual(recorder.events.first?.source, .search)
		XCTAssertEqual(
			recorder.events.first?.properties,
			[
				"node_id": .string("artist:burial"), "node_type": .string("artist"),
				"provider": .string("apple_music"), "link_kind": .string("search"),
				"error_code": .string("open_failed"),
			])
		XCTAssertTrue(recorder.events.allSatisfy(AnalyticsValidation.accepts))
	}

	func testOSSuccessRecordsASingleOpenedWithContextAttribution() async throws {
		let links = try Self.links(spotify: spotifyTrack, apple: nil)
		let action = try XCTUnwrap(ListeningActions.actions(for: .track, name: "Windowlicker", links: links).first)
		let recommendationID = try XCTUnwrap(UUID(uuidString: "11111111-1111-4111-8111-111111111111"))
		let notificationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let recorder = Recorder()
		var opened = [URL]()

		let outcome = await ListeningActions.open(
			action, node: try Self.identity("track:windowlicker"),
			context: NavigationContext(
				source: .notification, recommendationID: recommendationID, notificationID: notificationID),
			openURL: { url in
				opened.append(url)
				return true
			},
			recordEvent: recorder.record)

		XCTAssertEqual(outcome, .opened)
		XCTAssertEqual(opened, [action.url])
		XCTAssertEqual(recorder.events.map(\.name), [.externalListeningOpened])
		XCTAssertEqual(recorder.events.first?.source, .notification)
		XCTAssertEqual(
			recorder.events.first?.properties,
			[
				"node_id": .string("track:windowlicker"), "node_type": .string("track"),
				"provider": .string("spotify"), "link_kind": .string("exact"),
				"recommendation_id": .string("11111111-1111-4111-8111-111111111111"),
				"notification_id": .string("22222222-2222-4222-8222-222222222222"),
			])
		XCTAssertTrue(recorder.events.allSatisfy(AnalyticsValidation.accepts))
	}

	func testOpeningWithoutARecorderStillReportsTheOutcome() async throws {
		let action = try XCTUnwrap(
			ListeningActions.actions(for: .project, name: "Selected Ambient Works", links: nil).first)
		let identity = try Self.identity("project:selected-ambient-works")

		let opened = await ListeningActions.open(
			action, node: identity, context: .independent(source: .home), openURL: { _ in true }, recordEvent: nil)
		let failed = await ListeningActions.open(
			action, node: identity, context: .independent(source: .home), openURL: { _ in false }, recordEvent: nil)

		XCTAssertEqual(opened, .opened)
		XCTAssertEqual(failed, .openFailed)
	}

	// MARK: - Helpers

	@MainActor
	private final class Recorder {
		private(set) var events = [AnalyticsEvent]()
		var record: NodeEventRecorder { { [self] event in events.append(event) } }
	}

	private static func identity(_ value: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: value))
	}

	private static func links(spotify: String?, apple: String?) throws -> LinksResponse {
		func literal(_ value: String?) -> String { value.map { "\"\($0)\"" } ?? "null" }
		let json = """
			{"slug":"artist:sample-node","spotify":\(literal(spotify)),"apple":\(literal(apple)),
			"sources":{},"resolvedAt":"2026-10-01T00:00:00Z"}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(LinksResponse.self, from: Data(json.utf8))
	}
}
