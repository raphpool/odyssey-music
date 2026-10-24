import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

@MainActor
final class NodePageViewTests: XCTestCase {
	// MARK: - Glow

	func testGlowIsSilverOffTheRootWhateverTheNode() {
		for type in NodeType.allCases {
			XCTAssertEqual(NodePageView.glowTone(isRoot: false, type: type, tint: .red), .silver, type.rawValue)
			XCTAssertEqual(NodePageView.glowTone(isRoot: false, type: type, tint: nil), .silver, type.rawValue)
		}
	}

	func testRootProjectAndTrackTakeTheirTintOnlyWhenTheyHaveOne() {
		for type in [NodeType.project, .track] {
			XCTAssertEqual(NodePageView.glowTone(isRoot: true, type: type, tint: .red), .tinted(.red), type.rawValue)
		}
		XCTAssertEqual(NodePageView.glowTone(isRoot: true, type: .project, tint: nil), .ember)
	}

	func testRootGenreArtistAndLabelAreEmberEvenWithATint() {
		for type in [NodeType.genre, .artist, .label] {
			XCTAssertEqual(NodePageView.glowTone(isRoot: true, type: type, tint: .red), .ember, type.rawValue)
		}
	}

	// MARK: - Cover tint

	func testCoverTintIsReadFromTheLoadedStateOnly() {
		let coverTint = CoverTint(
			stops: Array(repeating: LinearRGB(red: 0.2, green: 0.1, blue: 0.1), count: 3),
			shadow: LinearRGB(red: 0.5, green: 0.2, blue: 0.2))

		XCTAssertEqual(NodePageView.coverTint(for: .loaded(UIImage(), tint: nil, coverTint: coverTint)), coverTint)
		XCTAssertNil(NodePageView.coverTint(for: .loaded(UIImage(), tint: .red, coverTint: nil)))
		XCTAssertNil(NodePageView.coverTint(for: .placeholder))
		XCTAssertNil(NodePageView.coverTint(for: .loading))
	}

	// MARK: - Opening a relation

	func testTouchingAChipRecordsOneEventAndPushesTheTargetNamedInTheBreadcrumb() async throws {
		let source = try XCTUnwrap(NodeIdentity(rawValue: "artist:source"))
		var events = [AnalyticsEvent]()
		let response = try Self.response(for: source)
		let model = NodeViewModel(
			identity: source,
			context: .independent(source: .home),
			readNode: { _ in .success(response, etag: nil) },
			recordEvent: { events.append($0) }
		)
		await model.load()
		events.removeAll()
		let router = AppRouter()
		let edge = try Self.edge("project:target", name: "Target")

		// The same wiring as `RootView`: the model records, the router pushes with the edge's name.
		model.openRelation(edge, kind: "discography") { _, context in
			router.openNode(edge.slug, context: context, title: edge.name, in: .today)
		}

		XCTAssertEqual(events.map(\.name), [.relationOpened])
		XCTAssertEqual(
			router.path(for: .today),
			[.node(identity: edge.slug, context: NavigationContext(source: .relation))])
		XCTAssertEqual(
			router.breadcrumb(for: .today, rootTitle: "Aujourd’hui"),
			[TopBarCrumb(index: -1, title: "Aujourd’hui"), TopBarCrumb(index: 0, title: "Target")])
	}

	// MARK: - Similar artists section

	func testTheSimilarArtistsSectionHasItsOwnHeaderAndOverflowIdentifiers() {
		XCTAssertEqual(SectionHeader.identifier(field: "similar_artists"), "section-similar_artists")
		XCTAssertEqual(
			EdgeChipOverflow.accessibilityIdentifier(field: "similar_artists"), "edge-overflow-similar_artists")
		XCTAssertEqual(EdgeChipOverflow.label(hiddenCount: 4), "+4 more")
	}

