import XCTest

@testable import Track1Core

final class CoverTintTests: XCTestCase {
	/// One channel of an 8-bit colour, the unit the Figma references are expressed in.
	private let channel = 1.0 / 255.0

	// MARK: - Reference palette (plan annex A.2)

	func testCosmogrammaBandsGiveTheFigmaReferenceStopsAndShadow() throws {
		let bands = [Self.hsb(164, 0.13, 0.60), Self.hsb(48, 0.15, 0.50), Self.hsb(30, 0.32, 0.40)]

		let tint = try XCTUnwrap(CoverTintTone.tint(bands: bands))

		XCTAssertEqual(tint.stops.count, 3)
		assertColor(tint.stops[0], hex: 0x4A5552, tolerance: 2 * channel)
		assertColor(tint.stops[1], hex: 0x44423A, tolerance: 2 * channel)
		assertColor(tint.stops[2], hex: 0x322A22, tolerance: 2 * channel)
		assertColor(tint.shadow, hex: 0x6A877E, tolerance: 2 * channel)
	}

	// MARK: - Saturation cap

	func testSaturatedRedIsCappedAtTheSaturationMaxAtTheFirstBrightness() throws {
		let red = LinearRGB(red: 1, green: 0, blue: 0)
		let bands = [red, Self.hsb(48, 0.15, 0.50), Self.hsb(30, 0.32, 0.40)]

		let tint = try XCTUnwrap(CoverTintTone.tint(bands: bands))
		let first = Self.readHSB(tint.stops[0])

		XCTAssertEqual(first.saturation, 0.35, accuracy: 0.01)
		XCTAssertEqual(first.brightness, 0.33, accuracy: 0.01)
		XCTAssertEqual(first.hue, 0, accuracy: 1)
	}

	func testShadowSaturationIsAlsoCapped() throws {
		let red = LinearRGB(red: 1, green: 0, blue: 0)

		let tint = try XCTUnwrap(CoverTintTone.tint(bands: [red, red, red]))
		let shadow = Self.readHSB(tint.shadow)

		XCTAssertEqual(shadow.saturation, CoverTintTone.saturationMax, accuracy: 0.01)
		XCTAssertEqual(shadow.brightness, CoverTintTone.shadowBrightness, accuracy: 0.01)
	}

	func testEachStopKeepsTheHueOfItsOwnBand() throws {
		// Hues on both sides of the wrap, so a hue conversion that drifts near 360 would show here.
		let bands = [Self.hsb(300, 0.60, 0.70), Self.hsb(210, 0.50, 0.60), Self.hsb(359, 0.40, 0.50)]

		let tint = try XCTUnwrap(CoverTintTone.tint(bands: bands))

		XCTAssertEqual(Self.readHSB(tint.stops[0]).hue, 300, accuracy: 1)
		XCTAssertEqual(Self.readHSB(tint.stops[1]).hue, 210, accuracy: 1)
		XCTAssertEqual(Self.readHSB(tint.stops[2]).hue, 359, accuracy: 1)
		XCTAssertEqual(Self.readHSB(tint.shadow).hue, 300, accuracy: 1)
	}

	// MARK: - Grey bands

	func testGreyBandsGiveGreyStopsOnTheFixedBrightnessScale() throws {
		let grey = LinearRGB(red: 0.5, green: 0.5, blue: 0.5)

		let tint = try XCTUnwrap(CoverTintTone.tint(bands: [grey, grey, grey]))

		for (stop, brightness) in zip(tint.stops, CoverTintTone.stopBrightness) {
			XCTAssertEqual(stop.red, stop.green, accuracy: channel)
			XCTAssertEqual(stop.green, stop.blue, accuracy: channel)
			XCTAssertEqual(stop.red, brightness, accuracy: channel)
		}
		XCTAssertEqual(tint.stops[0].red, 0.33, accuracy: channel)
		XCTAssertEqual(tint.stops[1].red, 0.27, accuracy: channel)
		XCTAssertEqual(tint.stops[2].red, 0.20, accuracy: channel)
		XCTAssertEqual(tint.shadow.red, tint.shadow.green, accuracy: channel)
		XCTAssertEqual(tint.shadow.green, tint.shadow.blue, accuracy: channel)
		XCTAssertEqual(tint.shadow.red, 0.53, accuracy: channel)
	}

	// MARK: - Player scale (TRA-832)

