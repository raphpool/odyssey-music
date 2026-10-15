import XCTest

@testable import Track1Core

final class NodePageDisplayTests: XCTestCase {
	func testAChipListShowsEightEdgesThenCountsTheRest() throws {
		let section = try Self.section(field: "genres", type: .artist, count: 11)

		XCTAssertEqual(section.presentation, .chips)
		XCTAssertEqual(section.displayedEdges(expanded: false).map(\.name), (1...8).map { "Genre \($0)" })
		XCTAssertEqual(section.hiddenCount(expanded: false), 3)
	}

	func testExpandingShowsEverythingAndAListOfExactlyEightHasNoOverflow() throws {
		let long = try Self.section(field: "genres", type: .artist, count: 11)
		let eight = try Self.section(field: "genres", type: .artist, count: NodePageSpec.chipLimit)

		XCTAssertEqual(long.displayedEdges(expanded: true).count, 11)
		XCTAssertEqual(long.hiddenCount(expanded: true), 0)
		XCTAssertEqual(eight.displayedEdges(expanded: false).count, 8)
		XCTAssertEqual(eight.hiddenCount(expanded: false), 0)
	}

	func testTwelveSimilarArtistsRenderLastAfterMembersAsEightChipsAndAFourMoreOverflow() throws {
		let node = try Self.artist(edges: [
			"members": Self.edges(prefix: "member", count: 2),
			"similar_artists": Self.edges(prefix: "similar", count: 12),
		])

		let sections = NodePageModel.sections(for: node)
		let section = try XCTUnwrap(sections.last)

		XCTAssertEqual(sections.map(\.field), ["members", "similar_artists"])
		XCTAssertEqual(section.field, "similar_artists")
		XCTAssertEqual(section.label, "similar artists")
		XCTAssertEqual(section.presentation, .chips)
		XCTAssertTrue(section.showsCount)
		XCTAssertEqual(section.totalCount, 12)
		XCTAssertEqual(section.displayedEdges(expanded: false).map(\.name), (1...8).map { "Similar \($0)" })
		XCTAssertEqual(section.hiddenCount(expanded: false), 4)
		XCTAssertEqual(section.displayedEdges(expanded: true).count, 12)
		XCTAssertEqual(section.hiddenCount(expanded: true), 0)
	}

	func testAnArtistWithoutSimilarArtistsHasNoSimilarArtistsSection() throws {
		let absent = try Self.artist(edges: ["members": Self.edges(prefix: "member", count: 2)])
		let empty = try Self.artist(edges: ["similar_artists": "[]"])

		XCTAssertFalse(NodePageModel.sections(for: absent).map(\.field).contains("similar_artists"))
		XCTAssertTrue(NodePageModel.sections(for: empty).isEmpty)
	}

	func testSimilarArtistsOnlyExistOnAnArtistPage() throws {
		for type in NodeType.allCases where type != .artist {
			XCTAssertFalse(NodePageSpec.sectionOrder[type, default: []].contains("similar_artists"), type.rawValue)
		}
	}

	func testCarouselAndTrackListAreNeverTruncated() throws {
		let carousel = try Self.section(field: "discography", type: .artist, count: 12)
		let tracks = try Self.section(field: "tracklist", type: .project, count: 20)

		XCTAssertEqual(carousel.presentation, .carousel)
		XCTAssertEqual(carousel.displayedEdges(expanded: false).count, 12)
		XCTAssertEqual(carousel.hiddenCount(expanded: false), 0)
		XCTAssertEqual(tracks.presentation, .trackList)
		XCTAssertEqual(tracks.displayedEdges(expanded: false).count, 20)
		XCTAssertEqual(tracks.hiddenCount(expanded: false), 0)
	}

	func testASingleEdgeIsOneChipWithNoCount() throws {
		let section = try Self.section(field: "label", type: .project, count: 3)

		XCTAssertEqual(section.presentation, .single)
		XCTAssertFalse(section.showsCount)
		XCTAssertEqual(section.displayedEdges(expanded: false).count, 1)
		XCTAssertEqual(section.hiddenCount(expanded: false), 0)
	}

	func testStreamingBarHasActionsOnlyForArtistProjectAndTrackOnceResolved() throws {
		let action = try XCTUnwrap(
			ListeningActions.actions(for: .artist, name: "Sample", links: nil).first)
		let ready = ListeningState.ready([action])

		for type in [NodeType.artist, .project, .track] {
			XCTAssertEqual(NodePageListening.actions(for: type, state: ready), [action], type.rawValue)
		}
		for type in [NodeType.genre, .label] {
			XCTAssertTrue(NodePageListening.actions(for: type, state: ready).isEmpty, type.rawValue)
		}
		XCTAssertTrue(NodePageListening.actions(for: .artist, state: .loading).isEmpty)
		XCTAssertTrue(NodePageListening.actions(for: .artist, state: .hidden).isEmpty)
	}

	func testAFailedOpeningIsReportedInFrenchNamingTheService() {
		XCTAssertEqual(NodePageListening.failureMessage(for: .spotify), "Impossible d’ouvrir Spotify.")
		XCTAssertEqual(NodePageListening.failureMessage(for: .appleMusic), "Impossible d’ouvrir Apple Music.")
	}

