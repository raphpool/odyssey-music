import XCTest

@testable import Track1

@MainActor
final class AppRouterNodeTests: XCTestCase {
	func testNodeRouteKeepsEachTabPathIndependent() throws {
		let router = AppRouter()
		let artist = try XCTUnwrap(NodeIdentity(rawValue: "artist:sample"))
		let album = try XCTUnwrap(NodeIdentity(rawValue: "project:sample"))

		router.openIndependentNode(artist, source: .home, in: .today)
		router.openIndependentNode(album, source: .search, in: .search)

		XCTAssertEqual(router.path(for: .today), [.node(identity: artist, context: .independent(source: .home))])
		XCTAssertEqual(router.path(for: .search), [.node(identity: album, context: .independent(source: .search))])
		XCTAssertTrue(router.path(for: .settings).isEmpty)
	}

	func testRelationRoutePreservesAttributionUntilAnotherIndependentDeparture() throws {
		let router = AppRouter()
		let artist = try XCTUnwrap(NodeIdentity(rawValue: "artist:source"))
		let album = try XCTUnwrap(NodeIdentity(rawValue: "project:target"))
		let track = try XCTUnwrap(NodeIdentity(rawValue: "track:next"))
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let context = NavigationContext(source: .home, recommendationID: recommendationID)
		let followed = NavigationContext(source: .relation, recommendationID: recommendationID)

		router.openNode(artist, context: context, in: .today)
		router.openNode(album, context: context.followingRelation(), in: .today)
		// A relation of a node reached through a relation: the attribution still comes from the first departure.
		router.openNode(track, context: followed.followingRelation(), in: .today)

		XCTAssertEqual(
			router.path(for: .today),
			[
				.node(identity: artist, context: context),
				.node(identity: album, context: followed),
				.node(identity: track, context: followed),
			]
		)
		router.openIndependentNode(album, source: .search, in: .search)
		XCTAssertEqual(
			router.path(for: .search).last, .node(identity: album, context: .independent(source: .search)))
	}

	func testSearchDepartureOnlyStacksInSearchPath() throws {
		let router = AppRouter()
		let genre = try XCTUnwrap(NodeIdentity(rawValue: "genre:trip-hop"))

		router.openIndependentNode(genre, source: .search, in: .search)

		XCTAssertEqual(router.path(for: .search), [.node(identity: genre, context: .independent(source: .search))])
		XCTAssertTrue(router.path(for: .today).isEmpty)
		XCTAssertTrue(router.path(for: .settings).isEmpty)
	}
}
