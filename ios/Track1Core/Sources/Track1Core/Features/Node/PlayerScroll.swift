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
}
