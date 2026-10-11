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

	func testSearchDepartureOnlyStacksInSearchPath() throws {
		let router = AppRouter()
		let genre = try XCTUnwrap(NodeIdentity(rawValue: "genre:trip-hop"))

		router.openIndependentNode(genre, source: .search, in: .search)

		XCTAssertEqual(router.path(for: .search), [.node(identity: genre, context: .independent(source: .search))])
		XCTAssertTrue(router.path(for: .today).isEmpty)
		XCTAssertTrue(router.path(for: .settings).isEmpty)
	}
}
