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

	// MARK: carousel (TRA-801)

	private func step(from current: Int, _ displacement: Double, height: Double = 170, count: Int = 3) -> Int {
		PlayerScroll.carouselIndex(from: current, displacement: displacement, currentHeight: height, count: count)
	}

	/// Where a gesture that began at `origin` settles when the scroll view proposed `origin + travelled`.
	private func settle(
		_ origin: Double, travelling travelled: Double, in frames: [PlayerItemFrame]? = nil
	) -> Double {
		PlayerScroll.carouselOffset(
			origin: origin, proposed: origin + travelled, viewportHeight: viewport, frames: frames ?? figmaFrames)
	}

	func testASwipeIsOneStepWhateverItsLengthAndItsDirection() {
		// 170 high: the threshold is 56.67. Past it the answer is the next paragraph, or the previous one.
		for displacement in [57.0, 120, 600, 5_000, 1_000_000] {
			XCTAssertEqual(step(from: 0, displacement), 1, "displacement \(displacement)")
			XCTAssertEqual(step(from: 2, -displacement), 1, "displacement \(-displacement)")
		}
	}

	func testAShortGestureComesBackToTheCurrentParagraph() {
		for displacement in [56.0, 20, 1, 0, -1, -20, -56, Double.nan] {
			XCTAssertEqual(step(from: 1, displacement), 1, "displacement \(displacement)")
		}
	}

	func testTheThresholdIsAThirdOfTheCurrentHeightWithAFloorForShortParagraphs() {
		XCTAssertEqual(PlayerScroll.carouselThresholdRatio, 1.0 / 3)
		XCTAssertEqual(PlayerScroll.carouselMinimumThreshold, 20)
		// 170 / 3 = 56.67: just under stays, just over goes.
		XCTAssertEqual(step(from: 1, 56.6), 1)
		XCTAssertEqual(step(from: 1, 56.7), 2)
		// A third of 30 is 10: the floor of 20 applies instead.
		XCTAssertEqual(step(from: 1, 19.9, height: 30), 1)
		XCTAssertEqual(step(from: 1, 20, height: 30), 2)
		XCTAssertEqual(step(from: 1, -20, height: 30), 0)
	}

	func testTheCarouselStaysOnTheFirstAndTheLastParagraphAtTheEnds() {
		XCTAssertEqual(step(from: 0, -5_000), 0)
		XCTAssertEqual(step(from: 2, 5_000), 2)
		XCTAssertEqual(step(from: 0, 5_000, count: 1), 0)
	}

	func testTheCarouselOffsetCentresTheNeighbourWhateverTheSpeed() {
		for travelled in [110.0, 400, 5_000] {
			XCTAssertEqual(settle(centeredOffset(0), travelling: travelled), centeredOffset(1), "\(travelled)")
			XCTAssertEqual(settle(centeredOffset(2), travelling: -travelled), centeredOffset(1), "\(travelled)")
		}
	}

	func testTheCarouselOffsetGoesBackToTheCurrentParagraphUnderTheThreshold() {
		for travelled in [-50.0, -10, 0, 10, 50] {
			XCTAssertEqual(settle(centeredOffset(1), travelling: travelled), centeredOffset(1), "\(travelled)")
		}
	}

	func testTheCarouselOffsetStartsFromTheParagraphNearestToWhereTheGestureBegan() {
		// 30 points off the middle of the second paragraph, which is still the nearest to the window centre.
		let origin = centeredOffset(1) + 30
		XCTAssertEqual(settle(origin, travelling: 300), centeredOffset(2))
		XCTAssertEqual(settle(origin, travelling: -300), centeredOffset(0))
	}

	func testTheCarouselOffsetStopsAtTheFirstAndTheLastParagraph() {
		XCTAssertEqual(settle(centeredOffset(0), travelling: -900), centeredOffset(0))
		XCTAssertEqual(settle(centeredOffset(2), travelling: 900), centeredOffset(2))
		XCTAssertEqual(settle(0, travelling: 120, in: []), 120, "Without frames the proposed offset is kept.")
	}

	func testTheCarouselOffsetAlwaysPutsAParagraphAtTheCentre() {
		for origin in [-337.0, -200, -77, 100, 251] {
			for travelled in stride(from: -900.0, through: 900, by: 45) {
				let settled = settle(origin, travelling: travelled)
				let index = PlayerScroll.focusedIndex(offset: settled, viewportHeight: viewport, frames: figmaFrames)
				XCTAssertEqual(settled, index.map(centeredOffset), "origin \(origin), travelled \(travelled)")
			}
		}
	}

	/// The TRA-795 article: six sentences. Each swipe moves the focus by one, to the last and then back.
	func testSwipingAcrossAnArticleMovesOneParagraphAtATime() throws {
		let window = 774.0
		let heights = [34.0, 68, 102, 68, 34, 68]
		var minY = window / 2 - heights[0] / 2
		var built: [PlayerItemFrame] = []
		for height in heights {
			built.append(PlayerItemFrame(minY: minY, height: height))
			minY += height + 56
		}
		let frames = built
		var offset = 0.0
		func swipe(_ travelled: Double) throws -> Int {
			offset = PlayerScroll.carouselOffset(
				origin: offset, proposed: offset + travelled, viewportHeight: window, frames: frames)
			return try XCTUnwrap(PlayerScroll.focusedIndex(offset: offset, viewportHeight: window, frames: frames))
		}

		let forward = try (0..<8).map { _ in try swipe(3_000) }
		XCTAssertEqual(forward, [1, 2, 3, 4, 5, 5, 5, 5], "one step per swipe, then the last paragraph")
		let backward = try (0..<8).map { _ in try swipe(-3_000) }
		XCTAssertEqual(backward, [4, 3, 2, 1, 0, 0, 0, 0], "one step per swipe, then the first paragraph")
	}

	/// A touch that lands mid-animation, 30 % of the way between two paragraphs: the nearest is the one left.
	func testATouchDuringTheAnimationCountsFromTheParagraphItHeadsTo() {
		let live = centeredOffset(0) + 0.3 * (centeredOffset(1) - centeredOffset(0))
		XCTAssertEqual(PlayerScroll.focusedIndex(offset: live, viewportHeight: viewport, frames: figmaFrames), 0)

		let origin = PlayerScroll.carouselOrigin(live: live, heading: centeredOffset(1), isMoving: true)
		XCTAssertEqual(origin, centeredOffset(1))
		// The finger landed at `live`, and the scroll view projects from there: the displacement counts from there.
		func swipe(_ travelled: Double) -> Double {
			PlayerScroll.carouselOffset(
				origin: origin, proposed: live + travelled, touchedAt: live, viewportHeight: viewport,
				frames: figmaFrames)
		}
		XCTAssertEqual(swipe(150), centeredOffset(2), "two swipes up in a row are two steps")
		XCTAssertEqual(swipe(-150), centeredOffset(0), "a swipe back undoes the first one")
		XCTAssertEqual(swipe(10), centeredOffset(1), "a short touch stays on the paragraph it was heading to")

		// Down, then up before it stops: the origin is where the first one was heading, so up is back on 1.
		let downLive = centeredOffset(1) - 0.3 * (centeredOffset(1) - centeredOffset(0))
		let back = PlayerScroll.carouselOrigin(live: downLive, heading: centeredOffset(0), isMoving: true)
		XCTAssertEqual(back, centeredOffset(0))
		XCTAssertEqual(settle(back, travelling: 300), centeredOffset(1))
	}

	func testATouchAtRestOrWithoutAHeadingCountsFromTheLiveOffset() {
		XCTAssertEqual(PlayerScroll.carouselOrigin(live: -259, heading: nil, isMoving: true), -259)
		XCTAssertEqual(PlayerScroll.carouselOrigin(live: -259, heading: -77, isMoving: false), -259)
	}

	func testALongParagraphIsReadFreelyButAFlickGoesNoFurtherThanTheNextParagraph() {
		// A 900 high paragraph, then three short ones whose middles are 1041, 1295 and 1549.
		let frames = [
			PlayerItemFrame(minY: 0, height: 900), PlayerItemFrame(minY: 956, height: 170),
			PlayerItemFrame(minY: 1_182, height: 226), PlayerItemFrame(minY: 1_464, height: 170),
		]
		// The window centre (522) is inside the long paragraph: a short scroll is kept as proposed.
		XCTAssertEqual(settle(100, travelling: 200, in: frames), 300)
		// Proposed 1100 would land on the last paragraph; the next one is centred at 619.
		XCTAssertEqual(settle(100, travelling: 1_000, in: frames), 619)
		// Towards the start nothing comes before it: the snap alone settles on its middle.
		XCTAssertEqual(settle(100, travelling: -2_100, in: frames), 28)
	}

	func testAGestureThatBeginsOutsideALongParagraphStillStepsOneParagraph() {
		let frames = [PlayerItemFrame(minY: 0, height: 900), PlayerItemFrame(minY: 956, height: 170)]
		// The centre (1022) is on the short paragraph: a swipe up has nowhere further to go.
		XCTAssertEqual(settle(600, travelling: 100, in: frames), 619)
		// A swipe down goes to the middle of the long paragraph (450), where it can be read.
		XCTAssertEqual(settle(600, travelling: -200, in: frames), 28)
	}
}
