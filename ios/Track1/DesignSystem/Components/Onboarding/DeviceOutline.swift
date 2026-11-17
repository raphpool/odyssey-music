import SwiftUI

/// Measurements of the iPhone outline that stages the notification preview on the opt-in screen, read on
/// 2026-11-17 from Figma `317:5225` (TRA-740). Each layer sits at its position in the 275 x 584.971 frame.
/// The home indicator the Figma frame also holds (`#B9BABE`, at y 560.33) is not drawn: the ticket keeps it
/// out of the visible part of the scene.
enum DeviceOutlineMetrics {
	/// A rounded rectangle placed from the top left corner of the frame.
	struct Layer: Equatable, Sendable {
		let x: CGFloat
		let y: CGFloat
		let width: CGFloat
		let height: CGFloat
		let cornerRadius: CGFloat
	}

	/// A Figma drop shadow: black at `opacity`, no horizontal offset.
	struct Shadow: Equatable, Sendable {
		let opacity: Double
		let y: CGFloat
		let blur: CGFloat
		let spread: CGFloat
	}

	static let width: CGFloat = 275
	static let height: CGFloat = 584.971

	static let deviceBody = Layer(x: 2.38, y: 0, width: 270.231, height: 584.971, cornerRadius: 44.509)
	static let bezel = Layer(x: 6.36, y: 3.97, width: 262.283, height: 577.023, cornerRadius: 40.535)
	static let screen = Layer(x: 12.72, y: 10.33, width: 249.566, height: 564.306, cornerRadius: 35.766)
	static let island = Layer(x: 96.17, y: 21.46, width: 82.659, height: 23.049, cornerRadius: 15.896)

	static let bodyColor = Track1Tokens.colorIconSecondary
	static let bezelColor = Track1Tokens.colorSurfaceDefault
	static let screenColor = Track1Tokens.colorBackgroundElevated
	static let islandColor = Track1Tokens.colorSurfacePressed

	/// The two shadows of the body, the first one drawn first.
	static let bodyShadows = [
		Shadow(opacity: 0.05, y: 1.59, blur: 3.179, spread: 0),
		Shadow(opacity: 0.1, y: 4.769, blur: 12.717, spread: -1.59),
	]

	/// The outline is staging only: VoiceOver skips it and reads the notification preview next to it.
	static let isAccessibilityHidden = true
}

/// Stylised iPhone (Figma `Device outline`, `317:5225`): a body, a bezel, a blank screen and the dynamic
/// island, all drawn from the tokens. It is decorative and has a fixed size, the one of the mock-up.
struct DeviceOutline: View {
	private typealias Metrics = DeviceOutlineMetrics

	init() {}

	var body: some View {
		ZStack(alignment: .topLeading) {
			ForEach(Array(Metrics.bodyShadows.enumerated()), id: \.offset) { _, shadow in
				shadowCaster(shadow)
			}
			layer(Metrics.deviceBody, fill: Metrics.bodyColor)
			layer(Metrics.bezel, fill: Metrics.bezelColor)
			layer(Metrics.screen, fill: Metrics.screenColor)
			layer(Metrics.island, fill: Metrics.islandColor)
		}
		.frame(width: Metrics.width, height: Metrics.height, alignment: .topLeading)
		.accessibilityHidden(Metrics.isAccessibilityHidden)
	}

	private func layer(_ layer: Metrics.Layer, fill: Color) -> some View {
		RoundedRectangle(cornerRadius: layer.cornerRadius, style: .continuous)
			.fill(fill)
			.frame(width: layer.width, height: layer.height)
			.offset(x: layer.x, y: layer.y)
	}

	/// SwiftUI has no shadow spread, and its radius is half the Figma blur (as in `NodeHero`). The shadow is
	/// cast by the body grown by `spread` on each side, which is inside the body for the negative spread of
	/// the second shadow: the body is drawn over it, so only the shadow shows.
	private func shadowCaster(_ shadow: Metrics.Shadow) -> some View {
		let casting = Metrics.deviceBody
		let spread = shadow.spread
		let radius = max(casting.cornerRadius + spread, 0)
		return RoundedRectangle(cornerRadius: radius, style: .continuous)
			.fill(Metrics.bodyColor)
			.frame(width: casting.width + 2 * spread, height: casting.height + 2 * spread)
			.shadow(color: .black.opacity(shadow.opacity), radius: shadow.blur / 2, x: 0, y: shadow.y)
			.offset(x: casting.x - spread, y: casting.y - spread)
	}
}

#Preview("Device outline") {
	DeviceOutline()
		.padding()
		.background(Track1Tokens.colorBackgroundBase)
}
