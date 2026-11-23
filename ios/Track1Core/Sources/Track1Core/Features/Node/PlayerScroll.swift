import Foundation

/// The frame of one player paragraph, in the coordinates of the scrolling content (not of the screen).
public struct PlayerItemFrame: Equatable, Sendable {
	public let minY: Double
	public let height: Double

	public init(minY: Double, height: Double) {
		self.minY = minY
		self.height = height
	}

	var midY: Double { minY + height / 2 }
	var maxY: Double { minY + height }
}

/// Which sentence of the player is at the centre of the screen, and where a scroll should settle (plan D3).
/// The view measures the paragraphs and feeds their frames in; everything here is pure, so `swift test`
/// covers it.
public enum PlayerScroll {
	/// A paragraph taller than this share of the window is read freely instead of being snapped to.
	public static let longItemRatio = 0.8

	/// The paragraph whose middle is nearest to the window centre (`offset + viewportHeight / 2`). On a tie the
	/// lowest index wins; nil without frames.
	public static func focusedIndex(offset: Double, viewportHeight: Double, frames: [PlayerItemFrame]) -> Int? {
		let center = offset + viewportHeight / 2
		var best: Int?
		var bestDistance = Double.infinity
		for (index, frame) in frames.enumerated() {
			let distance = abs(frame.midY - center)
			// Strict comparison: a later paragraph at the same distance must not take the focus.
			if distance < bestDistance {
				best = index
				bestDistance = distance
			}
		}
		return best
	}

	/// The offset where a scroll proposed at `proposed` should stop: the one that puts the middle of the
	/// targeted paragraph on the window centre. It may be negative, or run past the end of the content, so that
	/// the first and the last paragraph can be centred too (the view adds the margins).
	///
	/// A long paragraph (taller than `longItemRatio` of the window) is the exception: while the window centre
	/// is inside its bounds, `proposed` is kept so that it can be read by scrolling. That test looks at every
	/// long paragraph and not only at the focused one, because the focus is decided by middles: past the
	/// halfway point to a short neighbour the centre is still inside the long paragraph while the focus has
	/// already moved on, and snapping then would jump away from a sentence that is being read.
	public static func snapOffset(
		proposed: Double, viewportHeight: Double, frames: [PlayerItemFrame]
	) -> Double {
		guard let index = focusedIndex(offset: proposed, viewportHeight: viewportHeight, frames: frames) else {
			return proposed
		}
		let target = frames[index]
		let center = proposed + viewportHeight / 2
		let longHeight = viewportHeight * longItemRatio
		let isReadingLongItem = frames.contains { frame in
			frame.height > longHeight && frame.minY <= center && center <= frame.maxY
		}
		return isReadingLongItem ? proposed : target.midY - viewportHeight / 2
	}

	// MARK: carousel (TRA-801)

	/// A gesture that travels less than this share of the current paragraph's height settles back on it.
	public static let carouselThresholdRatio = 1.0 / 3

	/// Floor of that threshold, in points: a third of a one-line paragraph is a few points, which a resting
	/// finger covers without meaning to scroll.
	public static let carouselMinimumThreshold = 20.0

	/// The paragraph a carousel gesture settles on. `displacement` is how far the content was proposed to move
	/// from where the gesture began, positive towards the end of the content (a swipe up). Past the threshold
	/// the result is the next paragraph, or the previous one when negative, however long the displacement and
	/// whatever the speed behind it: a swipe is one step. Under the threshold, or without a usable
	/// displacement, it is `current`. The first and the last paragraph are the ends, never passed.
	public static func carouselIndex(
		from current: Int, displacement: Double, currentHeight: Double, count: Int
	) -> Int {
		guard count > 0 else { return current }
		let last = count - 1
		let from = min(max(current, 0), last)
		let threshold = max(currentHeight * carouselThresholdRatio, carouselMinimumThreshold)
		// A NaN displacement fails this comparison and stays on the current paragraph.
		guard abs(displacement) >= threshold else { return from }
		return displacement > 0 ? min(from + 1, last) : max(from - 1, 0)
	}

	/// The offset a gesture that begins now counts from, for `carouselOffset`. At rest it is `live`, the offset
	/// at the touch. A touch that lands while the scroll is still moving towards `heading`, the offset the last
	/// gesture was sent to, stops it between two paragraphs, where the nearest one may be the one it was
	/// leaving: the paragraph it was heading to is the one the reader has reached, so that is the origin. A
	/// scroll that is not `isMoving`, or that has no `heading`, has nothing to finish: `live` stays as is.
	public static func carouselOrigin(live: Double, heading: Double?, isMoving: Bool) -> Double {
		guard let heading, isMoving else { return live }
		return heading
	}

	/// The offset where a carousel gesture should stop: the one that puts the middle of the paragraph chosen by
	/// `carouselIndex` on the window centre. `origin` is the offset where the gesture began, which tells the
	/// paragraph the reader was on, and `proposed` where the scroll view would have stopped. As in `snapOffset`
	/// the result may be negative or run past the end of the content, and the view clamps it. `touchedAt` is the
	/// offset the finger landed at when it is not `origin`, a touch mid-flight: `proposed` is projected from
	/// there, so the displacement counts from there too.
	///
	/// A gesture that begins inside a long paragraph (see `longItemRatio`) is not a step: it is read freely, as
	/// `snapOffset` does, or that paragraph could only be crossed in one jump. It still goes no further than
	/// where the paragraph before or after the long one is centred, so that a flick is never more than a step.
	public static func carouselOffset(
		origin: Double, proposed: Double, touchedAt: Double? = nil, viewportHeight: Double,
		frames: [PlayerItemFrame]
	) -> Double {
		guard let current = focusedIndex(offset: origin, viewportHeight: viewportHeight, frames: frames) else {
			return proposed
		}
		let center = origin + viewportHeight / 2
		let longHeight = viewportHeight * longItemRatio
		let longIndex = frames.firstIndex { frame in
			frame.height > longHeight && frame.minY <= center && center <= frame.maxY
		}
		if let longIndex {
			let free = snapOffset(proposed: proposed, viewportHeight: viewportHeight, frames: frames)
			// No bound on the side of a long paragraph that is the first or the last one.
			let lower = longIndex > 0 ? frames[longIndex - 1].midY - viewportHeight / 2 : -Double.infinity
			let upper = longIndex < frames.count - 1 ? frames[longIndex + 1].midY - viewportHeight / 2 : .infinity
			return min(max(free, lower), upper)
		}
		let step = proposed - (touchedAt ?? origin)
		let height = frames[current].height
		let target = carouselIndex(from: current, displacement: step, currentHeight: height, count: frames.count)
		return frames[target].midY - viewportHeight / 2
	}
}
