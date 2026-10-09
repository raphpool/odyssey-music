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
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let context = NavigationContext(source: .home, recommendationID: recommendationID)

		router.openNode(artist, context: context, in: .today)
		router.openNode(album, context: context.followingRelation(), in: .today)

		XCTAssertEqual(
			router.path(for: .today).last,
			.node(identity: album, context: NavigationContext(source: .relation, recommendationID: recommendationID))
		)
		router.openIndependentNode(album, source: .search, in: .search)
		XCTAssertEqual(
			router.path(for: .search).last, .node(identity: album, context: .independent(source: .search)))
	}
}
