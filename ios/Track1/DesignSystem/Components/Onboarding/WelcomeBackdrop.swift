import SwiftUI
import Track1Core

/// Figma `Welcome backdrop` (`175:66`, Doc `175:68`, motion spec `176:69`): the full-screen color field
/// behind screen 1.1. It is a slowly morphing gradient (amber, rose, violet, "like a James Turrell
/// installation") that loops every 30 s without a cut. Under Reduce Motion it stays on the Figma frame.
/// A dark veil keeps `colorTextPrimary` at 4.5:1 or more over the lightest color of the field.
/// It is decorative and absolute: put it behind the content, never in the layout flow. It draws only
/// gradients, so it loads no image and has no URL to validate.
struct WelcomeBackdrop: View {
	/// Doc `175:68`: "Loop 30-60s, no hard cuts". 45 s until TRA-724 (2026-11-17): the note `362:4993` of the
	/// v1 mock-up asks to speed the background up slightly, and 30 s is the floor of the Doc's range.
	static let loopDuration: TimeInterval = 30
	/// The gradient is an ellipse as in the Figma frame: wide, so the side edges stay mid-tone while the top
	/// and bottom edges light up. It is drawn on a canvas this many times as wide as the screen, centered.
	private static let canvasWidthRatio: CGFloat = 2.4
	/// Center of the gradient in the 393 x 852 Figma frame (196, 405).
	private static let center = UnitPoint(x: 0.5, y: 405.0 / 852.0)
	/// Vertical radius, as a share of the height: the farthest vertical edge (bottom, 447 pt) is 0.52 high.
	private static let radiusFraction: CGFloat = 0.52

	/// A 30 s morph needs no more than 15 images a second: the color moves by at most about 1.7 levels of
	/// 8-bit between two of them (3 / 450 of the range), and the gradient is costly to draw.
	private static let frameInterval: TimeInterval = 1.0 / 15

	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	/// The loop starts on the Figma frame when the backdrop appears, not at an arbitrary point of the clock.
	@State private var start = Date()

	var body: some View {
		Group {
			if reduceMotion {
				field(phase: 0)
			} else {
				TimelineView(.animation(minimumInterval: Self.frameInterval)) { context in
					field(phase: WelcomeBackdropPalette.phase(elapsed: context.date.timeIntervalSince(start)))
				}
			}
		}
		.ignoresSafeArea()
		.allowsHitTesting(false)
		.accessibilityHidden(true)
	}

	private func field(phase: Double) -> some View {
		let colors = WelcomeBackdropPalette.colors(at: phase)
		return GeometryReader { proxy in
			ZStack {
				EllipticalGradient(
					stops: [
						.init(color: colors[0], location: 0),
						.init(color: colors[1], location: 0.5),
						.init(color: colors[2], location: 1),
					],
					center: Self.center, startRadiusFraction: 0, endRadiusFraction: Self.radiusFraction
				)
				.frame(width: proxy.size.width * Self.canvasWidthRatio, height: proxy.size.height)
				Rectangle().fill(Track1Tokens.colorBackgroundBase.opacity(WelcomeBackdropPalette.overlayOpacity))
			}
			.frame(width: proxy.size.width, height: proxy.size.height)
			.clipped()
		}
	}
}

/// The colors of the Welcome backdrop. The three Figma colors form a ring, amber, rose then violet, and each
/// gradient stop walks that ring one step apart: at phase 0 the field is the Figma frame, and at phase 1 it
/// is back on it, so the loop has no cut. The values are art direction (Doc `175:68` binds no token to
/// them): they were sampled from the rendering of `175:66` on 2026-10-13.
enum WelcomeBackdropPalette {
	/// Ring order, as in the Doc: amber, then rose, then violet.
	static let amber = RGB(hex: 0xFAD481)
	static let rose = RGB(hex: 0x6A3D36)
	static let violet = RGB(hex: 0x64394C)
	private static let ring = [amber, rose, violet]
	/// Ring offset of each stop (center, middle, edge) at phase 0: violet in the middle of the frame, rose
	/// around it and amber on the top and bottom edges.
	private static let stopOffsets = [2, 1, 0]

	/// Opacity of the `colorBackgroundBase` veil drawn over the field. Over the lightest color of the
	/// palette (amber) it leaves `colorTextPrimary` a contrast of 5.7:1 (1.2:1 without the veil), above the
	/// 4.5:1 floor. `BackdropTests` re-checks it for every phase of the loop.
	static let overlayOpacity: Double = 0.62

	/// The stops (center, middle, edge) at `phase` of the loop, as pure colors.
	static func rgbStops(at phase: Double) -> [RGB] {
		stopOffsets.map { ColorCycle.color(at: phase, ring: ring, offset: $0) }
	}

	/// The stops (center, middle, edge) at `phase`, continuous, with `colors(at: 0) == colors(at: 1)`. A
	/// phase out of 0...1 wraps.
	static func colors(at phase: Double) -> [Color] {
		rgbStops(at: phase).map { Color(.sRGB, red: $0.red, green: $0.green, blue: $0.blue, opacity: 1) }
	}

	/// The phase (0...1) of the loop after `elapsed` seconds.
	static func phase(elapsed: TimeInterval) -> Double {
		LoopPhase.wrapped(elapsed / WelcomeBackdrop.loopDuration)
	}
}
