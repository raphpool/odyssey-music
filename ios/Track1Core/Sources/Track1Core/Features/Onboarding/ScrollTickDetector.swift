import CoreGraphics

/// Counts the rows that pass the top edge of the bottom action bar while a list scrolls, one haptic and sound
/// tick each (Figma `176:219`: "one light haptic tick each time a row passes behind the bottom button").
/// Pure so that the rule is testable without a scroll view; the screen only feeds it measurements.
public enum ScrollTickDetector {
	/// `rowMaxYs` are the bottom edges of the rows in the content's own coordinates, which do not move while
	/// scrolling. `previousOffset` and `newOffset` are how far the content has scrolled (a larger offset shows
	/// later rows), and `threshold` is the top edge of the bar in the scroll view's coordinates. A row is
	/// above the edge once its bottom edge is at or above it, and a row sitting exactly on the edge counts as
	/// above, so a row is never counted twice for the same position. Scrolling back counts the same crossings.
	/// A measurement that is not finite counts nothing: layout can report one before the first pass.
	public static func crossings(
		rowMaxYs: [CGFloat],
		previousOffset: CGFloat,
		newOffset: CGFloat,
		threshold: CGFloat
	) -> Int {
		guard previousOffset.isFinite, newOffset.isFinite, threshold.isFinite, previousOffset != newOffset
		else { return 0 }
		return rowMaxYs.reduce(0) { count, maxY in
			guard maxY.isFinite else { return count }
			let wasAbove = maxY - previousOffset <= threshold
			let isAbove = maxY - newOffset <= threshold
			return wasAbove == isAbove ? count : count + 1
		}
	}
}
