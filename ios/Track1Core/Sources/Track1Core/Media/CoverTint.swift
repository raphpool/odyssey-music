import Foundation

/// An sRGB colour, each channel in 0…1. The type name is the contract's (TRA-661); the components are
/// gamma-encoded sRGB, not linearised light.
public struct LinearRGB: Equatable, Sendable {
	public let red: Double
	public let green: Double
	public let blue: Double

	public init(red: Double, green: Double, blue: Double) {
		self.red = red
		self.green = green
		self.blue = blue
	}
}

/// The colours a node page paints behind its hero, derived from the cover (plan Part 2, decision D2).
public struct CoverTint: Equatable, Sendable {
	/// Three gradient stops, top to bottom, at `CoverTintTone.stopPositions`.
	public let stops: [LinearRGB]
	/// The glow under the hero case and disc.
	public let shadow: LinearRGB

	public init(stops: [LinearRGB], shadow: LinearRGB) {
		self.stops = stops
		self.shadow = shadow
	}
}

/// Maps the three colour bands of a cover (top, middle, bottom) onto a fixed brightness scale (`Scale`; the
/// "Background · cover tint" spec for `.page`). Only the hue and the saturation of a band survive, so every
/// cover gets the same ground whatever its own luminosity.
///
/// The constants are the HSB reading of the Cosmogramma references (plan annex A.2); they are Raphael's to
/// judge on a device, so they are not tuned here.
public enum CoverTintTone {
	/// Where each stop sits along the background, as a fraction of its height.
	public static let stopPositions: [Double] = [0, 0.13, 0.27]
	/// Where the gradient reaches the page background token.
	public static let endpointPosition: Double = 0.50
	/// The brightness and saturation ceiling a screen paints a cover with.
	public struct Scale: Equatable, Sendable {
		/// The B of HSB (`max(r, g, b)`) of each stop, top to bottom; always three values, strictly decreasing.
		public let stopBrightness: [Double]
		/// A band more saturated than this is pulled down to it, so a vivid cover never floods the screen.
		public let saturationMax: Double

		/// The dark, low-contrast ground of the node page and its card.
		public static let page = Scale(stopBrightness: [0.33, 0.27, 0.20], saturationMax: 0.35)

		/// Brighter and more saturated than `.page`: the player is full screen, so the cover has to show through
		/// (brief of 2026-11-25, decision D2, TRA-832). The values are Raphael's to tune on a device.
		public static let player = Scale(stopBrightness: [0.46, 0.38, 0.30], saturationMax: 0.60)
	}

	/// The node-page scale, kept so existing readers of the constants see no change.
	public static let stopBrightness: [Double] = Scale.page.stopBrightness
	public static let saturationMax: Double = Scale.page.saturationMax
	public static let shadowBrightness: Double = 0.53
	/// The glow is livelier than the stop it sits above: the first band's saturation is multiplied by this.
	public static let shadowSaturationGain: Double = 1.65

	/// `nil` unless `bands` holds exactly three colours.
	public static func tint(bands: [LinearRGB], scale: Scale = .page) -> CoverTint? {
		guard bands.count == scale.stopBrightness.count, let first = bands.first else { return nil }

		let stops = zip(bands, scale.stopBrightness).map { band, brightness -> LinearRGB in
			let hsb = HSB(band)
			return HSB(hue: hsb.hue, saturation: min(hsb.saturation, scale.saturationMax), brightness: brightness).rgb
		}
		let lead = HSB(first)
		let shadow = HSB(
			hue: lead.hue,
			saturation: min(lead.saturation * shadowSaturationGain, scale.saturationMax),
			brightness: shadowBrightness
		).rgb
		return CoverTint(stops: stops, shadow: shadow)
	}
}

/// RGB ↔ HSB, kept here so the package needs no UIKit. Hue is a fraction of the circle, in 0..<1.
private struct HSB {
	let hue: Double
	let saturation: Double
	let brightness: Double

	init(hue: Double, saturation: Double, brightness: Double) {
		self.hue = hue
		self.saturation = saturation
		self.brightness = brightness
	}

	/// The hue of a grey is undefined; it reads as 0.
	init(_ color: LinearRGB) {
		let red = Self.clamp(color.red)
		let green = Self.clamp(color.green)
		let blue = Self.clamp(color.blue)
		let top = max(red, green, blue)
		let delta = top - min(red, green, blue)

		var sector = 0.0
		if delta > 0 {
			if top == red {
				sector = ((green - blue) / delta).truncatingRemainder(dividingBy: 6)
			} else if top == green {
				sector = (blue - red) / delta + 2
			} else {
				sector = (red - green) / delta + 4
			}
		}
		let turn = sector / 6
		self.hue = turn < 0 ? turn + 1 : turn
		self.saturation = top == 0 ? 0 : delta / top
		self.brightness = top
	}

	var rgb: LinearRGB {
		let chroma = brightness * saturation
		let sector = hue * 6
		let second = chroma * (1 - abs(sector.truncatingRemainder(dividingBy: 2) - 1))
		let floor = brightness - chroma
		let red: Double
		let green: Double
		let blue: Double
		switch Int(sector) % 6 {
		case 0: (red, green, blue) = (chroma, second, 0)
		case 1: (red, green, blue) = (second, chroma, 0)
		case 2: (red, green, blue) = (0, chroma, second)
		case 3: (red, green, blue) = (0, second, chroma)
		case 4: (red, green, blue) = (second, 0, chroma)
		default: (red, green, blue) = (chroma, 0, second)
		}
		return LinearRGB(red: red + floor, green: green + floor, blue: blue + floor)
	}

	private static func clamp(_ value: Double) -> Double {
		min(max(value, 0), 1)
	}
}
