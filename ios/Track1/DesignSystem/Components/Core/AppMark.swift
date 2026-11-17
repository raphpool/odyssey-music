import SwiftUI

/// Sizes of the app mark in the v1 mock-up (Figma `phudxrQNlzQJafXLma4FyX`): the splash (`362:4944`), Welcome
/// (`362:4910`) and the notification preview. In all three the corner radius is 21.875 % of the side
/// (40.32 / 184.32, 26.88 / 122.88, 7.875 / 36).
enum AppMarkMetrics {
	static let cornerRatio: CGFloat = 0.21875
	static let splashSize: CGFloat = 184.32
	static let welcomeSize: CGFloat = 122.88
	static let notificationSize: CGFloat = 36
}

/// The app icon (jewel case, iridescent disc, orange label) as a reusable view: a square of `size` on the
/// elevated background, with continuous rounded corners. The image is the `Brand/AppMark` asset, a stack of
/// the three layers of `AppIcon.icon`. It is decorative: the screen that shows it names itself.
struct AppMark: View {
	/// Name of the image in the asset catalogue (`Brand` namespace).
	static let imageName = "Brand/AppMark"
	static let identifier = "app-mark"

	private let size: CGFloat

	init(size: CGFloat) {
		self.size = size
	}

	var body: some View {
		Image(Self.imageName)
			.resizable()
			.scaledToFit()
			.frame(width: size, height: size)
			.background(Track1Tokens.colorBackgroundElevated)
			.clipShape(RoundedRectangle(cornerRadius: size * AppMarkMetrics.cornerRatio, style: .continuous))
			.accessibilityIdentifier(Self.identifier)
			.accessibilityHidden(true)
	}
}
