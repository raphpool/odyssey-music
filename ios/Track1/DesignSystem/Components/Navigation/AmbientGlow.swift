import SwiftUI
import UIKit

/// Figma `Ambient glow` (`173:42`, doc `173:44`): the light that leaks from the top edge of a screen and
/// fades into `colorBackgroundBase`. It is absolute and decorative: put it behind the content (a
/// `.background` that ignores the top safe area), never in the layout flow. The Turrell drift of the Doc is
/// a bonus outside V1: the glow is static, so Reduce Motion needs no special case.
struct AmbientGlow: View {
	/// `ember` and `silver` are the two Figma variants (`173:30`, `173:36`). `tinted` follows the dominant
	/// color of a cover (the Doc: "glow colors adapt to specific element colors").
	enum Tone: Equatable {
		case ember, silver
		case tinted(Color)
	}

	/// Frame of the Figma component, in points. Positions and radii below are drawn on it and scaled to the
	/// size the glow is given.
	private static let figmaSize = CGSize(width: 393, height: 280)

	/// One radial gradient, as drawn in the Figma component (centre and radii in `figmaSize` points).
	private struct Blob {
		let centerX: CGFloat
		let centerY: CGFloat
		let radiusX: CGFloat
		let radiusY: CGFloat
	}

	/// Same order as `AmbientGlowPalette.stops`: left, right, top.
	private static let blobs = [
		Blob(centerX: 90, centerY: 40, radiusX: 150, radiusY: 140),
		Blob(centerX: 320, centerY: 10, radiusX: 160, radiusY: 130),
		Blob(centerX: 200, centerY: 10, radiusX: 120, radiusY: 90),
	]

	/// The fade to the background covers the bottom 180 of the 280 pt (`y` 100 to 280), the grain the top 180.
	private static let layerHeightRatio: CGFloat = 180 / 280
	/// The Figma grain layer is 10 % (doc `173:55`).
	static let grainOpacity = 0.1

	@Environment(\.displayScale) private var displayScale
	private let tone: Tone
	private let height: CGFloat

	init(tone: Tone, height: CGFloat = 280) {
		self.tone = tone
		self.height = height
	}

	var body: some View {
		GeometryReader { proxy in
			let scaleX = proxy.size.width / Self.figmaSize.width
			let scaleY = proxy.size.height / Self.figmaSize.height
			let stops = AmbientGlowPalette.stops(for: tone)
			ZStack(alignment: .topLeading) {
				ForEach(Array(Self.blobs.enumerated()), id: \.offset) { index, blob in
					glow(blob, color: stops[index], scaleX: scaleX, scaleY: scaleY)
				}
				LinearGradient(
					colors: [Track1Tokens.colorBackgroundBase.opacity(0), Track1Tokens.colorBackgroundBase],
					startPoint: .top, endPoint: .bottom
				)
				.frame(height: proxy.size.height * Self.layerHeightRatio)
				.frame(maxHeight: .infinity, alignment: .bottom)
				// One noise pixel per device pixel: at scale 1 a 3x screen would show 3 x 3 px blocks.
				Image(decorative: AmbientGlowGrain.image, scale: displayScale)
					.resizable(resizingMode: .tile)
					.opacity(Self.grainOpacity)
					.frame(height: proxy.size.height * Self.layerHeightRatio)
			}
			.frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
			.clipped()
		}
		.frame(height: height)
		.allowsHitTesting(false)
		.accessibilityHidden(true)
	}

	/// SwiftUI radial gradients are circular: a circle of the horizontal radius, squashed to the vertical one.
	private func glow(_ blob: Blob, color: Color, scaleX: CGFloat, scaleY: CGFloat) -> some View {
		// A zero width (first layout pass, collapsed parent) must not divide by zero below.
		let radius = max(blob.radiusX * scaleX, 1)
		return Circle()
			.fill(
				RadialGradient(
					colors: [color, color.opacity(0)], center: .center, startRadius: 0, endRadius: radius)
			)
			.frame(width: radius * 2, height: radius * 2)
			.scaleEffect(x: 1, y: (blob.radiusY * scaleY) / radius)
			.position(x: blob.centerX * scaleX, y: blob.centerY * scaleY)
	}
}

