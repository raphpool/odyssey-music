import XCTest

@testable import Track1Core

/// TRA-716 (task 5.4, decision D3): which sentence is at the centre of the player, and where the scroll
/// settles.
/// The three paragraph heights (170, 238, 306) and the 56 gap are the Figma `338:2492` measurements.
final class PlayerScrollTests: XCTestCase {
	private let viewport = 844.0

	/// Heights 170, 238 and 306 spaced by 56: minY 0, 226 and 520, so the middles are 85, 345 and 673.
	private let figmaFrames = [
		PlayerItemFrame(minY: 0, height: 170),
		PlayerItemFrame(minY: 226, height: 238),
		PlayerItemFrame(minY: 520, height: 306),
	]

	/// The offset that puts the middle of `figmaFrames[index]` on the centre of the 844 window.
	private func centeredOffset(_ index: Int) -> Double {
		figmaFrames[index].minY + figmaFrames[index].height / 2 - viewport / 2
	}

	// MARK: empty

	func testNoFramesMeansNoFocusAndTheProposedOffsetIsKept() {
		XCTAssertNil(PlayerScroll.focusedIndex(offset: 120, viewportHeight: viewport, frames: []))
		XCTAssertEqual(PlayerScroll.snapOffset(proposed: 120, viewportHeight: viewport, frames: []), 120)
	}

	// MARK: nominal

	func testEachFigmaParagraphSnapsToItsOwnMiddleWhateverNearbyOffsetIsProposed() {
		for index in figmaFrames.indices {
			let expected = centeredOffset(index)
			for drift in [-40.0, 0, 40] {
				let snapped = PlayerScroll.snapOffset(
					proposed: expected + drift, viewportHeight: viewport, frames: figmaFrames)
				XCTAssertEqual(snapped, expected, "paragraph \(index), drift \(drift)")
			}
		}
	}

	func testTheSnappedOffsetFocusesTheParagraphItCentres() {
		for index in figmaFrames.indices {
			XCTAssertEqual(
				PlayerScroll.focusedIndex(offset: centeredOffset(index), viewportHeight: viewport, frames: figmaFrames),
				index)
		}
	}

	func testFocusFollowsTheMiddleClosestToTheWindowCentre() {
		// Offset 0 puts the centre at 422: the middles are 337, 77 and 251 away.
		XCTAssertEqual(PlayerScroll.focusedIndex(offset: 0, viewportHeight: viewport, frames: figmaFrames), 1)
		// Offset 600 puts it at 1022: the last paragraph is nearest.
		XCTAssertEqual(PlayerScroll.focusedIndex(offset: 600, viewportHeight: viewport, frames: figmaFrames), 2)
	}

	func testASingleParagraphIsAlwaysTheFocusAndTheSnapTarget() {
		let frames = [PlayerItemFrame(minY: 0, height: 170)]
		XCTAssertEqual(PlayerScroll.focusedIndex(offset: 500, viewportHeight: viewport, frames: frames), 0)
		XCTAssertEqual(PlayerScroll.snapOffset(proposed: 500, viewportHeight: viewport, frames: frames), -337)
	}

	/// TRA-795: the frames the view reports start below the top margin that centres the first paragraph.
	func testScrollingFocusesEveryParagraphInTurnAndTheOneHoldingTheCentre() throws {
		let window = 774.0
		let heights = [34.0, 68, 102, 68, 34, 68]
		var minY = window / 2 - heights[0] / 2
		var frames: [PlayerItemFrame] = []
		for height in heights {
			frames.append(PlayerItemFrame(minY: minY, height: height))
			minY += height + 56
		}
		let last = try XCTUnwrap(frames.last)
		XCTAssertEqual(PlayerScroll.focusedIndex(offset: 0, viewportHeight: window, frames: frames), 0)

		var visited: [Int] = []
		for step in 0...Int(last.midY - window / 2) {
			let center = Double(step) + window / 2
			let focused = try XCTUnwrap(
				PlayerScroll.focusedIndex(offset: Double(step), viewportHeight: window, frames: frames))
			if let holder = frames.firstIndex(where: { $0.minY <= center && center <= $0.maxY }) {
				XCTAssertEqual(focused, holder, "offset \(step): the frame that holds the centre is the focus")
			}
			if visited.last != focused { visited.append(focused) }
		}

		XCTAssertEqual(visited, Array(frames.indices), "each paragraph takes the focus once, in order")
	}

