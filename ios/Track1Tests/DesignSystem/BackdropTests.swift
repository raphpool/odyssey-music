import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Progress bar (`175:56`) and Welcome backdrop (`175:66`): the rules of their Docs `175:59` and `175:68`
/// that are not pixels. The pure math (cycle, WCAG ratio, clamp) is tested in `Track1Core`; here, the
/// contract the screens read.
final class BackdropTests: XCTestCase {
	/// Opaque RGB of a SwiftUI color, so that colors are compared by value.
	private func rgb(_ color: Color) -> RGB {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		return RGB(red: Double(red), green: Double(green), blue: Double(blue))
	}

	private func assertEqual(_ first: RGB, _ second: RGB, line: UInt = #line) {
		XCTAssertEqual(first.red, second.red, accuracy: 1e-6, line: line)
		XCTAssertEqual(first.green, second.green, accuracy: 1e-6, line: line)
		XCTAssertEqual(first.blue, second.blue, accuracy: 1e-6, line: line)
	}

	// MARK: Welcome backdrop

	func testTheLoopHasNoCut() {
		XCTAssertEqual(WelcomeBackdropPalette.colors(at: 0), WelcomeBackdropPalette.colors(at: 1))
		for (first, last) in zip(WelcomeBackdropPalette.colors(at: 0), WelcomeBackdropPalette.colors(at: 1)) {
			assertEqual(rgb(first), rgb(last))
		}
	}

	func testPhaseZeroIsTheFigmaFrame() {
		let frame = WelcomeBackdropPalette.colors(at: 0).map(rgb)
		let figma = [RGB(hex: 0x64394C), RGB(hex: 0x6A3D36), RGB(hex: 0xFAD481)]
		XCTAssertEqual(frame.count, figma.count)
		for (actual, expected) in zip(frame, figma) { assertEqual(actual, expected) }
	}

	func testTheColorsMorphWithoutJump() {
		var previous = WelcomeBackdropPalette.rgbStops(at: 0)
		for step in 1...450 {
			let stops = WelcomeBackdropPalette.rgbStops(at: Double(step) / 450)
			for (now, before) in zip(stops, previous) {
				// A 450th of the loop moves a component by at most 3 / 450 on a 3-color ring.
				XCTAssertLessThan(abs(now.red - before.red), 0.0067)
				XCTAssertLessThan(abs(now.green - before.green), 0.0067)
				XCTAssertLessThan(abs(now.blue - before.blue), 0.0067)
			}
			previous = stops
		}
	}

	/// TRA-724: the loop went from 45 to 30 s (note `362:4993`: "speed the background up slightly").
	func testPhaseFollowsTheClockOverThirtySeconds() {
		XCTAssertEqual(WelcomeBackdrop.loopDuration, 30, accuracy: 1e-12)
		XCTAssertEqual(WelcomeBackdropPalette.phase(elapsed: 0), 0, accuracy: 1e-12)
		XCTAssertEqual(WelcomeBackdropPalette.phase(elapsed: 7.5), 0.25, accuracy: 1e-12)
		XCTAssertEqual(WelcomeBackdropPalette.phase(elapsed: 30), 0, accuracy: 1e-12)
		XCTAssertEqual(WelcomeBackdropPalette.phase(elapsed: 37.5), 0.25, accuracy: 1e-12)
	}

	func testTextPrimaryKeepsAContrastOf4Point5OnTheLightestColorUnderTheVeil() {
		let text = rgb(Track1Tokens.colorTextPrimary)
		let veil = rgb(Track1Tokens.colorBackgroundBase)
		// The lightest color of the palette over the whole loop, not only at the Figma frame.
		let lightest = (0...1000)
			.flatMap { WelcomeBackdropPalette.colors(at: Double($0) / 1000).map(rgb) }
			.max { WCAGContrast.relativeLuminance($0) < WCAGContrast.relativeLuminance($1) }
		guard let light = lightest else { return XCTFail("The palette has colors") }
		assertEqual(light, WelcomeBackdropPalette.amber)

		let veiled = WCAGContrast.composite(
			veil, opacity: WelcomeBackdropPalette.overlayOpacity, over: light)
		XCTAssertGreaterThanOrEqual(WCAGContrast.ratio(text, veiled), 4.5)
		// Without the veil, the text would not be readable: the veil is needed, not decoration.
		XCTAssertLessThan(WCAGContrast.ratio(text, light), 4.5)
	}

