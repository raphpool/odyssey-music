import Foundation

/// Progress bar rules (Figma `Progress bar` `175:56`, Doc `175:59`) kept apart from the view.
public enum ProgressFraction {
	/// A progress is a share of the track: 0...1. A value out of range is clamped (1.4 is full, -1 is empty)
	/// and a NaN counts as 0, so a backend that reports nonsense never draws outside the track.
	public static func clamped(_ value: Double) -> Double {
		guard !value.isNaN else { return 0 }
		return min(max(value, 0), 1)
	}

	/// The indeterminate sweep: a segment of `length` (share of the track) that enters on the left, crosses
	/// the track and leaves on the right as `phase` goes from 0 to 1. The result is clipped to the track,
	/// so `start` and `end` are always in 0...1 and `start <= end`.
	public static func sweep(phase: Double, length: Double) -> (start: Double, end: Double) {
		let share = clamped(length)
		let start = -share + LoopPhase.wrapped(phase) * (1 + share)
		return (clamped(start), clamped(start + share))
	}
}
