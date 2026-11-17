import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Ambient glow (`173:42`): the rules that are not pixels, read from its Doc `173:44` and from the variants
/// on 2026-10-13. The Top bar text rules are tested in Track1Core (`TopBarFormatTests`).
final class NavigationComponentsTests: XCTestCase {
	/// Opaque RGBA components, so that two colors are compared by value and not by how they were built.
	private func components(_ color: Color) -> [Double] {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		return [red, green, blue, alpha].map { Double($0) }
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

	/// Figma `I282:838;173:15` (read 2026-10-23, TRA-660): the date is JetBrains Mono Bold 18 / 24, not the
	/// Roboto Condensed eyebrow of the previous build. The breadcrumb keeps its own roles.
	func testTopBarDateIsDrawnInMonoHeadline() {
		XCTAssertEqual(TopBar.dateRole, .monoHeadline)
		XCTAssertEqual(TopBar.dateRole.face, .jetBrainsMonoBold)
		XCTAssertEqual(TopBar.dateRole.size, 18)
		XCTAssertEqual(TopBar.dateRole.lineHeight, 24)
		XCTAssertEqual(TopBar.dateRole.textStyle, .callout)
		XCTAssertNotEqual(TopBar.dateRole, .eyebrow)
	}

	/// Figma `286:1669` (read 2026-10-24, TRA-699): the reason line sits 4 pt under the date, in the existing
	/// `.monoLabel` role (the Bold 12 / 25 of the frame is not reproduced), in the tertiary text color.
	func testTopBarReasonIsDrawnInMonoLabelTertiaryFourPointsUnderTheDate() {
		XCTAssertEqual(TopBar.reasonRole, .monoLabel)
		XCTAssertEqual(TopBar.reasonRole.face, .jetBrainsMonoRegular)
		XCTAssertEqual(TopBar.reasonRole.size, 12)
		XCTAssertEqual(TopBar.reasonRole.lineHeight, 16)
		XCTAssertEqual(TopBar.reasonRole.textStyle, .caption)
		XCTAssertEqual(TopBar.reasonColor, Track1Tokens.colorTextTertiary)
		XCTAssertEqual(TopBar.reasonSpacing, 4, accuracy: 0.0001)
	}

	// MARK: Bottom action bar, Figma `362:5074` (TRA-767)

	private func rgbaHex(_ color: Color) -> String {
		components(color).map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}

	/// `rgba(26,17,14,0)` at 22.821 % then `#1A110E` at 44.103 %: `background/elevated`, not `background/base`.
	func testBottomBarFadeIsTheTwoStopsOfTheNode() {
		let stops = BottomActionBar.fadeStops
		XCTAssertEqual(stops.count, 2)
		XCTAssertEqual(stops[0].location, 0.22821, accuracy: 0.000001)
		XCTAssertEqual(stops[1].location, 0.44103, accuracy: 0.000001)
		XCTAssertEqual(stops.map { rgbaHex($0.color) }, ["1a110e00", "1a110eff"])
		XCTAssertEqual(rgbaHex(Track1Tokens.colorBackgroundElevated), "1a110eff")
	}

	func testBottomBarFadeIsMeasuredOnTheHundredAndNinetyFivePointsOfTheNode() {
		XCTAssertEqual(BottomActionBar.fadeHeight, 195)
	}

	func testBottomBarMeasuresAreTheFigmaValues() {
		XCTAssertEqual(BottomActionBar.topInset, 24)
		XCTAssertEqual(BottomActionBar.bottomInset, 32)
		XCTAssertEqual(BottomActionBar.horizontalInset, 16)
		XCTAssertEqual(BottomActionBar.spacing, 8)
	}

	/// The 52 pt of "Continuer" belong to `Track1Button` (`.large`, tested with it), not to the bar.
	func testBottomBarCounterIsMonoCounterInTheSecondaryText() {
		XCTAssertEqual(BottomActionBar.counterRole, .monoCounter)
		XCTAssertEqual(BottomActionBar.counterRole.face, .jetBrainsMonoMedium)
		XCTAssertEqual(BottomActionBar.counterRole.size, 16)
		XCTAssertEqual(BottomActionBar.counterRole.lineHeight, 20)
		XCTAssertEqual(rgbaHex(BottomActionBar.counterColor), "c8b6a3ff", "text/secondary")
		XCTAssertEqual(rgbaHex(BottomActionBar.counterColor), rgbaHex(Track1Tokens.colorTextSecondary))
	}

	/// The counter is laid out, so read, before the button.
	@MainActor
	func testBottomBarReadsTheCounterBeforeTheButton() {
		XCTAssertEqual(BottomActionBar.contentOrder, [.counter, .button])
		let bar = BottomActionBar(title: "Continuer", isEnabled: true, counter: "Total : 1 genre") {}
		XCTAssertEqual(bar.parts, [.counter, .button])
	}

	/// Welcome passes no counter: only the button is left, with no gap in front of it.
	@MainActor
	func testBottomBarWithoutCounterDrawsTheButtonAlone() {
		let bar = BottomActionBar(title: "Commencer", isEnabled: true, counter: nil) {}
		XCTAssertEqual(bar.parts, [.button])
	}

	func testTopBarClearanceAddsOnlyWhatTheLayoutLacksAndNeverGoesNegative() {
		XCTAssertEqual(TopBarFormat.clearance(windowInset: 59, layoutInset: 0), 59, accuracy: 0.0001)
		XCTAssertEqual(TopBarFormat.clearance(windowInset: 59, layoutInset: 20), 39, accuracy: 0.0001)
		XCTAssertEqual(TopBarFormat.clearance(windowInset: 59, layoutInset: 59), 0, accuracy: 0.0001)
		XCTAssertEqual(TopBarFormat.clearance(windowInset: 20, layoutInset: 59), 0, accuracy: 0.0001)
	}
}
