import XCTest

@testable import Track1Core

/// The pure rules behind the Welcome backdrop and the Progress bar (TRA-390).
final class BackdropMathTests: XCTestCase {
	private let ring = [RGB(hex: 0xFF0000), RGB(hex: 0x00FF00), RGB(hex: 0x0000FF)]

	private func assertEqual(_ first: RGB, _ second: RGB, accuracy: Double = 1e-9, line: UInt = #line) {
		XCTAssertEqual(first.red, second.red, accuracy: accuracy, line: line)
		XCTAssertEqual(first.green, second.green, accuracy: accuracy, line: line)
		XCTAssertEqual(first.blue, second.blue, accuracy: accuracy, line: line)
	}

	// MARK: Color cycle

	func testHexComponents() {
		let color = RGB(hex: 0xFF8000)
		XCTAssertEqual(color.red, 1, accuracy: 1e-9)
		XCTAssertEqual(color.green, 128 / 255, accuracy: 1e-9)
		XCTAssertEqual(color.blue, 0, accuracy: 1e-9)
	}

	func testTheLoopHasNoCut() {
		for offset in 0..<ring.count {
			XCTAssertEqual(
				ColorCycle.color(at: 0, ring: ring, offset: offset),
				ColorCycle.color(at: 1, ring: ring, offset: offset))
		}
	}

	func testTheWalkStartsOnTheOffsetColorAndReachesTheNextOneAtAThird() {
		assertEqual(ColorCycle.color(at: 0, ring: ring, offset: 1), ring[1])
		assertEqual(ColorCycle.color(at: 1.0 / 3, ring: ring, offset: 1), ring[2])
		assertEqual(ColorCycle.color(at: 2.0 / 3, ring: ring, offset: 1), ring[0])
	}

	func testBetweenTwoRingColorsTheMixIsLinear() {
		assertEqual(ColorCycle.color(at: 1.0 / 6, ring: ring), RGB(red: 0.5, green: 0.5, blue: 0))
	}

	func testTheColorIsContinuous() {
		var previous = ColorCycle.color(at: 0, ring: ring)
		for step in 1...1000 {
			let color = ColorCycle.color(at: Double(step) / 1000, ring: ring)
			// A step of 1/1000 of the loop moves a component by at most 3/1000 on this ring.
			XCTAssertLessThan(abs(color.red - previous.red), 0.0031)
			XCTAssertLessThan(abs(color.green - previous.green), 0.0031)
			XCTAssertLessThan(abs(color.blue - previous.blue), 0.0031)
			previous = color
		}
	}

	func testANegativeOffsetWalksTheRingBackwards() {
		assertEqual(ColorCycle.color(at: 0, ring: ring, offset: -1), ring[2])
		assertEqual(ColorCycle.color(at: 0, ring: ring, offset: -4), ring[2])
		assertEqual(ColorCycle.color(at: 1.0 / 3, ring: ring, offset: -1), ring[0])
	}

	func testLoopPhaseWrapsAnyNumber() {
		XCTAssertEqual(LoopPhase.wrapped(0.25), 0.25, accuracy: 1e-12)
		XCTAssertEqual(LoopPhase.wrapped(1), 0, accuracy: 1e-12)
		XCTAssertEqual(LoopPhase.wrapped(2.75), 0.75, accuracy: 1e-12)
		XCTAssertEqual(LoopPhase.wrapped(-0.25), 0.75, accuracy: 1e-12)
		XCTAssertEqual(LoopPhase.wrapped(.nan), 0, accuracy: 1e-12)
		XCTAssertEqual(LoopPhase.wrapped(-1e-20), 0, accuracy: 1e-12)
		for value in [-3.3, -1e-17, 0, 0.999999, 7.5, 1e9] {
			XCTAssertGreaterThanOrEqual(LoopPhase.wrapped(value), 0)
			XCTAssertLessThan(LoopPhase.wrapped(value), 1)
		}
	}

	func testAPhaseOutsideTheLoopWrapsAndANaNCountsAsZero() {
		assertEqual(ColorCycle.color(at: 1.25, ring: ring), ColorCycle.color(at: 0.25, ring: ring))
		assertEqual(ColorCycle.color(at: -0.25, ring: ring), ColorCycle.color(at: 0.75, ring: ring))
		assertEqual(ColorCycle.color(at: .nan, ring: ring), ring[0])
		assertEqual(ColorCycle.color(at: .infinity, ring: ring), ring[0])
	}

