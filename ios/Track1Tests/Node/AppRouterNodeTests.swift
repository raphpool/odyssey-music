import Track1Core
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
		XCTAssertTrue(router.path(for: .genres).isEmpty)
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
		XCTAssertTrue(router.path(for: .genres).isEmpty)
	}

	func testSelectingSearchOpensTheSheetAndKeepsTheSelectedTab() {
		let router = AppRouter()
		router.select(.genres)

		router.select(.search)

		XCTAssertTrue(router.isSearchPresented)
		XCTAssertEqual(router.selectedTab, .genres)
	}

	func testSelectingATabChangesItWithoutTouchingStacksOrTheSheet() throws {
		let router = AppRouter()
		let artist = try XCTUnwrap(NodeIdentity(rawValue: "artist:sample"))
		router.openIndependentNode(artist, source: .home, in: .today)

		router.select(.genres)
		router.select(.today)

		XCTAssertEqual(router.selectedTab, .today)
		XCTAssertFalse(router.isSearchPresented)
		XCTAssertEqual(router.path(for: .today).count, 1)
	}

	func testSelectingTodayAgainEmptiesOnlyItsStack() throws {
		let router = AppRouter()
		let artist = try XCTUnwrap(NodeIdentity(rawValue: "artist:sample"))
		let album = try XCTUnwrap(NodeIdentity(rawValue: "project:sample"))
		router.openIndependentNode(artist, source: .home, in: .today)
		router.openIndependentNode(album, source: .home, in: .today)
		router.openIndependentNode(artist, source: .search, in: .genres)
		XCTAssertEqual(router.path(for: .today).count, 2)

		router.select(.today)

		XCTAssertTrue(router.path(for: .today).isEmpty)
		XCTAssertEqual(router.path(for: .genres).count, 1)
		XCTAssertEqual(router.selectedTab, .today)
	}

	func testPopToKeepsThePathUpToTheIndexAndMinusOneIsTheRoot() throws {
		let router = AppRouter()
		for slug in ["a", "b", "c"] {
			router.openIndependentNode(
				try XCTUnwrap(NodeIdentity(rawValue: "artist:\(slug)")), source: .home, in: .today)
		}

		router.popTo(index: 5, in: .today)
		XCTAssertEqual(router.path(for: .today).count, 3)
		router.popTo(index: 0, in: .today)
		XCTAssertEqual(router.path(for: .today).count, 1)

		router.popTo(index: -1, in: .today)
		XCTAssertTrue(router.path(for: .today).isEmpty)
	}

	func testBreadcrumbListsTheRootThenTheRegisteredTitlesInPathOrder() throws {
		let router = AppRouter()
		let artist = try XCTUnwrap(NodeIdentity(rawValue: "artist:miles-davis"))
		let genre = try XCTUnwrap(NodeIdentity(rawValue: "genre:idm"))
		let context = NavigationContext.independent(source: .home)

		router.openNode(artist, context: context, title: "Miles Davis", in: .today)
		router.openNode(genre, context: context.followingRelation(), title: "IDM", in: .today)

		XCTAssertEqual(router.titles[genre], "IDM")
		XCTAssertEqual(
			router.breadcrumb(for: .today, rootTitle: "Aujourd’hui"),
			[
				TopBarCrumb(index: -1, title: "Aujourd’hui"),
				TopBarCrumb(index: 0, title: "Miles Davis"),
				TopBarCrumb(index: 1, title: "IDM"),
			]
		)
		XCTAssertEqual(
			router.breadcrumb(for: .today, rootTitle: nil).map(\.title), ["Miles Davis", "IDM"])
		XCTAssertTrue(router.breadcrumb(for: .genres, rootTitle: nil).isEmpty)
	}

	func testBreadcrumbNamesANodeOpenedWithoutTitleByItsSlug() throws {
		let router = AppRouter()
		let genre = try XCTUnwrap(NodeIdentity(rawValue: "genre:trip-hop"))
		router.openNode(genre, context: .independent(source: .home), title: "", in: .today)

		XCTAssertEqual(
			router.breadcrumb(for: .today, rootTitle: nil), [TopBarCrumb(index: 0, title: "trip-hop")])
	}

	/// The tab bar finds its icon and its UI identifier on the tab (TRA-671); the identifiers are the ones the
	/// UI tests look the buttons up by.
	func testEachTabNamesItsBarIconAndItsUIIdentifier() {
		XCTAssertEqual(AppTab.allCases.map(\.icon), [.tabToday, .tabGenres, .tabSearch])
		XCTAssertEqual(AppTab.allCases.map(\.accessibilityIdentifier), ["tab-today", "tab-genres", "tab-search"])
		XCTAssertEqual(AppTab.allCases.map(\.title), ["Aujourd’hui", "Genres", "Recherche"])
	}
}