	func testPlayerScaleGivesGreyStopsOnItsOwnBrightnessScale() throws {
		let grey = LinearRGB(red: 0.5, green: 0.5, blue: 0.5)

		let tint = try XCTUnwrap(CoverTintTone.tint(bands: [grey, grey, grey], scale: .player))

		for (stop, brightness) in zip(tint.stops, [0.46, 0.38, 0.30]) {
			XCTAssertEqual(stop.red, stop.green, accuracy: channel)
			XCTAssertEqual(stop.green, stop.blue, accuracy: channel)
			XCTAssertEqual(stop.red, brightness, accuracy: channel)
		}
	}

	func testPlayerScaleCapsASaturatedRedAtItsOwnSaturationMax() throws {
		let red = LinearRGB(red: 1, green: 0, blue: 0)

		let tint = try XCTUnwrap(CoverTintTone.tint(bands: [red, red, red], scale: .player))
		let first = Self.readHSB(tint.stops[0])

		XCTAssertEqual(first.saturation, 0.60, accuracy: 0.01)
		XCTAssertEqual(first.brightness, 0.46, accuracy: 0.01)
		XCTAssertEqual(first.hue, 0, accuracy: 1)
		XCTAssertEqual(Self.readHSB(tint.shadow).saturation, 0.60, accuracy: 0.01)
	}

	func testPlayerScaleKeepsTheSaturationOfABandBelowItsMax() throws {
		// 0.50 is above the page cap (0.35) and below the player cap (0.60): only the player keeps it whole.
		let bands = [Self.hsb(210, 0.50, 0.70), Self.hsb(210, 0.50, 0.60), Self.hsb(210, 0.50, 0.50)]

		let player = try XCTUnwrap(CoverTintTone.tint(bands: bands, scale: .player))
		let page = try XCTUnwrap(CoverTintTone.tint(bands: bands, scale: .page))

		XCTAssertEqual(Self.readHSB(player.stops[0]).saturation, 0.50, accuracy: 0.01)
		XCTAssertEqual(Self.readHSB(page.stops[0]).saturation, 0.35, accuracy: 0.01)
	}

	func testPlayerScaleKeepsTheHueOfEachBand() throws {
		let bands = [Self.hsb(300, 0.60, 0.70), Self.hsb(210, 0.50, 0.60), Self.hsb(359, 0.40, 0.50)]

		let tint = try XCTUnwrap(CoverTintTone.tint(bands: bands, scale: .player))

		XCTAssertEqual(Self.readHSB(tint.stops[0]).hue, 300, accuracy: 1)
		XCTAssertEqual(Self.readHSB(tint.stops[1]).hue, 210, accuracy: 1)
		XCTAssertEqual(Self.readHSB(tint.stops[2]).hue, 359, accuracy: 1)
		XCTAssertEqual(Self.readHSB(tint.shadow).hue, 300, accuracy: 1)
	}

	func testPageScaleIsTheDefaultAndMatchesTheLegacyConstants() throws {
		let bands = [Self.hsb(164, 0.13, 0.60), Self.hsb(48, 0.15, 0.50), Self.hsb(30, 0.32, 0.40)]

		XCTAssertEqual(CoverTintTone.tint(bands: bands), CoverTintTone.tint(bands: bands, scale: .page))
		XCTAssertEqual(CoverTintTone.Scale.page.stopBrightness, [0.33, 0.27, 0.20])
		XCTAssertEqual(CoverTintTone.Scale.page.saturationMax, 0.35)
		XCTAssertEqual(CoverTintTone.stopBrightness, CoverTintTone.Scale.page.stopBrightness)
		XCTAssertEqual(CoverTintTone.saturationMax, CoverTintTone.Scale.page.saturationMax)
	}

	func testEveryScaleHasThreeStopsWhoseBrightnessStrictlyDecreasesDownTheBackground() throws {
		let grey = LinearRGB(red: 0.5, green: 0.5, blue: 0.5)

		for scale in [CoverTintTone.Scale.page, .player] {
			XCTAssertEqual(scale.stopBrightness.count, 3)
			let tint = try XCTUnwrap(CoverTintTone.tint(bands: [grey, grey, grey], scale: scale))
			let brightness = tint.stops.map { max($0.red, $0.green, $0.blue) }
			XCTAssertEqual(brightness.count, 3)
			XCTAssertLessThan(brightness[1], brightness[0])
			XCTAssertLessThan(brightness[2], brightness[1])
		}
	}