	// MARK: ends of the content

	func testTheFirstParagraphCanBeCentredAtANegativeOffset() {
		let snapped = PlayerScroll.snapOffset(proposed: -300, viewportHeight: viewport, frames: figmaFrames)
		XCTAssertEqual(snapped, -337)
		XCTAssertLessThan(snapped, 0)
	}

	func testTheLastParagraphCanBeCentredPastTheEndOfTheContent() {
		let contentEnd = 520.0 + 306.0
		let snapped = PlayerScroll.snapOffset(proposed: 700, viewportHeight: viewport, frames: figmaFrames)
		XCTAssertEqual(snapped, 251)
		XCTAssertGreaterThan(snapped + viewport, contentEnd)
	}

	// MARK: ties

	func testTwoMiddlesAtTheSameDistanceFocusTheLowestIndex() {
		// Middles 50 and 250, window centre 150 (offset -350, window 1000): both are 100 away.
		let frames = [PlayerItemFrame(minY: 0, height: 100), PlayerItemFrame(minY: 200, height: 100)]
		XCTAssertEqual(PlayerScroll.focusedIndex(offset: -350, viewportHeight: 1000, frames: frames), 0)
		XCTAssertEqual(PlayerScroll.snapOffset(proposed: -350, viewportHeight: 1000, frames: frames), -450)
	}

	// MARK: long paragraph

	func testAParagraphTallerThanTheWindowIsReadFreelyWhileTheCentreStaysInsideIt() {
		let frames = [PlayerItemFrame(minY: 0, height: 900), PlayerItemFrame(minY: 956, height: 170)]
		// Centres 522, 822 (already nearer the neighbour's middle, 1041, than the long one's, 450) and the
		// bottom edge 900, which still belongs to the paragraph.
		for proposed in [100.0, 400, 478] {
			XCTAssertEqual(
				PlayerScroll.snapOffset(proposed: proposed, viewportHeight: viewport, frames: frames), proposed,
				"proposed \(proposed)")
		}
	}

	func testTheNeighbourIsSnappedAsSoonAsTheCentreLeavesTheLongParagraph() {
		let frames = [PlayerItemFrame(minY: 0, height: 900), PlayerItemFrame(minY: 956, height: 170)]
		// Centre 901 is one point past the bottom edge: the neighbour's middle, 1041, minus 422.
		XCTAssertEqual(PlayerScroll.snapOffset(proposed: 479, viewportHeight: viewport, frames: frames), 619)
	}

	func testTheLongParagraphIsAlsoFreeFromItsTopEdgeAndSnapsTheNeighbourBeforeIt() {
		let frames = [PlayerItemFrame(minY: 0, height: 170), PlayerItemFrame(minY: 226, height: 900)]
		// Centre 226 is the top edge of the long paragraph; centre 225 is still in the gap.
		XCTAssertEqual(PlayerScroll.snapOffset(proposed: -196, viewportHeight: viewport, frames: frames), -196)
		XCTAssertEqual(PlayerScroll.snapOffset(proposed: -197, viewportHeight: viewport, frames: frames), -337)
	}

	func testALongParagraphThatIsOutsideTheCentreStillSnapsToItsMiddle() {
		// Window 1000, so 900 is long. Centre 1000 is in the gap before it and its middle (1500) is the nearest.
		let frames = [PlayerItemFrame(minY: 0, height: 170), PlayerItemFrame(minY: 1050, height: 900)]
		let snapped = PlayerScroll.snapOffset(proposed: 500, viewportHeight: 1000, frames: frames)
		XCTAssertEqual(snapped, 1000)
	}

	func testTheLongThresholdIsEightyPercentOfTheWindowAndStrict() {
		XCTAssertEqual(PlayerScroll.longItemRatio, 0.8)
		// Window 1000: a paragraph of exactly 800 is not long, so it snaps; one of 801 is read freely.
		let regular = [PlayerItemFrame(minY: 0, height: 800)]
		let long = [PlayerItemFrame(minY: 0, height: 801)]
		XCTAssertEqual(PlayerScroll.snapOffset(proposed: 50, viewportHeight: 1000, frames: regular), -100)
		XCTAssertEqual(PlayerScroll.snapOffset(proposed: 50, viewportHeight: 1000, frames: long), 50)
	}
}
