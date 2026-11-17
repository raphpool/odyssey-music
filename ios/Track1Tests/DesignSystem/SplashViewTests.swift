import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// The numbers are spelled out again from the Figma node `318:6513` (`Splash Screen`, frame 393 x 844), read
/// on 2026-11-17 (TRA-719): a constant changed in `SplashMetrics` alone fails here.
final class SplashViewTests: XCTestCase {
	/// `rrggbbaa`, to compare with the Figma hex and to read a failure.
	private func rgbaHex(_ color: Color) -> String {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "no-rgb" }
		return [red, green, blue, alpha].map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}

	func testTheMetricsAreThoseOfTheFigmaNode() {
		XCTAssertEqual(SplashMetrics.markSize, 184.32)
		XCTAssertEqual(SplashMetrics.markTop, 330)
		XCTAssertEqual(SplashMetrics.frameHeight, 844)
		XCTAssertEqual(SplashMetrics.markSize, AppMarkMetrics.splashSize, "the mark is the AppMark of TRA-711")
	}

	/// 184.32 / 2 = 92.16 and 330 + 92.16 = 422.16 = 844 / 2 + 0.16: the `top-[calc(50%+0.16px)]` of `362:4965`.
	func testTheMarkIsAt104_34And330InAFrameOf393By844() {
		let mark = SplashMetrics.markFrame(in: CGSize(width: 393, height: 844))
		XCTAssertEqual(mark.origin.x, 104.34, accuracy: 0.001)
		XCTAssertEqual(mark.origin.y, 330, accuracy: 0.001)
		XCTAssertEqual(mark.width, 184.32, accuracy: 0.001)
		XCTAssertEqual(mark.height, 184.32, accuracy: 0.001)
		XCTAssertEqual(mark.midX, 393 / 2, accuracy: 0.001, "centered horizontally")
		XCTAssertEqual(mark.midY, 422.16, accuracy: 0.001)
	}

	/// 402 x 874 is the display of the iPhone 17 Pro. (402 - 184.32) / 2 = 108.84 and 874 x 330 / 844 = 341.73.
	func testTheMarkKeepsItsRatioFromTheTopOnAnotherScreen() {
		let mark = SplashMetrics.markFrame(in: CGSize(width: 402, height: 874))
		XCTAssertEqual(mark.origin.x, 108.84, accuracy: 0.001)
		XCTAssertEqual(mark.origin.y, 341.73, accuracy: 0.01)
		XCTAssertEqual(mark.midX, 402 / 2, accuracy: 0.001)
		XCTAssertEqual(mark.width, 184.32, accuracy: 0.001, "the size does not scale")
		XCTAssertEqual(mark.origin.y / 874, 330.0 / 844.0, accuracy: 0.000001)
	}

	/// `#3D3429` at the top to `#1A110E` at 30.746 %, read on the root node `318:6513`.
	func testBackgroundIsTheVerticalGradientOfTheRootNode() {
		let stops = SplashMetrics.backgroundStops
		XCTAssertEqual(stops.count, 2)
		XCTAssertEqual(stops[0].location, 0, accuracy: 0.000001)
		XCTAssertEqual(stops[1].location, 0.30746, accuracy: 0.000001)
		XCTAssertEqual(stops.map { rgbaHex($0.color) }, ["3d3429ff", "1a110eff"])
	}

	func testTheViewIsTheSplashElementOfVoiceOver() {
		XCTAssertEqual(SplashView.identifier, "splash")
		XCTAssertEqual(SplashView.accessibilityLabel, "Chargement")
	}

	/// The delay and the status past it are outside TRA-719: the splash replaced the body of the wait only.
	func testTheLoadingViewKeepsItsDelayOf20Seconds() {
		XCTAssertEqual(RecommendationLoadingView.timeout, .seconds(20))
	}

	// MARK: Launch screen

	/// The system launch screen is flat `#1A110E` and ends on the splash without a jump: the colorset is the
	/// `background/elevated` token.
	func testLaunchBackgroundColorIsTheElevatedBackground() throws {
		let color = try XCTUnwrap(UIColor(named: "LaunchBackground"))
		XCTAssertEqual(rgbaHex(Color(color)), "1a110eff")
		XCTAssertEqual(rgbaHex(Track1Tokens.colorBackgroundElevated), "1a110eff")
	}
}
