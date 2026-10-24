import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// The numbers are spelled out again from the Figma frame `282:889` (read 2026-10-23, plan annex A.1): a
/// metric or a color changed in `Track1TabBarMetrics` / `Track1TabBarStyle` alone fails here.
@MainActor
final class Track1TabBarTests: XCTestCase {
	private typealias Item = Track1TabBar.Item

	private let today = Item(id: "today", icon: .tabToday, label: "Today", identifier: "tab-today")
	private let genres = Item(id: "genres", icon: .tabGenres, label: "Genres", identifier: "tab-genres")
	private let search = Item(id: "search", icon: .tabSearch, label: "Search", identifier: "tab-search")

	// MARK: Metrics and style

	func testMetricsFollowFigma() {
		XCTAssertEqual(Track1TabBarMetrics.tabWidth, 96)
		XCTAssertEqual(Track1TabBarMetrics.tabHeight, 54)
		XCTAssertEqual(Track1TabBarMetrics.pillPadding, 4)
		XCTAssertEqual(Track1TabBarMetrics.searchDiameter, 62)
		XCTAssertEqual(Track1TabBarMetrics.topPadding, 12)
		XCTAssertEqual(Track1TabBarMetrics.horizontalInset, 25)
		XCTAssertEqual(Track1TabBarMetrics.iconSize, 20)
		XCTAssertEqual(Track1TabBarMetrics.borderWidth, 1)
		XCTAssertEqual(Track1TabBarMetrics.bottomPaddingWithoutHomeIndicator, 12)
	}

	func testColorsAreTheGlassTokensAtTheirFigmaValues() {
		XCTAssertEqual(rgbaHex(Track1TabBarStyle.pillFill), rgbaHex(Track1Tokens.colorGlassSurface))
		XCTAssertEqual(rgbaHex(Track1TabBarStyle.pillBorder), rgbaHex(Track1Tokens.colorGlassBorder))
		XCTAssertEqual(rgbaHex(Track1TabBarStyle.selectedFill), rgbaHex(Track1Tokens.colorGlassSelected))
		// rgba(9,10,14,0.68), then white at 0.26 for the border and for the selected tab.
		XCTAssertEqual(rgbaHex(Track1TabBarStyle.pillFill), "090a0ead")
		XCTAssertEqual(rgbaHex(Track1TabBarStyle.pillBorder), "ffffff42")
		XCTAssertEqual(rgbaHex(Track1TabBarStyle.selectedFill), "ffffff42")
	}

	func testTonesAreActionSecondaryAndPrimary() {
		XCTAssertEqual(Track1TabBarStyle.activeTone, .action)
		XCTAssertEqual(Track1TabBarStyle.inactiveTone, .secondary)
		XCTAssertEqual(Track1TabBarStyle.searchTone, .primary)
		XCTAssertEqual(rgbaHex(Track1TabBarStyle.activeTone.color), "f0642dff")
		XCTAssertEqual(rgbaHex(Track1TabBarStyle.inactiveTone.color), "c8b6a3ff")
		XCTAssertEqual(rgbaHex(Track1TabBarStyle.searchTone.color), "f6e9d8ff")
	}

	func testIdentifierIsTabBar() {
		XCTAssertEqual(Track1TabBarStyle.identifier, "tab-bar")
	}

	func testFadeGoesFromTransparentToOpaqueBackground() {
		let stops = Track1TabBarStyle.fadeStops()
		XCTAssertEqual(stops.count, 2)
		XCTAssertEqual(stops.map(\.location), [0, 1])
		XCTAssertEqual(stops.map { rgbaHex($0.color) }, ["120c0a00", "120c0aff"])
		XCTAssertEqual(rgbaHex(stops[1].color), rgbaHex(Track1Tokens.colorBackgroundBase))
	}

	func testBottomPaddingIsZeroWithAHomeIndicatorAndTwelveWithout() {
		XCTAssertEqual(Track1TabBarMetrics.bottomPadding(safeAreaBottom: 34), 0)
		XCTAssertEqual(Track1TabBarMetrics.bottomPadding(safeAreaBottom: 0), 12)
	}

	func testEveryButtonHasATouchTargetOfAtLeast44Points() {
		XCTAssertGreaterThanOrEqual(Track1TabBarMetrics.tabWidth, 44)
		XCTAssertGreaterThanOrEqual(Track1TabBarMetrics.tabHeight, 44)
		XCTAssertGreaterThanOrEqual(Track1TabBarMetrics.searchDiameter, 44)
	}

