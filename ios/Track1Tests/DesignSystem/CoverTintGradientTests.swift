import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The cover gradient of the node page and card (TRA-665), Figma `282:837` and `285:1034`.
final class CoverTintGradientTests: XCTestCase {
	private let tint = CoverTint(
		stops: [
			LinearRGB(red: 0.29, green: 0.33, blue: 0.32),
			LinearRGB(red: 0.27, green: 0.26, blue: 0.23),
			LinearRGB(red: 0.20, green: 0.16, blue: 0.13),
		],
		shadow: LinearRGB(red: 0.5, green: 0.4, blue: 0.4))

	func testTheGradientHasFiveStopsAtTheSpecPositions() {
		let stops = CoverTintGradient.stops(tint: tint, endpoint: Track1Tokens.colorBackgroundBase)

		XCTAssertEqual(
			stops.map(\.location),
			(CoverTintTone.stopPositions + [CoverTintTone.endpointPosition, 1]).map { CGFloat($0) })
		XCTAssertEqual(stops.map(\.location), [0, 0.13, 0.27, 0.50, 1.0])
	}

	func testTheFirstThreeStopsAreTheTintAndTheLastTwoTheEndpoint() {
		let endpoint = Track1Tokens.colorBackgroundElevated
		let stops = CoverTintGradient.stops(tint: tint, endpoint: endpoint)

		for index in 0..<3 {
			XCTAssertEqual(stops[index].color, Color(tint.stops[index]), "stop \(index)")
		}
		XCTAssertEqual(stops[3].color, endpoint)
		XCTAssertEqual(stops[4].color, endpoint)
	}

	/// Spec: opaque colors, never a fade to transparency.
	func testTheStopsAreOpaque() {
		let stops = CoverTintGradient.stops(tint: tint, endpoint: Track1Tokens.colorBackgroundBase)

		for stop in stops {
			var alpha: CGFloat = 0
			XCTAssertTrue(UIColor(stop.color).getRed(nil, green: nil, blue: nil, alpha: &alpha))
			XCTAssertEqual(alpha, 1)
		}
	}

	func testALinearRGBSurvivesTheRoundTripThroughColor() throws {
		let source = LinearRGB(red: 0.29, green: 0.33, blue: 0.32)
		let back = try XCTUnwrap(LinearRGB(Color(source)))

		XCTAssertEqual(back.red, source.red, accuracy: 1.0 / 255)
		XCTAssertEqual(back.green, source.green, accuracy: 1.0 / 255)
		XCTAssertEqual(back.blue, source.blue, accuracy: 1.0 / 255)
	}

	func testATokenColorConvertsToItsHexComponents() throws {
		// background.base is 0x120C0A.
		let base = try XCTUnwrap(LinearRGB(Track1Tokens.colorBackgroundBase))

		XCTAssertEqual(base.red, 0x12 / 255.0, accuracy: 1.0 / 255)
		XCTAssertEqual(base.green, 0x0C / 255.0, accuracy: 1.0 / 255)
		XCTAssertEqual(base.blue, 0x0A / 255.0, accuracy: 1.0 / 255)
	}
}
