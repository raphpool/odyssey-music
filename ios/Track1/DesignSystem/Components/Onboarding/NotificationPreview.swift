import SwiftUI

/// Measurements of the notification preview of the opt-in screen, read on 2026-11-17 from Figma `317:5226`
/// (TRA-740). The 327 pt width is the one of the mock-up: it is a maximum, so a narrower screen shrinks the
/// preview instead of overflowing. The app mark is `AppMark` as it is (36 pt, so a 7.875 pt corner).
enum NotificationPreviewMetrics {
	static let width: CGFloat = 327
	static let padding = Track1Tokens.spacing12
	static let spacing = Track1Tokens.spacing12
	static let cornerRadius = Track1Tokens.radius12
	static let iconSize = AppMarkMetrics.notificationSize
	/// Between the title and the body.
	static let textSpacing = Track1Tokens.spacing2
	static let titleRole = Track1TextRole.labelMedium
	static let bodyRole = Track1TextRole.bodySmall
	static let bodyLineLimit = 2
	static let titleColor = Track1Tokens.colorTextPrimary
	static let bodyColor = Track1Tokens.colorTextSecondary

	/// `#F6E9D8` at 10 % at the top, the same tint at 0 % at 115.85 % of the height. The second stop lies
	/// below the shape, so the gradient line is stretched to `y = 1.1585` instead of bending the alpha: at the
	/// bottom edge the tint is still faintly there, as in Figma.
	static let topColor = Track1Tokens.colorTintWarm
	static let bottomColor = Track1Tokens.colorTintWarm.opacity(0)
	static let gradientStart = UnitPoint.top
	static let gradientEnd = UnitPoint(x: 0.5, y: 1.1585)

	static let accessibilityPrefix = "Exemple de notification"

	/// One accessibility element for the whole preview. It says it is an example, so nobody takes it for a
	/// real notification.
	static func accessibilityLabel(title: String, body: String) -> String {
		"\(accessibilityPrefix) : \(title). \(body)"
	}
}

/// Illustration of the daily notification (Figma `Notification preview`, `317:5226`): the app mark beside a
/// title and a body that stops at two lines. iOS draws the real notification, so this reads none: both
/// strings come from the caller and are shown as they are, never as a localization key.
struct NotificationPreview: View {
	private typealias Metrics = NotificationPreviewMetrics

	private let title: String
	private let message: String

	init(title: String, body: String) {
		self.title = title
		self.message = body
	}

	var body: some View {
		HStack(alignment: .top, spacing: Metrics.spacing) {
			AppMark(size: Metrics.iconSize)
			VStack(alignment: .leading, spacing: Metrics.textSpacing) {
				Track1Text(title, role: Metrics.titleRole, verbatim: true)
					.foregroundStyle(Metrics.titleColor)
				Track1Text(message, role: Metrics.bodyRole, verbatim: true)
					.foregroundStyle(Metrics.bodyColor)
					.lineLimit(Metrics.bodyLineLimit)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(Metrics.padding)
		.frame(maxWidth: Metrics.width)
		.background(surface, in: RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Text(verbatim: Metrics.accessibilityLabel(title: title, body: message)))
	}

	private var surface: LinearGradient {
		let colors = [Metrics.topColor, Metrics.bottomColor]
		return LinearGradient(colors: colors, startPoint: Metrics.gradientStart, endPoint: Metrics.gradientEnd)
	}
}

#Preview("Notification preview") {
	NotificationPreview(title: "Ta recommandation du jour", body: "Aphex Twin, Selected Ambient Works 85-92")
		.padding()
		.background(Track1Tokens.colorBackgroundBase)
}
