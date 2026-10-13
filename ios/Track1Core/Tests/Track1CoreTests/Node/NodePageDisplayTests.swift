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
