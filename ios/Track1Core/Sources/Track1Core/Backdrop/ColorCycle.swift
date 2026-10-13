import Foundation

/// An opaque sRGB color, components in 0...1. It is the pure side of the Welcome backdrop palette: the app
/// turns it into a `Color`, and the rules (loop, contrast) are tested here without SwiftUI.
public struct RGB: Equatable, Sendable {
	public let red: Double
	public let green: Double
	public let blue: Double

	public init(red: Double, green: Double, blue: Double) {
		self.red = red
		self.green = green
		self.blue = blue
	}

	/// `0xRRGGBB`.
	public init(hex: UInt32) {
		self.init(
			red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
			blue: Double(hex & 0xFF) / 255)
	}

	/// Linear mix in sRGB space (what the gradient the user sees is made of), `amount` 0 gives `self`.
	public func mixed(with other: RGB, amount: Double) -> RGB {
		RGB(
			red: red + (other.red - red) * amount, green: green + (other.green - green) * amount,
			blue: blue + (other.blue - blue) * amount)
	}
}

/// The position in a loop (0..<1) of any number: 1 is 0, 1.25 is 0.25, -0.25 is 0.75, and a NaN or an
/// infinity counts as 0. One definition for every looping animation of the design system.
public enum LoopPhase {
	public static func wrapped(_ value: Double) -> Double {
		guard value.isFinite else { return 0 }
		let result = value - value.rounded(.down)
		// A tiny negative value rounds to exactly 1 once subtracted: it is 0 on the loop.
		return result >= 1 ? 0 : result
	}
}

/// A closed loop of colors: `color(at:)` walks the ring once as `phase` goes from 0 to 1 and ends on the
/// color it started from, so a looping animation never has a hard cut.
public enum ColorCycle {
	/// `phase` wraps (see `LoopPhase`), so the result is defined for any input. `offset` starts the walk on
	/// another ring color: several stops share one ring at different offsets.
	public static func color(at phase: Double, ring: [RGB], offset: Int = 0) -> RGB {
		precondition(!ring.isEmpty, "A color cycle needs at least one color")
		let position = LoopPhase.wrapped(phase) * Double(ring.count)
		let segment = Int(position.rounded(.down))
		let fraction = position - Double(segment)
		// A negative offset walks the ring backwards from the start: the index stays in range.
		let start = ((segment + offset) % ring.count + ring.count) % ring.count
		let from = ring[start]
		let to = ring[(start + 1) % ring.count]
		return from.mixed(with: to, amount: fraction)
	}
}

/// WCAG 2.x contrast, to prove a text color stays readable on a moving background.
public enum WCAGContrast {
	/// Relative luminance of an sRGB color (WCAG 2.x definition).
	public static func relativeLuminance(_ color: RGB) -> Double {
		func linear(_ component: Double) -> Double {
			component <= 0.04045 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
		}
		return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
	}

	/// Contrast ratio, from 1 (same luminance) to 21 (black on white), whatever the argument order.
	public static func ratio(_ first: RGB, _ second: RGB) -> Double {
		let lights = [relativeLuminance(first), relativeLuminance(second)]
		return ((lights.max() ?? 0) + 0.05) / ((lights.min() ?? 0) + 0.05)
	}

	/// What a viewer sees of `overlay` drawn at `opacity` over `background` (alpha compositing in sRGB, as
	/// SwiftUI does). An opacity out of 0...1 is clamped, so the result stays a real sRGB color.
	public static func composite(_ overlay: RGB, opacity: Double, over background: RGB) -> RGB {
		background.mixed(with: overlay, amount: ProgressFraction.clamped(opacity))
	}
}
