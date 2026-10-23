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

	// MARK: Rendered bar

	func testHeightIsTopPaddingPlusTheRoundButtonPlusTheBottomPadding() {
		let host = UIHostingController(rootView: bar(selected: "today"))
		let size = host.sizeThatFits(in: CGSize(width: 393, height: 1000))
		// No safe area in a bare hosting controller: 12 + 62 + 12.
		XCTAssertEqual(size.height, 12 + 62 + 12, accuracy: 0.5)
	}

	func testOnlyTheSelectedTabCarriesTheSelectedTrait() throws {
		let window = show(bar(selected: "genres"))
		let elements = accessibleElements(in: window)
		let identified = Dictionary(
			elements.compactMap { element in identifier(of: element).map { ($0, element) } },
			uniquingKeysWith: { first, _ in first })

		XCTAssertNotNil(identified[Track1TabBarStyle.identifier], "container")
		for item in [today, genres, search] {
			XCTAssertNotNil(identified[item.identifier], "button \(item.identifier)")
		}
		XCTAssertFalse(try XCTUnwrap(identified[today.identifier]).accessibilityTraits.contains(.selected))
		XCTAssertTrue(try XCTUnwrap(identified[genres.identifier]).accessibilityTraits.contains(.selected))
		XCTAssertFalse(try XCTUnwrap(identified[search.identifier]).accessibilityTraits.contains(.selected))
		XCTAssertEqual(try XCTUnwrap(identified[genres.identifier]).accessibilityLabel, "Genres")
	}

	func testSearchNeverCarriesTheSelectedTraitEvenWhenItsIdIsSelected() throws {
		let window = show(bar(selected: "search"))
		let button = try XCTUnwrap(accessibleElements(in: window).first { identifier(of: $0) == search.identifier })
		XCTAssertFalse(button.accessibilityTraits.contains(.selected))
	}

	func testActivatingATabSendsItsIdAndActivatingSearchCallsOnSearch() throws {
		var selectedIds: [String] = []
		var searches = 0
		let window = show(
			Track1TabBar(
				items: [today, genres], selected: "today", search: search,
				onSelect: { selectedIds.append($0) }, onSearch: { searches += 1 }))
		let elements = accessibleElements(in: window)
		func button(_ item: Item) throws -> NSObject {
			try XCTUnwrap(elements.first { identifier(of: $0) == item.identifier }, item.identifier)
		}

		XCTAssertTrue(try button(genres).accessibilityActivate())
		XCTAssertEqual(selectedIds, ["genres"])
		XCTAssertEqual(searches, 0)

		XCTAssertTrue(try button(search).accessibilityActivate())
		XCTAssertEqual(searches, 1)
		XCTAssertEqual(selectedIds, ["genres"])
	}

	// MARK: Helpers

	private func bar(selected: String) -> Track1TabBar {
		Track1TabBar(
			items: [today, genres], selected: selected, search: search, onSelect: { _ in }, onSearch: {})
	}

	/// The bar in a key window: SwiftUI builds its accessibility tree only for a view that is laid out.
	private func show(_ view: some View) -> UIWindow {
		let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
		window.rootViewController = UIHostingController(rootView: view)
		window.makeKeyAndVisible()
		window.layoutIfNeeded()
		RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
		return window
	}

	/// Every accessibility element under `root`: containers are walked through `accessibilityElements`, then
	/// `accessibilityElement(at:)`, then the subviews, whichever the object provides.
	private func accessibleElements(in root: NSObject) -> [NSObject] {
		var found: [NSObject] = []
		var visited = Set<ObjectIdentifier>()
		func walk(_ object: NSObject) {
			guard visited.insert(ObjectIdentifier(object)).inserted else { return }
			found.append(object)
			if let children = object.accessibilityElements as? [NSObject] {
				children.forEach(walk)
			}
			let count = object.accessibilityElementCount()
			if count != NSNotFound, count > 0 {
				for index in 0..<count {
					if let child = object.accessibilityElement(at: index) as? NSObject { walk(child) }
				}
			}
			if let view = object as? UIView {
				view.subviews.forEach(walk)
			}
		}
		walk(root)
		return found
	}

	/// Accessibility nodes built by SwiftUI are not `UIAccessibilityIdentification`: read the property by name.
	private func identifier(of object: NSObject) -> String? {
		guard object.responds(to: NSSelectorFromString("accessibilityIdentifier")) else { return nil }
		let value = object.value(forKey: "accessibilityIdentifier") as? String
		return value?.isEmpty == false ? value : nil
	}

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
