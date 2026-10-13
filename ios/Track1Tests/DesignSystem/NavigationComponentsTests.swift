import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// Ambient glow (`173:42`) and Top bar (`173:18`): the rules that are not pixels, read from their Docs
/// `173:44` and `173:20` and from the variants on 2026-10-13.
final class NavigationComponentsTests: XCTestCase {
	private let paris = TimeZone(identifier: "Europe/Paris")!

	private func date(_ iso: String) throws -> Date {
		try XCTUnwrap(ISO8601DateFormatter().date(from: iso), iso)
	}

	private func crumbs(_ count: Int) -> [TopBarCrumb] {
		(0..<count).map { TopBarCrumb(index: $0, title: "c\($0)") }
	}

	/// Opaque RGBA components, so that two colors are compared by value and not by how they were built.
	private func components(_ color: Color) -> [Double] {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		return [red, green, blue, alpha].map { Double($0) }
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

	// MARK: Ambient glow palette

	func testEveryToneDrawsThreeGlows() {
		for tone in [AmbientGlow.Tone.ember, .silver, .tinted(.purple)] {
			XCTAssertEqual(AmbientGlowPalette.stops(for: tone).count, 3, "\(tone)")
		}
	}

	func testEmberAndSilverDiffer() {
		XCTAssertNotEqual(
			AmbientGlowPalette.stops(for: .ember).map(components),
			AmbientGlowPalette.stops(for: .silver).map(components))
	}

	func testEmberAndSilverAreTheFigmaArtDirectionValues() {
		// Gradient stops read from the SVG of the variants `173:30` and `173:36`.
		let ember = AmbientGlowPalette.stops(for: .ember).map(components)
		XCTAssertEqual(ember[0][3], 0.55, accuracy: 0.001)
		XCTAssertEqual(ember[1][3], 0.45, accuracy: 0.001)
		XCTAssertEqual(ember[2][3], 0.38, accuracy: 0.001)
		XCTAssertEqual(ember[0][0], Double(0xE7) / 255, accuracy: 0.001)
		let silver = AmbientGlowPalette.stops(for: .silver).map(components)
		XCTAssertEqual(silver[0][3], 0.50, accuracy: 0.001)
		XCTAssertEqual(silver[1][2], Double(0xA8) / 255, accuracy: 0.001)
	}

	func testTintedStopsAreDeterministic() {
		let tint = Color(.sRGB, red: 0.2, green: 0.5, blue: 0.8, opacity: 1)
		XCTAssertEqual(
			AmbientGlowPalette.stops(for: .tinted(tint)).map(components),
			AmbientGlowPalette.stops(for: .tinted(tint)).map(components))
		XCTAssertEqual(AmbientGlow.Tone.tinted(tint), .tinted(tint))
	}

	func testTintedStopsFollowTheTintAndKeepItsHue() {
		let blue = Color(.sRGB, red: 0.2, green: 0.5, blue: 0.8, opacity: 1)
		let green = Color(.sRGB, red: 0.2, green: 0.8, blue: 0.4, opacity: 1)
		let blueStops = AmbientGlowPalette.stops(for: .tinted(blue)).map(components)
		XCTAssertNotEqual(blueStops, AmbientGlowPalette.stops(for: .tinted(green)).map(components))
		for stop in blueStops {
			// Blue stays the dominant channel, red the weakest.
			XCTAssertGreaterThan(stop[2], stop[1])
			XCTAssertGreaterThan(stop[1], stop[0])
		}
	}

	func testTintedStopsUseTheThreeBrightnessAndOpacityPairs() {
		XCTAssertEqual(AmbientGlowPalette.tintedLevels.count, 3)
		let stops = AmbientGlowPalette.stops(for: .tinted(Color(.sRGB, red: 1, green: 0, blue: 0, opacity: 1)))
			.map(components)
		for (stop, level) in zip(stops, AmbientGlowPalette.tintedLevels) {
			XCTAssertEqual(stop[3], level.opacity, accuracy: 0.001)
			// A fully saturated hue: the brightest channel is the brightness.
			XCTAssertEqual(stop[0], level.brightness, accuracy: 0.001)
		}
	}

	func testAColorWithoutHueStillGivesAGlow() {
		let stops = AmbientGlowPalette.stops(for: .tinted(.black)).map(components)
		XCTAssertEqual(stops.count, 3)
		// The alpha goes through a Float color, so it is compared with a tolerance, not exactly.
		for (stop, level) in zip(stops, AmbientGlowPalette.tintedLevels) {
			XCTAssertEqual(stop[3], level.opacity, accuracy: 0.001)
		}
	}

	// MARK: Grain

	func testGrainIsSeededAndCoversTheWholeTile() {
		let side = AmbientGlowGrain.tileSide
		let pixels = AmbientGlowGrain.pixels()
		XCTAssertEqual(pixels.count, side * side * 4)
		XCTAssertEqual(pixels, AmbientGlowGrain.pixels())
		let opaque = stride(from: 3, to: pixels.count, by: 4).filter { pixels[$0] == 255 }.count
		// A noise, not a flat tile: about half of the pixels are black.
		XCTAssertGreaterThan(opaque, side * side / 4)
		XCTAssertLessThan(opaque, side * side * 3 / 4)
		XCTAssertNotEqual(pixels, AmbientGlowGrain.pixels(seed: 1))
	}

	func testGrainTextureIsBuiltOnceAndShared() {
		let first = AmbientGlowGrain.image
		XCTAssertTrue(first === AmbientGlowGrain.image)
		XCTAssertEqual(first.width, AmbientGlowGrain.tileSide)
		XCTAssertEqual(first.height, AmbientGlowGrain.tileSide)
	}

	func testGrainIsTenPercent() {
		XCTAssertEqual(AmbientGlow.grainOpacity, 0.1, accuracy: 0.0001)
	}
}