	// MARK: WCAG contrast

	func testBlackOnWhiteIs21AndWhiteOnWhiteIs1() {
		XCTAssertEqual(WCAGContrast.ratio(RGB(hex: 0x000000), RGB(hex: 0xFFFFFF)), 21, accuracy: 1e-9)
		XCTAssertEqual(WCAGContrast.ratio(RGB(hex: 0xFFFFFF), RGB(hex: 0xFFFFFF)), 1, accuracy: 1e-9)
	}

	func testTheRatioDoesNotDependOnTheOrder() {
		let first = RGB(hex: 0xF6E9D8)
		let second = RGB(hex: 0x120C0A)
		XCTAssertEqual(WCAGContrast.ratio(first, second), WCAGContrast.ratio(second, first), accuracy: 1e-12)
	}

	func testKnownLuminances() {
		// The WCAG reference grey #777777 is 4.48:1 on white.
		XCTAssertEqual(WCAGContrast.ratio(RGB(hex: 0x777777), RGB(hex: 0xFFFFFF)), 4.48, accuracy: 0.01)
		XCTAssertEqual(WCAGContrast.relativeLuminance(RGB(hex: 0xFFFFFF)), 1, accuracy: 1e-9)
		XCTAssertEqual(WCAGContrast.relativeLuminance(RGB(hex: 0x000000)), 0, accuracy: 1e-9)
	}

	func testCompositeMixesTheOverlayOverTheBackground() {
		let result = WCAGContrast.composite(RGB(hex: 0x000000), opacity: 0.25, over: RGB(hex: 0xFFFFFF))
		assertEqual(result, RGB(red: 0.75, green: 0.75, blue: 0.75))
		let white = RGB(hex: 0xFFFFFF)
		let black = RGB(hex: 0x000000)
		assertEqual(WCAGContrast.composite(black, opacity: 0, over: white), white)
		// An opacity out of range cannot leave the sRGB cube.
		assertEqual(WCAGContrast.composite(black, opacity: 1.7, over: white), black)
		assertEqual(WCAGContrast.composite(black, opacity: -2, over: white), white)
		assertEqual(WCAGContrast.composite(black, opacity: .nan, over: white), white)
	}

	// MARK: Progress fraction

	func testClampKeepsTheValueInsideTheTrack() {
		XCTAssertEqual(ProgressFraction.clamped(1.4), 1, accuracy: 1e-12)
		XCTAssertEqual(ProgressFraction.clamped(-1), 0, accuracy: 1e-12)
		XCTAssertEqual(ProgressFraction.clamped(0.31), 0.31, accuracy: 1e-12)
		XCTAssertEqual(ProgressFraction.clamped(.nan), 0, accuracy: 1e-12)
		XCTAssertEqual(ProgressFraction.clamped(.infinity), 1, accuracy: 1e-12)
		XCTAssertEqual(ProgressFraction.clamped(-.infinity), 0, accuracy: 1e-12)
	}

	func testTheSweepEntersOnTheLeftAndLeavesOnTheRight() {
		let first = ProgressFraction.sweep(phase: 0, length: 0.3)
		XCTAssertEqual(first.start, 0, accuracy: 1e-12)
		XCTAssertEqual(first.end, 0, accuracy: 1e-12)
		let entering = ProgressFraction.sweep(phase: 0.1, length: 0.3)
		XCTAssertEqual(entering.start, 0, accuracy: 1e-12)
		XCTAssertEqual(entering.end, 0.13, accuracy: 1e-12)
		let middle = ProgressFraction.sweep(phase: 0.5, length: 0.3)
		XCTAssertEqual(middle.start, 0.35, accuracy: 1e-12)
		XCTAssertEqual(middle.end, 0.65, accuracy: 1e-12)
		let leaving = ProgressFraction.sweep(phase: 0.9, length: 0.3)
		XCTAssertEqual(leaving.start, 0.87, accuracy: 1e-12)
		XCTAssertEqual(leaving.end, 1, accuracy: 1e-12)
	}

	func testTheSweepNeverLeavesTheTrack() {
		for step in 0...200 {
			let segment = ProgressFraction.sweep(phase: Double(step) / 200, length: 0.31)
			XCTAssertGreaterThanOrEqual(segment.start, 0)
			XCTAssertLessThanOrEqual(segment.end, 1)
			XCTAssertLessThanOrEqual(segment.start, segment.end)
		}
	}
}