	func testTheVeilIsAPartialOpacity() {
		XCTAssertGreaterThan(WelcomeBackdropPalette.overlayOpacity, 0)
		XCTAssertLessThan(WelcomeBackdropPalette.overlayOpacity, 1)
	}

	// MARK: Progress bar

	func testDeterminateIsClampedToTheTrack() {
		XCTAssertEqual(Track1ProgressBar.Mode.determinate(1.4).fraction ?? -1, 1, accuracy: 1e-12)
		XCTAssertEqual(Track1ProgressBar.Mode.determinate(-1).fraction ?? -1, 0, accuracy: 1e-12)
		XCTAssertEqual(Track1ProgressBar.Mode.determinate(0.3).fraction ?? -1, 0.3, accuracy: 1e-12)
		XCTAssertNil(Track1ProgressBar.Mode.indeterminate.fraction)
	}

	func testTheDrawnSegmentOfADeterminateBarIsClamped() {
		let over = Track1ProgressBar.segment(mode: .determinate(1.4), phase: 0.5, reduceMotion: false)
		XCTAssertEqual(over.start, 0, accuracy: 1e-12)
		XCTAssertEqual(over.end, 1, accuracy: 1e-12)
		let under = Track1ProgressBar.segment(mode: .determinate(-1), phase: 0.5, reduceMotion: true)
		XCTAssertEqual(under.start, 0, accuracy: 1e-12)
		XCTAssertEqual(under.end, 0, accuracy: 1e-12)
	}

	func testTheSweepLoopsEvery1Point2SecondsAndStaysOnTheTrack() {
		XCTAssertEqual(Track1ProgressBar.sweepDuration, 1.2, accuracy: 1e-12)
		let origin = Date(timeIntervalSinceReferenceDate: 0)
		XCTAssertEqual(Track1ProgressBar.sweepPhase(at: origin), 0, accuracy: 1e-9)
		XCTAssertEqual(Track1ProgressBar.sweepPhase(at: origin.addingTimeInterval(0.3)), 0.25, accuracy: 1e-9)
		XCTAssertEqual(Track1ProgressBar.sweepPhase(at: origin.addingTimeInterval(1.5)), 0.25, accuracy: 1e-9)
		for step in 0...100 {
			let sweep = Track1ProgressBar.segment(
				mode: .indeterminate, phase: Double(step) / 100, reduceMotion: false)
			XCTAssertGreaterThanOrEqual(sweep.start, 0)
			XCTAssertLessThanOrEqual(sweep.end, 1)
		}
	}

	func testUnderReduceMotionAnIndeterminateBarIsAStaticPartialBar() {
		let first = Track1ProgressBar.segment(mode: .indeterminate, phase: 0.2, reduceMotion: true)
		let second = Track1ProgressBar.segment(mode: .indeterminate, phase: 0.8, reduceMotion: true)
		XCTAssertEqual(first.start, second.start, accuracy: 1e-12)
		XCTAssertEqual(first.end, second.end, accuracy: 1e-12)
		XCTAssertEqual(first.start, 0, accuracy: 1e-12)
		XCTAssertEqual(first.end, 99.0 / 320.0, accuracy: 1e-12)
		XCTAssertGreaterThan(first.end, 0)
		XCTAssertLessThan(first.end, 1)
	}

	func testTheBarAnimatesItsWidthOver200msOnTheStandardCurveAndNotUnderReduceMotion() {
		XCTAssertEqual(Track1Motion.standard.duration, 0.2, accuracy: 1e-12)
		XCTAssertEqual(
			Track1ProgressBar.widthAnimation(reduceMotion: false),
			.timingCurve(0.2, 0, 0, 1, duration: 0.2))
		XCTAssertNil(Track1ProgressBar.widthAnimation(reduceMotion: true))
	}
}
