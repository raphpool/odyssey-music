import CoreGraphics
import XCTest

@testable import Track1Core

final class ScrollTickDetectorTests: XCTestCase {
	/// Rows of 100 pt with their bottom edges at 100, 200, 300 and 400 in content coordinates, under a bar
	/// whose top edge is at 250. A row sits at `maxY - offset` in the scroll view: at offset 0 the first two
	/// are above the edge and the last two below it.
	private let rows: [CGFloat] = [100, 200, 300, 400]
	private let threshold: CGFloat = 250

	private func crossings(from previous: CGFloat, to new: CGFloat, rows: [CGFloat]? = nil) -> Int {
		ScrollTickDetector.crossings(
			rowMaxYs: rows ?? self.rows, previousOffset: previous, newOffset: new, threshold: threshold)
	}

	func testNoRowCrossesWhenTheOffsetDoesNotChange() {
		XCTAssertEqual(crossings(from: 40, to: 40), 0)
	}

	func testNoRowCrossesWhenNoRowReachesTheEdge() {
		// At offset 30 the third row is at 270, still below the edge.
		XCTAssertEqual(crossings(from: 0, to: 30), 0)
		XCTAssertEqual(crossings(from: 0, to: 30, rows: []), 0)
	}

	func testOneRowCrossingUpwardCountsOne() {
		// At offset 60 the third row is at 240, above the edge; the fourth is at 340, still below.
		XCTAssertEqual(crossings(from: 0, to: 60), 1)
	}

	func testTwoRowsCrossingInOneStepCountTwo() {
		// At offset 160 the third row is at 140 and the fourth at 240: both are above the edge.
		XCTAssertEqual(crossings(from: 0, to: 160), 2)
	}

	func testScrollingBackCountsTheSameCrossings() {
		XCTAssertEqual(crossings(from: 60, to: 0), 1)
		XCTAssertEqual(crossings(from: 160, to: 0), 2)
		XCTAssertEqual(crossings(from: 160, to: 0), crossings(from: 0, to: 160))
	}

	func testARowOnTheEdgeCountsAsAboveAndIsNotCountedTwice() {
		// The third row is at exactly 250 at offset 50: above the edge there, so one crossing, once.
		XCTAssertEqual(crossings(from: 0, to: 50), 1)
		XCTAssertEqual(crossings(from: 50, to: 60), 0)
		XCTAssertEqual(crossings(from: 50, to: 0), 1)
	}

	func testStayingOnTheSameSideOfTheEdgeCountsNothing() {
		// Offsets 60 and 100: the first three rows are above the edge at both, the last one below.
		XCTAssertEqual(crossings(from: 60, to: 100), 0)
	}

	func testANonFiniteMeasurementCountsNothing() {
		XCTAssertEqual(
			ScrollTickDetector.crossings(rowMaxYs: rows, previousOffset: .nan, newOffset: 100, threshold: threshold),
			0)
		XCTAssertEqual(
			ScrollTickDetector.crossings(
				rowMaxYs: rows, previousOffset: 0, newOffset: .infinity, threshold: threshold), 0)
		XCTAssertEqual(
			ScrollTickDetector.crossings(rowMaxYs: rows, previousOffset: 0, newOffset: 100, threshold: .nan), 0)
		// A row whose own edge is not finite is skipped; the others still count.
		XCTAssertEqual(crossings(from: 0, to: 160, rows: [.nan, 300, 400]), 2)
	}
}
