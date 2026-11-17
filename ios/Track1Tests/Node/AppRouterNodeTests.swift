import Track1Core
import UserNotifications
import XCTest

@testable import Track1

@MainActor
final class AppRouterNodeTests: XCTestCase {
	func testPlayerRouteKeepsEachTabPathIndependent() throws {
		let router = AppRouter()
		let artist = try XCTUnwrap(NodeIdentity(rawValue: "artist:sample"))
		let album = try XCTUnwrap(NodeIdentity(rawValue: "project:sample"))

		router.openPlayer(artist, context: .independent(source: .home), in: .today)
		router.openPlayer(album, context: .independent(source: .onboarding), in: .genres)

		XCTAssertEqual(router.path(for: .today), [.player(identity: artist, context: .independent(source: .home))])
		XCTAssertEqual(
			router.path(for: .genres), [.player(identity: album, context: .independent(source: .onboarding))])
	}

	/// TRA-736: "Découvrir" pushes the reader of the recommended node, attributed to the recommendation, and the
	/// back button of the reader (`router.pop(in: .today)`) returns to the home.
	func testThePlayerRouteCarriesTheRecommendationAndBackReturnsToTheHome() throws {
		let router = AppRouter()
		let track = try XCTUnwrap(NodeIdentity(rawValue: "track:sample"))
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let context = NavigationContext(source: .home, recommendationID: recommendationID)

		router.openPlayer(track, context: context, in: .today)

		XCTAssertEqual(router.path(for: .today), [.player(identity: track, context: context)])
		router.pop(in: .today)
		XCTAssertTrue(router.path(for: .today).isEmpty)
	}

	func testOpeningThePlayerWithoutATabUsesTheSelectedOne() throws {
		let router = AppRouter()
		let track = try XCTUnwrap(NodeIdentity(rawValue: "track:sample"))

		router.openPlayer(track, context: .independent(source: .home))

		XCTAssertEqual(router.path(for: .today).count, 1)
		XCTAssertTrue(router.path(for: .genres).isEmpty)
	}

	/// TRA-771: there are two root tabs and no third destination.
	func testTheRootTabsAreTodayAndGenres() {
		XCTAssertEqual(AppTab.allCases, [.today, .genres])
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
		router.openIndependentNode(album, source: .onboarding, in: .genres)
		XCTAssertEqual(
			router.path(for: .genres).last, .node(identity: album, context: .independent(source: .onboarding)))
	}

	func testDepartureOnlyStacksInItsOwnTab() throws {
		let router = AppRouter()
		let genre = try XCTUnwrap(NodeIdentity(rawValue: "genre:trip-hop"))

		router.openPlayer(genre, context: .independent(source: .onboarding), in: .genres)

		XCTAssertEqual(
			router.path(for: .genres), [.player(identity: genre, context: .independent(source: .onboarding))])
		XCTAssertTrue(router.path(for: .today).isEmpty)
	}

	func testSelectingATabChangesItWithoutTouchingStacks() throws {
		let router = AppRouter()
		let artist = try XCTUnwrap(NodeIdentity(rawValue: "artist:sample"))
		router.openPlayer(artist, context: .independent(source: .home), in: .today)

		router.select(.genres)
		XCTAssertEqual(router.selectedTab, .genres)
		router.select(.today)

		XCTAssertEqual(router.selectedTab, .today)
		XCTAssertEqual(router.path(for: .today).count, 1)
	}

	func testSelectingGenresAgainKeepsItsStack() throws {
		let router = AppRouter()
		let genre = try XCTUnwrap(NodeIdentity(rawValue: "genre:idm"))
		router.select(.genres)
		router.openPlayer(genre, context: .independent(source: .home), in: .genres)

		router.select(.genres)

		XCTAssertEqual(router.selectedTab, .genres)
		XCTAssertEqual(router.path(for: .genres).count, 1)
	}

	func testSelectingTodayAgainEmptiesOnlyItsStack() throws {
		let router = AppRouter()
		let artist = try XCTUnwrap(NodeIdentity(rawValue: "artist:sample"))
		let album = try XCTUnwrap(NodeIdentity(rawValue: "project:sample"))
		router.openPlayer(artist, context: .independent(source: .home), in: .today)
		router.openPlayer(album, context: .independent(source: .home), in: .today)
		router.openPlayer(artist, context: .independent(source: .onboarding), in: .genres)
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
		XCTAssertEqual(AppTab.allCases.map(\.icon), [.tabToday, .tabGenres])
		XCTAssertEqual(AppTab.allCases.map(\.accessibilityIdentifier), ["tab-today", "tab-genres"])
		XCTAssertEqual(AppTab.allCases.map(\.title), ["Aujourd’hui", "Genres"])
	}

	/// TRA-747, from Genres with the reader open on Today: the tab is Today and its stack is empty.
	func testShowTodayFromGenresClosesTheReaderOpenOnToday() throws {
		let router = AppRouter()
		let track = try XCTUnwrap(NodeIdentity(rawValue: "track:sample"))
		let genre = try XCTUnwrap(NodeIdentity(rawValue: "genre:trip-hop"))
		router.openPlayer(track, context: .independent(source: .home), in: .today)
		router.openNode(genre, context: .independent(source: .home), in: .genres)
		router.select(.genres)

		router.showToday()

		XCTAssertEqual(router.selectedTab, .today)
		XCTAssertTrue(router.path(for: .today).isEmpty)
		XCTAssertEqual(router.path(for: .genres).count, 1)
	}

	func testOnlyADailyIdentifierOpensToday() {
		XCTAssertTrue(ReminderRouting.opensToday(identifier: "daily-2026-12-01"))
		XCTAssertFalse(ReminderRouting.opensToday(identifier: "other-1"))
		XCTAssertFalse(ReminderRouting.opensToday(identifier: "weekly-2026-12-01"))
		XCTAssertFalse(ReminderRouting.opensToday(identifier: "dailyish"))
		XCTAssertFalse(ReminderRouting.opensToday(identifier: "daily-"))
		XCTAssertFalse(ReminderRouting.opensToday(identifier: ""))
	}

	func testTappingADailyReminderShowsTodayAndAnyOtherNotificationIsIgnored() {
		let router = AppRouter()
		router.select(.genres)
		let delegate = ReminderNotificationDelegate(router: router)

		delegate.open(identifier: "other-1")
		XCTAssertEqual(router.selectedTab, .genres)
		delegate.open(identifier: "daily-2026-12-01")
		XCTAssertEqual(router.selectedTab, .today)
	}

	func testAReminderInTheForegroundPresentsNothing() {
		XCTAssertTrue(ReminderNotificationDelegate.foregroundPresentation.isEmpty)
	}
}
