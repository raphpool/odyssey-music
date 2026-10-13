import SwiftUI
import Track1Core

/// Figma `Progress bar` (`175:56`, Doc `175:59`): the bar shown while the first daily recommendation is
/// prepared. Determinate when the backend reports steps, otherwise an indeterminate sweep that loops.
/// The width fills its parent (the Figma frame is 320 pt, a width the screens give it).
struct Track1ProgressBar: View {
	enum Mode: Equatable {
		case indeterminate
		/// A share of the track. Out of range it is clamped: `determinate(1.4)` is full, `determinate(-1)` empty.
		case determinate(Double)

		/// The clamped share of a determinate bar, `nil` while the progress is unknown.
		var fraction: Double? {
			switch self {
			case .indeterminate: nil
			case .determinate(let value): ProgressFraction.clamped(value)
			}
		}
	}

	/// Figma sizes with no token (the Foundations frames have no 24 pt size nor 1 pt border): the track is
	/// 24 pt high with a 1 pt border (`175:56`).
	static let height: CGFloat = 24
	static let borderWidth: CGFloat = 1
	/// Doc `175:59`: "loop an indeterminate sweep (1.2s)".
	static let sweepDuration: TimeInterval = 1.2
	/// Share of the track the sweep covers, and the share a static indeterminate bar shows under Reduce
	/// Motion: the Figma indicator is 99 pt of the 320 pt track.
	static let partialFraction = 99.0 / 320.0

	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	private let mode: Mode
	private let accessibilityLabel: String

	init(mode: Mode, accessibilityLabel: String = "Progression") {
		self.mode = mode
		self.accessibilityLabel = accessibilityLabel
	}

	/// Where the sweep is in its loop (0...1) at `date`.
	static func sweepPhase(at date: Date) -> Double {
		let loops = date.timeIntervalSinceReferenceDate / sweepDuration
		return loops - loops.rounded(.down)
	}

	/// The part of the track the indicator covers, as shares of the track width (0...1, `start <= end`).
	/// A determinate bar grows from the left. An indeterminate one sweeps across, or, under Reduce Motion,
	/// stays a partial bar.
	static func segment(mode: Mode, phase: Double, reduceMotion: Bool) -> (start: Double, end: Double) {
		switch mode {
		case .determinate(let value):
			return (0, ProgressFraction.clamped(value))
		case .indeterminate:
			guard !reduceMotion else { return (0, partialFraction) }
			return ProgressFraction.sweep(phase: phase, length: partialFraction)
		}
	}

	var body: some View {
		Group {
			if mode == .indeterminate && !reduceMotion {
				TimelineView(.animation) { context in
					track(phase: Self.sweepPhase(at: context.date))
				}
			} else {
				track(phase: 0)
					// Width changes take 200 ms (Doc); the sweep is driven by the clock, never by this.
					.animation(Track1Motion.animation(.standard, reduceMotion: reduceMotion), value: mode)
			}
		}
		.frame(height: Self.height)
		.overlay(Rectangle().strokeBorder(Track1Tokens.colorProgressTrack, lineWidth: Self.borderWidth))
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(accessibilityLabel)
		.accessibilityValue(mode.fraction.map { "\(Int(($0 * 100).rounded())) %" } ?? "")
	}

	private func track(phase: Double) -> some View {
		let segment = Self.segment(mode: mode, phase: phase, reduceMotion: reduceMotion)
		return GeometryReader { proxy in
			Rectangle()
				.fill(Track1Tokens.colorProgressIndicator)
				.frame(width: proxy.size.width * (segment.end - segment.start))
				.offset(x: proxy.size.width * segment.start)
		}
		.clipped()
	}
}
