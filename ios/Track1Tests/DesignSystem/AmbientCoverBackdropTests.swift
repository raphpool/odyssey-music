import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The ambient cover backdrop (TRA-829): the rules of the brief of 2026-11-25 that are not pixels. The drift
/// math is tested in `Track1Core` (`AmbientDriftTests`); here, the values the home reads and the proof that
/// the text stays readable. The effect itself is judged on a device (home ticket).
final class AmbientCoverBackdropTests: XCTestCase {
	private typealias Metrics = AmbientCoverBackdropMetrics

	private struct Components {
		let color: RGB
		let alpha: Double
	}

	/// RGB and alpha of a SwiftUI color, so that colors are compared by value.
	private func components(_ color: Color) -> Components {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		let value = RGB(red: Double(red), green: Double(green), blue: Double(blue))
		return Components(color: value, alpha: Double(alpha))
	}

	private func rgb(_ color: Color) -> RGB { components(color).color }

	// MARK: - Constants

	func testTheZoomIs1Point7() { XCTAssertEqual(Metrics.zoom, 1.7) }

	func testTheBlurRadiusIs64() { XCTAssertEqual(Metrics.blurRadius, 64) }

	func testTheBackdropDrawsFifteenImagesASecond() {
		XCTAssertEqual(Metrics.frameInterval, 1.0 / 15, accuracy: 1e-12)
	}

	func testTheVeilOpacities() {
		XCTAssertEqual(Metrics.veilTopOpacity, 0.65)
		XCTAssertEqual(Metrics.veilBottomOpacity, 0.80)
	}

	func testTheVeilIsAtItsMaximumFrom62PercentOfTheHeight() { XCTAssertEqual(Metrics.veilTextStop, 0.62) }

	func testTheDesignSizeIsTheFigmaFrameOfTheHome() {
		XCTAssertEqual(Metrics.designSize, CGSize(width: 393, height: 844))
	}

	// MARK: - Margin invariant

	// The blur is applied before the zoom, so its edge band is `blurRadius * zoom` wide on screen.
	func testTheZoomOverflowCoversTheDriftAndTheZoomedBlurHorizontally() {
		let zoomedBlur = Metrics.blurRadius * Metrics.zoom
		XCTAssertGreaterThanOrEqual(Metrics.overflow(side: 393), CGFloat(AmbientDrift.amplitude.x) + zoomedBlur)
	}

	func testTheZoomOverflowCoversTheDriftAndTheZoomedBlurVertically() {
		let zoomedBlur = Metrics.blurRadius * Metrics.zoom
		XCTAssertGreaterThanOrEqual(Metrics.overflow(side: 844), CGFloat(AmbientDrift.amplitude.y) + zoomedBlur)
	}

	func testTheOverflowIsHalfTheZoomedExcess() {
		XCTAssertEqual(Metrics.overflow(side: 100), 35, accuracy: 1e-9)
		XCTAssertEqual(Metrics.overflow(side: 0), 0)
	}

	// MARK: - Veil

	func testTheVeilHasThreeStopsAtTheTextStop() {
		XCTAssertEqual(Metrics.veilStops().map(\.location), [0, 0.62, 1])
	}

	func testTheVeilIsTheElevatedBackgroundAtTheTwoOpacities() {
		let elevated = rgb(Track1Tokens.colorBackgroundElevated)
		let stops = Metrics.veilStops().map { components($0.color) }
		XCTAssertEqual(stops.count, 3)
		for stop in stops {
			XCTAssertEqual(stop.color.red, elevated.red, accuracy: 1e-3)
			XCTAssertEqual(stop.color.green, elevated.green, accuracy: 1e-3)
			XCTAssertEqual(stop.color.blue, elevated.blue, accuracy: 1e-3)
		}
		for (stop, opacity) in zip(stops, [0.65, 0.80, 0.80]) {
			XCTAssertEqual(stop.alpha, opacity, accuracy: 1.0 / 255)
		}
	}

	func testTheVeilGetsDarkerFromTopToBottom() {
		let opacities = Metrics.veilStops().map { components($0.color).alpha }
		XCTAssertEqual(opacities, opacities.sorted())
		XCTAssertLessThan(opacities[0], opacities[1])
	}

	// MARK: - Readability

	func testTheTextsKeepAContrastOf4Point5OverAWhiteCoverUnderTheVeil() {
		let white = RGB(hex: 0xFFFFFF)
		let elevated = rgb(Track1Tokens.colorBackgroundElevated)
		let primary = rgb(Track1Tokens.colorTextPrimary)
		let secondary = rgb(Track1Tokens.colorTextSecondary)

		let top = WCAGContrast.composite(elevated, opacity: Metrics.veilTopOpacity, over: white)
		XCTAssertGreaterThanOrEqual(WCAGContrast.ratio(primary, top), 4.5)

		let bottom = WCAGContrast.composite(elevated, opacity: Metrics.veilBottomOpacity, over: white)
		XCTAssertGreaterThanOrEqual(WCAGContrast.ratio(secondary, bottom), 4.5)

		// Without the veil, the dimmer text would not be readable: the veil is needed, not decoration.
		XCTAssertLessThan(WCAGContrast.ratio(secondary, white), 4.5)
	}

	func testTheVeilIsAtItsMaximumBeforeTheTitle() {
		let height = Metrics.designSize.height
		let titleTop =
			TodayHomeMetrics.mainBlockTop + TodayHomeMetrics.coverSide + TodayHomeMetrics.mainBlockSpacing
			+ NodeTypeBadge.tagRole.lineHeight + TodayHomeMetrics.mainBlockSpacing
		XCTAssertLessThanOrEqual(Metrics.veilTextStop * height, titleTop)
	}

	func testTheTopBlockIsNotUnderTheMaximumOfTheVeil() {
		XCTAssertGreaterThanOrEqual(
			Metrics.veilTextStop * Metrics.designSize.height, TodayHomeMetrics.mainBlockTop)
	}

	// MARK: - Contract

	func testTheBackdropIsBuiltFromACover() {
		_ = AmbientCoverBackdrop(cover: Image(systemName: "photo"))
	}
}