	// MARK: Selection

	func testOnlyTheSelectedItemIsSelectedAndToned() {
		XCTAssertTrue(Track1TabBar.isSelected(today, selected: "today"))
		XCTAssertFalse(Track1TabBar.isSelected(genres, selected: "today"))
		XCTAssertEqual(Track1TabBar.tone(for: today, selected: "today"), .action)
		XCTAssertEqual(Track1TabBar.tone(for: genres, selected: "today"), .secondary)
		XCTAssertEqual(Track1TabBar.tone(for: today, selected: "genres"), .secondary)
		XCTAssertEqual(Track1TabBar.tone(for: genres, selected: "genres"), .action)
	}

	func testSearchIsNeverSelectedEvenWhenItsIdIsTheSelectedOne() {
		XCTAssertTrue(Track1TabBar.isSelected(search, selected: "search"))
		XCTAssertFalse(Track1TabBar.isSelected(search, selected: "search", isSearch: true))
		XCTAssertFalse(Track1TabBar.isSelected(search, selected: "today", isSearch: true))
	}

	func testOnlyTheSelectedTabCarriesTheSelectedTrait() {
		XCTAssertEqual(Track1TabBar.accessibilityTraits(for: genres, selected: "genres"), .isSelected)
		XCTAssertEqual(Track1TabBar.accessibilityTraits(for: today, selected: "genres"), [])
	}

	func testSearchNeverCarriesTheSelectedTrait() {
		XCTAssertEqual(Track1TabBar.accessibilityTraits(for: search, selected: "search", isSearch: true), [])
		XCTAssertEqual(Track1TabBar.accessibilityTraits(for: search, selected: "today", isSearch: true), [])
	}

	// MARK: Taps

	func testATapOnATabSendsItsId() {
		XCTAssertEqual(Track1TabBar.action(for: today, search: search), .select("today"))
		XCTAssertEqual(Track1TabBar.action(for: genres, search: search), .select("genres"))
	}

	func testATapOnTheRoundButtonIsASearchAndSelectsNothing() {
		XCTAssertEqual(Track1TabBar.action(for: search, search: search), .search)
	}

	// MARK: Rendered bar

	func testHeightIsTopPaddingPlusTheRoundButtonPlusTheBottomPadding() {
		let host = UIHostingController(
			rootView: Track1TabBar(
				items: [today, genres], selected: "today", search: search, onSelect: { _ in }, onSearch: {}))
		let size = host.sizeThatFits(in: CGSize(width: 393, height: 1000))
		// No safe area in a bare hosting controller: 12 + 62 + 12.
		XCTAssertEqual(size.height, 12 + 62 + 12, accuracy: 0.5)
	}

	/// TRA-671: a screen reserves the bar above the window's safe area, 12 + 62 + the bottom padding.
	func testTheReservedHeightIsTheBarAboveTheSafeArea() {
		XCTAssertEqual(Track1TabBarMetrics.reservedHeight(safeAreaBottom: 34), 74)
		XCTAssertEqual(Track1TabBarMetrics.reservedHeight(safeAreaBottom: 0), 86)
	}

	/// TRA-671: the screen that mounts the bar hands it the window's safe area, because inside a
	/// `safeAreaInset` the bar's own reading can be 0. 0 gives the 12 pt of a screen without a home indicator,
	/// anything above it gives none.
	func testTheInjectedSafeAreaDecidesTheRoomUnderThePill() {
		func height(safeAreaBottom: CGFloat) -> CGFloat {
			let bar = Track1TabBar(
				items: [today, genres], selected: "today", search: search, safeAreaBottom: safeAreaBottom,
				onSelect: { _ in }, onSearch: {})
			return UIHostingController(rootView: bar)
				.sizeThatFits(in: CGSize(width: 393, height: 852)).height
		}

		let withoutIndicator = height(safeAreaBottom: 0)
		let withIndicator = height(safeAreaBottom: 34)

		XCTAssertEqual(withoutIndicator - withIndicator, 12, accuracy: 0.5)
		XCTAssertEqual(
			withIndicator, Track1TabBarMetrics.topPadding + Track1TabBarMetrics.searchDiameter, accuracy: 0.5)
	}

	// MARK: Helpers

	/// `rrggbbaa`, to compare with the Figma hex and to read a failure.
	private func rgbaHex(_ color: Color) -> String {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "no-rgb" }
		return [red, green, blue, alpha].map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}
}