	func testPlayerScaleIsNilUnlessThereAreExactlyThreeBands() {
		let band = LinearRGB(red: 0.2, green: 0.4, blue: 0.6)

		XCTAssertNil(CoverTintTone.tint(bands: [band, band], scale: .player))
		XCTAssertNotNil(CoverTintTone.tint(bands: [band, band, band], scale: .player))
		XCTAssertNil(CoverTintTone.tint(bands: [band, band, band, band], scale: .player))
	}

	// MARK: - Band count

	func testNilUnlessThereAreExactlyThreeBands() {
		let band = LinearRGB(red: 0.2, green: 0.4, blue: 0.6)

		XCTAssertNil(CoverTintTone.tint(bands: []))
		XCTAssertNil(CoverTintTone.tint(bands: [band]))
		XCTAssertNil(CoverTintTone.tint(bands: [band, band]))
		XCTAssertNotNil(CoverTintTone.tint(bands: [band, band, band]))
		XCTAssertNil(CoverTintTone.tint(bands: [band, band, band, band]))
	}

	// MARK: - Determinism and constants

	func testSameBandsGiveEqualTints() {
		let bands = [Self.hsb(164, 0.13, 0.60), Self.hsb(48, 0.15, 0.50), Self.hsb(30, 0.32, 0.40)]

		XCTAssertEqual(CoverTintTone.tint(bands: bands), CoverTintTone.tint(bands: bands))
	}

	func testTheScaleHasOneBrightnessPerStopPositionAndEndsBeforeTheEndpoint() {
		XCTAssertEqual(CoverTintTone.stopPositions.count, 3)
		XCTAssertEqual(CoverTintTone.stopBrightness.count, CoverTintTone.stopPositions.count)
		XCTAssertEqual(CoverTintTone.stopPositions, CoverTintTone.stopPositions.sorted())
		XCTAssertLessThan(CoverTintTone.stopPositions.last ?? 1, CoverTintTone.endpointPosition)
	}

	// MARK: - Helpers

	private func assertColor(
		_ color: LinearRGB, hex: Int, tolerance: Double, file: StaticString = #filePath, line: UInt = #line
	) {
		let expected = [Double((hex >> 16) & 0xFF), Double((hex >> 8) & 0xFF), Double(hex & 0xFF)].map { $0 / 255 }
		let actual = [color.red, color.green, color.blue]
		for (got, want) in zip(actual, expected) {
			XCTAssertEqual(got, want, accuracy: tolerance + 1e-9, file: file, line: line)
		}
	}

	/// Builds an sRGB colour from HSB (hue in degrees), independently of the code under test.
	private static func hsb(_ hue: Double, _ saturation: Double, _ brightness: Double) -> LinearRGB {
		let chroma = brightness * saturation
		let sector = hue / 60
		let second = chroma * (1 - abs(sector.truncatingRemainder(dividingBy: 2) - 1))
		let floor = brightness - chroma
		let (r, g, b): (Double, Double, Double)
		switch Int(sector) % 6 {
		case 0: (r, g, b) = (chroma, second, 0)
		case 1: (r, g, b) = (second, chroma, 0)
		case 2: (r, g, b) = (0, chroma, second)
		case 3: (r, g, b) = (0, second, chroma)
		case 4: (r, g, b) = (second, 0, chroma)
		default: (r, g, b) = (chroma, 0, second)
		}
		return LinearRGB(red: r + floor, green: g + floor, blue: b + floor)
	}

	/// Reads HSB back from a colour (hue in degrees), independently of the code under test.
	private static func readHSB(_ color: LinearRGB) -> (hue: Double, saturation: Double, brightness: Double) {
		let top = max(color.red, color.green, color.blue)
		let bottom = min(color.red, color.green, color.blue)
		let delta = top - bottom
		var hue = 0.0
		if delta > 0 {
			if top == color.red {
				hue = 60 * ((color.green - color.blue) / delta).truncatingRemainder(dividingBy: 6)
			} else if top == color.green {
				hue = 60 * ((color.blue - color.red) / delta + 2)
			} else {
				hue = 60 * ((color.red - color.green) / delta + 4)
			}
		}
		if hue < 0 { hue += 360 }
		return (hue, top == 0 ? 0 : delta / top, top)
	}
}
