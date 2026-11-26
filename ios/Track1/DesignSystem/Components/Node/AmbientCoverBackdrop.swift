import SwiftUI
import Track1Core

/// Brief of 2026-11-25 (TRA-829), no Figma node: the cover of the node of the day, zoomed in, blurred and
/// drifting very slowly under a dark veil, as the YouTube background on Chromecast. The cover is the only
/// source of color, so the home takes the mood of the day's node.
/// It is decorative and absolute: put it behind the content, never in the layout flow. The image is given by
/// the caller, so the backdrop loads nothing and has no URL to validate. Under Reduce Motion it stays still,
/// on the centered frame. The kinematics (loop, offset) are `AmbientDrift`, in `Track1Core`.
struct AmbientCoverBackdrop: View {
	private typealias Metrics = AmbientCoverBackdropMetrics

	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	/// The drift starts at the center when the backdrop appears, not at an arbitrary point of the clock.
	@State private var start = Date()
	private let cover: Image

	init(cover: Image) {
		self.cover = cover
	}

	var body: some View {
		// Under Reduce Motion the timeline is paused, so it draws once: the phase must be forced to 0 too.
		TimelineView(.animation(minimumInterval: Metrics.frameInterval, paused: reduceMotion)) { context in
			field(phase: reduceMotion ? 0 : AmbientDrift.phase(elapsed: context.date.timeIntervalSince(start)))
		}
		.ignoresSafeArea()
		.allowsHitTesting(false)
		.accessibilityHidden(true)
	}

	private func field(phase: Double) -> some View {
		let offset = AmbientDrift.offset(phase: phase)
		return GeometryReader { proxy in
			// Blur first, at layout size, then zoom: the blur is rendered once at the size of the screen and
			// the zoom is a Core Animation transform, not a larger blur. `opaque: true` keeps the edge of the
			// blur from fading to transparent.
			cover
				.resizable()
				.scaledToFill()
				.frame(width: proxy.size.width, height: proxy.size.height)
				.blur(radius: Metrics.blurRadius, opaque: true)
				.scaleEffect(Metrics.zoom)
				.offset(x: CGFloat(offset.x), y: CGFloat(offset.y))
				.frame(width: proxy.size.width, height: proxy.size.height)
				.clipped()
				.overlay(LinearGradient(stops: Metrics.veilStops(), startPoint: .top, endPoint: .bottom))
		}
	}
}

/// The values of the ambient cover backdrop. They are decisions D3 to D5 of
/// `docs/plans/home-ambient-cover-background.md` (part 1), validated on 2026-11-25 and tuned on a device in
/// ticket 1.2 of the same project (the one that wires the backdrop into the home). If you change one, check
/// the margin invariant and the contrast proof in `AmbientCoverBackdropTests`.
enum AmbientCoverBackdropMetrics {
	/// The zoom that makes the cover a field of color and not a picture: the image is far enough from the
	/// cover shown sharp on the home that nobody mistakes one for the other. 1.7 and not the 1.6 of the plan
	/// (2026-11-26, TRA-829): the blur is zoomed too, so its edge band is `blurRadius * zoom` wide on screen,
	/// and at 1.6 the drift showed about 8 pt of it on a 393 pt wide screen.
	static let zoom: CGFloat = 1.7
	/// Applied before the zoom (see `AmbientCoverBackdrop`), so it is a 64 pt blur at layout size and
	/// `blurRadius * zoom` once zoomed: strong enough to erase the cover's details and leave only its colors.
	static let blurRadius: CGFloat = 64
	/// A 60 s drift needs no more than 15 images a second: it moves by less than 0.25 pt between two of them
	/// (`AmbientDriftTests`), and a full-screen blur is costly. The same rate as `WelcomeBackdrop`.
	static let frameInterval: TimeInterval = 1.0 / 15

	/// Opacity of the `colorBackgroundElevated` veil at the top of the screen, over the block that holds the
	/// date and the genres. Over a pure white cover it leaves `colorTextPrimary` a contrast above 4.5:1
	/// (`AmbientCoverBackdropTests` computes it), the worst case of a bright cover.
	static let veilTopOpacity: Double = 0.65
	/// Opacity of the veil from `veilTextStop` down, under the title and the subtitle. Over a pure white cover
	/// it leaves `colorTextSecondary`, the dimmer text, a contrast above 4.5:1, which is why it is darker than
	/// the top (`colorTextSecondary` over white alone is under 4.5:1).
	static let veilBottomOpacity: Double = 0.80
	/// Share of the height where the veil reaches its bottom opacity: before the title, which starts after the
	/// cover, the type and the spacings of the main block (`AmbientCoverBackdropTests` checks it against
	/// `TodayHomeMetrics`), and after the top of the main block so the top block is not darkened at the max.
	static let veilTextStop: CGFloat = 0.62
	/// The frame the margin invariant is drawn on: the Figma frame of the home (393 x 844).
	static let designSize = CGSize(width: 393, height: 844)

	/// Three stops of `colorBackgroundElevated`: the top opacity at 0, the bottom opacity at `veilTextStop`
	/// and at 1. The veil is neutral, not tinted by the cover: the contrast proof does not depend on the cover.
	static func veilStops() -> [Gradient.Stop] {
		let color = Track1Tokens.colorBackgroundElevated
		return [
			Gradient.Stop(color: color.opacity(veilTopOpacity), location: 0),
			Gradient.Stop(color: color.opacity(veilBottomOpacity), location: veilTextStop),
			Gradient.Stop(color: color.opacity(veilBottomOpacity), location: 1),
		]
	}

	/// How far the zoomed image overflows one side of the screen: `(zoom - 1) / 2 * side`. It must be at least
	/// the drift amplitude plus the zoomed blur radius (`blurRadius * zoom`), or the drift shows the edge band
	/// of the image, where the blur has no neighbors to average (`AmbientCoverBackdropTests` checks it on
	/// `designSize`).
	static func overflow(side: CGFloat) -> CGFloat {
		(zoom - 1) / 2 * side
	}
}
