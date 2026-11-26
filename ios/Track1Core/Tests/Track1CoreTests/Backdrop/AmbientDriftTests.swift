import XCTest

@testable import Track1Core

/// The pure rules behind the ambient cover backdrop drift (TRA-829).
final class AmbientDriftTests: XCTestCase {
	private func assertEqual(
		_ first: (x: Double, y: Double), _ second: (x: Double, y: Double), accuracy: Double = 1e-9,
		line: UInt = #line
	) {
		XCTAssertEqual(first.x, second.x, accuracy: accuracy, line: line)
		XCTAssertEqual(first.y, second.y, accuracy: accuracy, line: line)
	}

	// MARK: Phase

	func testTheLoopLastsSixtySeconds() {
		XCTAssertEqual(AmbientDrift.loopDuration, 60)
	}

	func testPhaseFollowsTheClockOverSixtySeconds() {
		XCTAssertEqual(AmbientDrift.phase(elapsed: 0), 0, accuracy: 1e-12)
		XCTAssertEqual(AmbientDrift.phase(elapsed: 15), 0.25, accuracy: 1e-12)
		XCTAssertEqual(AmbientDrift.phase(elapsed: 60), 0, accuracy: 1e-12)
		XCTAssertEqual(AmbientDrift.phase(elapsed: 75), 0.25, accuracy: 1e-12)
	}

	// MARK: Offset

	func testTheDriftStartsAndEndsOnTheCenter() {
		assertEqual(AmbientDrift.offset(phase: 0), (x: 0, y: 0))
		assertEqual(AmbientDrift.offset(phase: 0), AmbientDrift.offset(phase: 1))
	}

	func testTheDriftStaysWithinTheAmplitude() {
		for step in 0...1000 {
			let offset = AmbientDrift.offset(phase: Double(step) / 1000)
			XCTAssertLessThanOrEqual(abs(offset.x), AmbientDrift.amplitude.x)
			XCTAssertLessThanOrEqual(abs(offset.y), AmbientDrift.amplitude.y)
		}
	}

	func testTheDriftReachesTheAmplitude() {
		// A quarter of the loop is the extreme of x; an eighth is the extreme of y (y runs at twice the rate).
		XCTAssertEqual(AmbientDrift.offset(phase: 0.25).x, AmbientDrift.amplitude.x, accuracy: 1e-9)
		XCTAssertEqual(AmbientDrift.offset(phase: 0.125).y, AmbientDrift.amplitude.y, accuracy: 1e-9)
	}

	func testTheDriftMovesGentlyBetweenTwoImages() {
		// One step is one image of the loop, drawn 15 times a second (`AmbientCoverBackdropMetrics.frameInterval`).
		let steps = Int(AmbientDrift.loopDuration * 15)
		var previous = AmbientDrift.offset(phase: 0)
		for step in 1...steps {
			let offset = AmbientDrift.offset(phase: Double(step) / Double(steps))
			// The fastest component moves by less than a quarter of a point per image: no visible jump.
			XCTAssertLessThan(abs(offset.x - previous.x), 0.25)
			XCTAssertLessThan(abs(offset.y - previous.y), 0.25)
			previous = offset
		}
	}

	func testAPhaseOutOfTheLoopWraps() {
		assertEqual(AmbientDrift.offset(phase: 1.25), AmbientDrift.offset(phase: 0.25))
		assertEqual(AmbientDrift.offset(phase: -0.75), AmbientDrift.offset(phase: 0.25))
	}

	func testANonFinitePhaseIsTheCenter() {
		assertEqual(AmbientDrift.offset(phase: .nan), (x: 0, y: 0))
		assertEqual(AmbientDrift.offset(phase: .infinity), (x: 0, y: 0))
	}
}
