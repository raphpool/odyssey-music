import SwiftUI

/// Measures of the v1 mock-up `Splash Screen` (Figma `phudxrQNlzQJafXLma4FyX`, node `318:6513`, frame
/// 393 x 844), read on 2026-11-17 (TRA-719).
enum SplashMetrics {
	/// Side of the app mark (`362:4944`); the same number as `AppMarkMetrics.splashSize`.
	static let markSize: CGFloat = 184.32
	/// Top of the app mark in the frame (`362:4944`, y 330). Its x is 104.34, which is centered.
	static let markTop: CGFloat = 330
	/// Height of the Figma frame: on a screen of another height the mark keeps the `markTop / frameHeight`
	/// ratio from the top. In the frame it is centered to 0.16 pt (422.16 for 422); on another height it is
	/// not exactly centered, and so not exactly where the system launch image is.
	static let frameHeight: CGFloat = 844
	/// Vertical gradient of the root node: `screen/gradient-top` at the top, `background/elevated` from
	/// 30.746 % of the height down (`to-[30.746%]` on `318:6513`; Genres is at 33.099 %).
	static let backgroundStops: [Gradient.Stop] = [
		.init(color: Track1Tokens.colorScreenGradientTop, location: 0),
		.init(color: Track1Tokens.colorBackgroundElevated, location: 0.30746),
	]

	/// Where the mark is drawn on a screen of `size`, safe areas included: centered horizontally, at the
	/// Figma ratio from the top.
	static func markFrame(in size: CGSize) -> CGRect {
		CGRect(
			x: (size.width - markSize) / 2,
			y: size.height * markTop / frameHeight,
			width: markSize,
			height: markSize
		)
	}
}

/// The screen of every wait at launch: consent not read yet, profile not read yet, recommendation of the
/// day in preparation. The mock-up draws the app mark and nothing else, no text and no indicator (note
/// `370:1842`).
///
/// It is one VoiceOver element, "Chargement"; the mark is decorative (`AppMark` hides itself). Nothing moves
/// here, so Reduce Motion has nothing to change.
struct SplashView: View {
	static let identifier = "splash"
	static let accessibilityLabel = "Chargement"

	init() {}

	var body: some View {
		// Read on the full screen, not inside the safe areas: the frame of the mock-up is the whole display.
		GeometryReader { proxy in
			let mark = SplashMetrics.markFrame(in: proxy.size)
			AppMark(size: mark.width)
				.position(x: mark.midX, y: mark.midY)
		}
		.background {
			LinearGradient(stops: SplashMetrics.backgroundStops, startPoint: .top, endPoint: .bottom)
		}
		.ignoresSafeArea()
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Self.accessibilityLabel)
		.accessibilityIdentifier(Self.identifier)
	}
}