/// The 3 gradient colors of an `AmbientGlow` tone, in the order left, right, top, with their opacity.
/// They are fixed art direction values: the Doc says they are not tokens (`173:55`), hence the raw values.
enum AmbientGlowPalette {
	/// Brightness and opacity of the 3 glows of a tinted tone (left, right, top). The hue and saturation
	/// come from the cover color, so that a dark cover still lights up the screen in its own hue.
	static let tintedLevels: [(brightness: Double, opacity: Double)] = [
		(brightness: 0.90, opacity: 0.55),
		(brightness: 0.75, opacity: 0.45),
		(brightness: 1.00, opacity: 0.38),
	]

	static func stops(for tone: AmbientGlow.Tone) -> [Color] {
		switch tone {
		case .ember:
			[srgb(0xE7632D, opacity: 0.55), srgb(0xF2642D, opacity: 0.45), srgb(0xE6A23A, opacity: 0.38)]
		case .silver:
			[srgb(0xF8FAFA, opacity: 0.50), srgb(0x5D7FA8, opacity: 0.40), srgb(0xE6A23A, opacity: 0.38)]
		case .tinted(let tint):
			tinted(tint)
		}
	}

	private static func tinted(_ tint: Color) -> [Color] {
		var hue: CGFloat = 0
		var saturation: CGFloat = 0
		// A color that has no HSB form keeps the default 0 / 0: a neutral glow rather than a crash.
		_ = UIColor(tint).getHue(&hue, saturation: &saturation, brightness: nil, alpha: nil)
		return tintedLevels.map {
			Color(hue: Double(hue), saturation: Double(saturation), brightness: $0.brightness, opacity: $0.opacity)
		}
	}

	private static func srgb(_ value: UInt32, opacity: Double) -> Color {
		Color(
			.sRGB,
			red: Double((value >> 16) & 0xFF) / 255,
			green: Double((value >> 8) & 0xFF) / 255,
			blue: Double(value & 0xFF) / 255,
			opacity: opacity)
	}
}

/// The grain of the glow (Figma `Grain`, 10 %): a small noise tile, generated once and cached, then tiled.
/// The noise is seeded, so two launches draw the same texture and the glow never flickers between them.
enum AmbientGlowGrain {
	static let tileSide = 128
	private static let seed: UInt64 = 0x2026_1013

	/// Black pixels, opaque or transparent at random (RGBA, premultiplied: a transparent pixel is all 0).
	static func pixels(side: Int = tileSide, seed: UInt64 = seed) -> [UInt8] {
		var generator = SplitMix64(state: seed)
		var bytes = [UInt8](repeating: 0, count: side * side * 4)
		for pixel in 0..<(side * side) where generator.next() & 1 == 1 {
			bytes[pixel * 4 + 3] = 255
		}
		return bytes
	}

	/// A `static let` is initialized once, thread-safely, on first use: that is the cache.
	static let image: CGImage = makeImage()

	private static func makeImage() -> CGImage {
		let side = tileSide
		let data = Data(pixels(side: side))
		guard
			let provider = CGDataProvider(data: data as CFData),
			let image = CGImage(
				width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: side * 4,
				space: CGColorSpaceCreateDeviceRGB(),
				bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
				provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
		else { preconditionFailure("A 128 x 128 RGBA8 buffer always makes a CGImage") }
		return image
	}
}

/// Small deterministic generator (SplitMix64): `SystemRandomNumberGenerator` cannot be seeded.
private struct SplitMix64: RandomNumberGenerator {
	var state: UInt64

	mutating func next() -> UInt64 {
		state &+= 0x9E37_79B9_7F4A_7C15
		var z = state
		z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
		z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
		return z ^ (z >> 31)
	}
}
