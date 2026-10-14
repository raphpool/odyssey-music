import XCTest

@testable import Track1Core

/// Top bar (`173:18`): the rules that are not pixels, read from its Doc `173:20` and from the variants on
/// 2026-10-13. Moved from the app's `NavigationComponentsTests` (TRA-438) so that `swift test` runs them.
final class TopBarFormatTests: XCTestCase {
	private let paris = TimeZone(identifier: "Europe/Paris")!

	private func date(_ iso: String) throws -> Date {
		try XCTUnwrap(ISO8601DateFormatter().date(from: iso), iso)
	}

	private func crumbs(_ count: Int) -> [TopBarCrumb] {
		(0..<count).map { TopBarCrumb(index: $0, title: "c\($0)") }
	}

	// MARK: Top bar date

	func testDateIsTheDayInParisInFrench() throws {
		XCTAssertEqual(TopBarFormat.date(try date("2026-10-13T08:00:00Z"), timeZone: paris), "13 octobre")
	}

	func testDateFollowsTheTimeZoneAcrossMidnight() throws {
		// 23:30 UTC is 00:30 the next day in Paris (UTC+1 on 31 October 2026, after the clock change).
		let instant = try date("2026-10-31T23:30:00Z")
		XCTAssertEqual(TopBarFormat.date(instant, timeZone: paris), "1 novembre")
		XCTAssertEqual(TopBarFormat.date(instant, timeZone: TimeZone(identifier: "UTC")!), "31 octobre")
	}

	func testDateIsLongWithoutWeekday() throws {
		let text = TopBarFormat.date(try date("2026-02-04T12:00:00Z"), timeZone: paris)
		XCTAssertEqual(text, "4 février")
	}

	// MARK: Top bar breadcrumb

	func testFiveCrumbsFoldTheFirstTwoIntoAnEllipsis() {
		let path = crumbs(5)
		XCTAssertEqual(
			TopBarFormat.collapsed(path),
			[.ellipsis, .crumb(path[2]), .crumb(path[3]), .crumb(path[4])])
	}

	func testThreeCrumbsOrFewerAreUnchanged() {
		for count in 0...3 {
			let path = crumbs(count)
			XCTAssertEqual(TopBarFormat.collapsed(path), path.map(TopBarItem.crumb), "\(count) crumbs")
		}
	}

	func testFourCrumbsFoldOnlyTheFirstOne() {
		let path = crumbs(4)
		XCTAssertEqual(
			TopBarFormat.collapsed(path),
			[.ellipsis, .crumb(path[1]), .crumb(path[2]), .crumb(path[3])])
	}

	func testTheRootCrumbIsKeptWhileThePathIsShortAndFoldedWhenItIsLong() {
		let root = TopBarCrumb(index: -1, title: "Aujourd'hui")
		let short = [root, TopBarCrumb(index: 0, title: "Miles Davis")]
		XCTAssertEqual(TopBarFormat.collapsed(short), short.map(TopBarItem.crumb))
		let long = [root] + crumbs(3)
		XCTAssertEqual(TopBarFormat.collapsed(long).first, .ellipsis)
		XCTAssertFalse(TopBarFormat.collapsed(long).contains(.crumb(root)))
	}

	func testCrumbsAreKeptByPositionNotByIndexValue() {
		// The path is the source of truth, whatever the numbers its crumbs carry.
		let path = [7, 3, 9, 1].map { TopBarCrumb(index: $0, title: "n\($0)") }
		XCTAssertEqual(
			TopBarFormat.collapsed(path),
			[.ellipsis, .crumb(path[1]), .crumb(path[2]), .crumb(path[3])])
	}

	func testOnlyEarlierCrumbsCanBeSelected() {
		let path = crumbs(5)
		let items = TopBarFormat.collapsed(path)
		// c2 and c3 pop back; c4 is the node on screen and the ellipsis selects nothing.
		XCTAssertEqual(TopBarFormat.selectable(items), [path[2], path[3]])
		XCTAssertEqual(TopBarFormat.selectable(TopBarFormat.collapsed(crumbs(1))), [])
		XCTAssertEqual(TopBarFormat.selectable([]), [])
	}

	func testTheRootCrumbCanBeSelected() {
		let root = TopBarCrumb(index: -1, title: "Aujourd'hui")
		let path = [root, TopBarCrumb(index: 0, title: "Miles Davis")]
		XCTAssertEqual(TopBarFormat.selectable(TopBarFormat.collapsed(path)), [root])
	}

	func testSeparatorAndEllipsisAreTheFigmaGlyphs() {
		XCTAssertEqual(TopBarFormat.separator, "›")
		XCTAssertEqual(TopBarFormat.ellipsisText, "…")
	}
}