	// MARK: - Highlights block (TRA-471)

	func testTheChipSectionsOfAnArtistCarryNeitherThePicksNorTheirBlock() throws {
		let node = try Self.artist(picks: true, discography: 3)

		let fields = NodePageModel.blocks(for: node).compactMap { block -> String? in
			if case .section(let section) = block { section.field } else { nil }
		}

		XCTAssertFalse(fields.contains("landmark_project"))
		XCTAssertFalse(fields.contains("reference_track"))
		XCTAssertEqual(fields, ["genres", "discography", "notable_tracks", "influences"])
	}

	func testTheHighlightsBlockComesJustAboveTheDiscographyCarousel() throws {
		let node = try Self.artist(picks: true, discography: 3)

		let kinds = NodePageModel.blocks(for: node).map(Self.describe)

		XCTAssertEqual(kinds, ["genres", "highlights", "discography", "notable_tracks", "influences"])
	}

	func testWithoutADiscographyTheBlockStandsWhereItWouldAndStillComesBeforeWhatFollows() throws {
		let node = try Self.artist(picks: true, discography: 0)

		XCTAssertEqual(
			NodePageModel.blocks(for: node).map(Self.describe),
			["genres", "highlights", "notable_tracks", "influences"])
	}

	func testAnArtistWithoutPicksHasNoBlockAndKeepsEverySection() throws {
		let node = try Self.artist(picks: false, discography: 3)

		XCTAssertEqual(
			NodePageModel.blocks(for: node).map(Self.describe),
			["genres", "discography", "notable_tracks", "influences"])
	}

	func testAnArtistWhoseOnlySectionsComeBeforeTheCarouselGetsTheBlockLast() throws {
		let node = try Self.node(
			type: .artist,
			edges: ["genres": Self.list("genre", 2), "landmark_project": Self.object("project", 1)])

		XCTAssertEqual(NodePageModel.blocks(for: node).map(Self.describe), ["genres", "highlights"])
	}

	func testOtherTypesKeepTheirSectionsAsTheyAre() throws {
		let node = try Self.node(
			type: .genre, edges: ["subgenres": Self.list("genre", 2), "landmark_projects": Self.list("project", 2)])

		XCTAssertEqual(NodePageModel.blocks(for: node).map(Self.describe), ["subgenres", "landmark_projects"])
	}

	private static func describe(_ block: NodePageBlock) -> String {
		switch block {
		case .section(let section): section.field
		case .highlights: "highlights"
		}
	}

	private static func artist(picks: Bool, discography: Int) throws -> NodeDetail {
		var edges = [
			"genres": list("genre", 2), "notable_tracks": list("track", 2), "influences": list("artist", 2),
		]
		if discography > 0 { edges["discography"] = list("project", discography) }
		if picks {
			edges["landmark_project"] = object("project", 1)
			edges["reference_track"] = object("track", 1)
		}
		return try node(type: .artist, edges: edges)
	}

	private static func object(_ kind: String, _ index: Int) -> String {
		#"{"slug":"\#(kind):\#(kind)-\#(index)","type":"\#(kind)","name":"\#(kind.capitalized) \#(index)"}"#
	}

	private static func list(_ kind: String, _ count: Int) -> String {
		"[" + (1...count).map { object(kind, $0) }.joined(separator: ",") + "]"
	}

	private static func node(type: NodeType, edges: [String: String]) throws -> NodeDetail {
		let body = edges.map { #""\#($0.key)":\#($0.value)"# }.joined(separator: ",")
		let source = """
			{"id":"\(type.rawValue):sample-node","type":"\(type.rawValue)","name":"Sample","teaser":null,"article":"","citations":[],"facts":{},"edges":{\(body)},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
	}

	private static func edges(prefix: String, count: Int) -> String {
		let edges = (1...count).map {
			#"{"slug":"artist:\#(prefix)-\#($0)","type":"artist","name":"\#(prefix.capitalized) \#($0)"}"#
		}
		return "[" + edges.joined(separator: ",") + "]"
	}

	/// An artist node whose `edges` are the given raw JSON values, keyed by field.
	private static func artist(edges: [String: String]) throws -> NodeDetail {
		try node(type: .artist, edges: edges)
	}

	private static func section(field: String, type: NodeType, count: Int) throws -> NodePageSection {
		let target: String = ["discography": "project", "tracklist": "track", "label": "label"][field] ?? "genre"
		let edges = (1...count).map {
			#"{"slug":"\#(target):\#(target)-\#($0)","type":"\#(target)","name":"\#(target.capitalized) \#($0)"}"#
		}
		let value = field == "label" ? edges[0] : "[" + edges.joined(separator: ",") + "]"
		let source = """
			{"id":"\(type.rawValue):sample-node","type":"\(type.rawValue)","name":"Sample","teaser":null,"article":"","citations":[],"facts":{},"edges":{"\(field)":\(value)},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		let node = try decoder.decode(NodeDetail.self, from: Data(source.utf8))
		return try XCTUnwrap(NodePageModel.sections(for: node).first)
	}
}