	func testTheSimilarArtistsSectionPresentationMatchesWhatTheViewDraws() throws {
		let json = (1...12).map {
			#"{"slug":"artist:similar-\#($0)","type":"artist","name":"Similar \#($0)"}"#
		}.joined(separator: ",")
		let source = """
			{"id":"artist:source","type":"artist","name":"Source","teaser":null,"article":"","citations":[],"facts":{},"edges":{"similar_artists":[\(json)]},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		let node = try decoder.decode(NodeDetail.self, from: Data(source.utf8))
		let section = try XCTUnwrap(NodePageModel.sections(for: node).first)

		// The view feeds these straight into `SectionHeader`, `EdgeChip` and `EdgeChipOverflow`.
		XCTAssertEqual(section.label, "similar artists")
		XCTAssertEqual(section.totalCount, 12)
		XCTAssertEqual(
			EdgeChip.accessibilityIdentifier(
				identity: try XCTUnwrap(section.displayedEdges(expanded: false).first?.slug)),
			"edge-chip-artist:similar-1")
		XCTAssertEqual(EdgeChipOverflow.label(hiddenCount: section.hiddenCount(expanded: false)), "+4 more")
	}

	// MARK: - Listening failure

	func testAFailedOpeningProducesTheListenErrorNoticeInFrench() async throws {
		let source = try XCTUnwrap(NodeIdentity(rawValue: "artist:source"))
		let response = try Self.response(for: source)
		let links = try Self.links(slug: source.rawValue)
		let model = NodeViewModel(
			identity: source,
			context: .independent(source: .home),
			readNode: { _ in .success(response, etag: nil) },
			readLinks: { _ in .success(links, etag: nil) }
		)
		await model.load()
		let action = try XCTUnwrap(NodePageListening.actions(for: .artist, state: model.listening).first)
		XCTAssertNil(NodePageView.listeningNotice(for: model.listeningFailure), "No failure, no notice.")

		// The OS refuses the URL, as `NodeView` reports it through the `OpenURLAction` completion.
		await model.openListening(action, using: { _ in false })

		let notice = try XCTUnwrap(NodePageView.listeningNotice(for: model.listeningFailure))
		XCTAssertEqual(ListeningFailureNotice.identifier, "listen-error")
		XCTAssertEqual(notice.provider, action.provider)
		XCTAssertEqual(notice.message, "Impossible d’ouvrir \(action.provider.displayName).")

		await model.openListening(action, using: { _ in true })

		XCTAssertNil(NodePageView.listeningNotice(for: model.listeningFailure), "A success clears the notice.")
	}

	// MARK: - Artist highlights (TRA-471)

	/// The page draws a `.highlights` block as `highlightsView`: one header per entry, the lowercase label of
	/// `SectionHeader`, then the card `landmark-album` or the row `reference-track`. This pins what the view
	/// is given; the pixels are checked on the simulator.
	func testTheArtistPageHighlightsCarryTheContractIdentifiersAndLabels() throws {
		let node = try Self.artist(edges: [
			"landmark_project": Self.edgeJSON("project:album", name: "Album"),
			"reference_track": Self.edgeJSON("track:song", name: "Song"),
			"discography": "[" + Self.edgeJSON("project:album", name: "Album") + "]",
		])

		let entries = try XCTUnwrap(Self.highlightEntries(of: node))

		XCTAssertEqual(entries.map(\.identifier), ["landmark-album", "reference-track"])
		XCTAssertEqual(entries.map { SectionHeader.displayTitle($0.label) }, ["landmark album", "reference track"])
		XCTAssertEqual(
			entries.map { SectionHeader.identifier(field: $0.field) },
			["section-landmark_project", "section-reference_track"])
	}

	func testTheArtistPageDrawsNoHighlightsBlockWithoutPicks() throws {
		let node = try Self.artist(edges: [
			"discography": "[" + Self.edgeJSON("project:album", name: "Album") + "]"
		])

		XCTAssertNil(Self.highlightEntries(of: node))
		XCTAssertEqual(NodePageModel.blocks(for: node).count, 1, "The discography keeps its own section.")
	}

	func testTheHighlightsOpenTheirTargetThroughTheChipWiring() async throws {
		let source = try XCTUnwrap(NodeIdentity(rawValue: "artist:source"))
		var events = [AnalyticsEvent]()
		let response = try Self.response(for: source)
		let model = NodeViewModel(
			identity: source,
			context: .independent(source: .home),
			readNode: { _ in .success(response, etag: nil) },
			recordEvent: { events.append($0) }
		)
		await model.load()
		events.removeAll()
		let router = AppRouter()
		let node = try Self.artist(edges: ["landmark_project": Self.edgeJSON("project:album", name: "Album")])
		let entry = try XCTUnwrap(Self.highlightEntries(of: node)?.first)

		model.openRelation(entry.edge, kind: entry.field) { _, context in
			router.openNode(entry.edge.slug, context: context, title: entry.edge.name, in: .today)
		}

		XCTAssertEqual(
			router.path(for: .today),
			[.node(identity: entry.edge.slug, context: NavigationContext(source: .relation))])
		XCTAssertEqual(events.first?.properties["relation_kind"], .string("landmark_project"))
	}

	private static func highlightEntries(of node: NodeDetail) -> [ArtistHighlights.Entry]? {
		for block in NodePageModel.blocks(for: node) {
			if case .highlights(let highlights) = block { return highlights.entries }
		}
		return nil
	}

	private static func edgeJSON(_ slug: String, name: String) -> String {
		let type = slug.prefix { $0 != ":" }
		return #"{"slug":"\#(slug)","type":"\#(type)","name":"\#(name)"}"#
	}

	private static func artist(edges: [String: String]) throws -> NodeDetail {
		let body = edges.map { #""\#($0.key)":\#($0.value)"# }.joined(separator: ",")
		let source = """
			{"id":"artist:sample","type":"artist","name":"Sample","teaser":null,"article":"","citations":[],"facts":{},"edges":{\(body)},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
	}

	private static func links(slug: String) throws -> LinksResponse {
		let json = """
			{"slug":"\(slug)","spotify":"https://open.spotify.com/artist/abc123",
			"apple":"https://music.apple.com/fr/artist/sample/123","sources":{},"resolvedAt":"2026-10-01T00:00:00Z"}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(LinksResponse.self, from: Data(json.utf8))
	}

	private static func response(for identity: NodeIdentity) throws -> NodeResponse {
		let source = """
			{"node":{"id":"\(identity.rawValue)","type":"artist","name":"Source","teaser":null,"article":"","citations":[],"facts":{},"edges":{},"materialized_at":"2026-10-08T00:00:00Z","image_url":null},"source":"cache"}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeResponse.self, from: Data(source.utf8))
	}

	private static func edge(_ slug: String, name: String) throws -> NodeEdge {
		let type = slug.prefix { $0 != ":" }
		let source =
			#"{"slug":"\#(slug)","type":"\#(type)","name":"\#(name)","mbid":null,"qid":null,"year":null,"releaseType":null}"#
		return try JSONDecoder().decode(NodeEdge.self, from: Data(source.utf8))
	}
}
