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
