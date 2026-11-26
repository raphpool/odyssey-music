import Foundation

/// The slow drift of the ambient cover backdrop (TRA-829): the zoomed, blurred cover moves along a
/// figure-eight, like the YouTube background on Chromecast. This is the pure side of the kinematics: the app
/// reads `offset(phase:)` and applies it, and the rules (loop without a cut, bounds, continuity) are tested
/// here without SwiftUI.
public enum AmbientDrift {
	/// One loop of the drift. 60 s: "very slowly", the movement must be felt more than seen (decision D3 of
	/// `docs/plans/home-ambient-cover-background.md`, validated 2026-11-25; tuned on a device in ticket 1.2).
	public static let loopDuration: TimeInterval = 60

	/// Half-extent of the drift, in points of the screen: x then y. The backdrop zoom must overflow the screen
	/// by at least this much plus the blur radius, so the drift never shows an edge (see
	/// `AmbientCoverBackdropMetrics.overflow(side:)`).
	public static let amplitude: (x: Double, y: Double) = (x: 24, y: 16)

	/// The position (0..<1) in the loop after `elapsed` seconds. `LoopPhase` makes any input defined.
	public static func phase(elapsed: TimeInterval) -> Double {
		LoopPhase.wrapped(elapsed / loopDuration)
	}

	/// A figure-eight (Lissajous 1:2): `x = amplitude.x * sin(2πφ)`, `y = amplitude.y * sin(4πφ)`. It is
	/// (0, 0) at phase 0, and the same point at phase 0 and 1, so the loop has no cut. It stays within the
	/// amplitude. `phase` wraps (see `LoopPhase`): a NaN or an infinity is the center.
	public static func offset(phase: Double) -> (x: Double, y: Double) {
		let angle = 2 * Double.pi * LoopPhase.wrapped(phase)
		return (x: amplitude.x * sin(angle), y: amplitude.y * sin(2 * angle))
	}
}
