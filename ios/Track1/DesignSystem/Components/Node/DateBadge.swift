import SwiftUI

/// Measurements of the date tile, read on 2026-11-17 from Figma `324:1818` (TRA-727). Its 53 pt width is
/// fixed in Figma and narrower than "OCT" (36 pt) plus the 10 pt padding and the border on both sides
/// (58 pt): the text sits 8.5 pt from each edge. The view pads vertically by 10 and sideways by those 8.5,
/// which makes "OCT" exactly 53 pt wide. The width is a minimum: a longer month ("JUIL") grows the tile
/// instead of spilling out of it (code review of TRA-727, 2026-11-17).
enum DateBadgeMetrics {
	static let width: CGFloat = 53
	static let padding = Track1Tokens.spacing10
	/// Room the text keeps at each side (Figma text at x 8.5).
	static let textInset: CGFloat = 8.5
	static let cornerRadius = Track1Tokens.radius16
	static let textRole = Track1TextRole.title3

	/// 72 pt: two Title/3 lines (2 x 25), the padding and the border above and below.
	static var height: CGFloat {
		2 * textRole.lineHeight + 2 * (padding + TodayTileSurface.borderWidth)
	}

	/// One accessibility element for the whole tile, read as "11 OCT".
	static func accessibilityLabel(day: String, month: String) -> String {
		"\(day) \(month)"
	}
}

/// Fill and border shared by the date tile and the genre pills (Figma `324:1818`, `324:1821`): a vertical
/// gradient from `#F6E9D8` at 10 % to the same tint at 0 %, and a 1 pt border of `#F6E9D8` at 8 %.
enum TodayTileSurface {
	static let borderWidth: CGFloat = 1
	static let borderColor = Track1Tokens.colorBorderHairline
	static let topColor = Track1Tokens.colorTintWarm
	/// The same tint at 0 %, so the gradient fades out without passing through another hue.
	static let bottomColor = Track1Tokens.colorTintWarm.opacity(0)
	static let startPoint = UnitPoint.top
	static let endPoint = UnitPoint.bottom
}

extension View {
	/// Gradient behind the view, border inside the shape, as a CSS border-box draws it.
	func todayTileSurface(in shape: RoundedRectangle) -> some View {
		background(
			LinearGradient(
				colors: [TodayTileSurface.topColor, TodayTileSurface.bottomColor],
				startPoint: TodayTileSurface.startPoint, endPoint: TodayTileSurface.endPoint),
			in: shape
		)
		.overlay { shape.strokeBorder(TodayTileSurface.borderColor, lineWidth: TodayTileSurface.borderWidth) }
	}
}

/// Date tile of the home screen (Figma `324:1818`): the day over the month, centered, as one VoiceOver
/// element. Both strings come from the caller and are shown as they are, never as a localization key.
struct DateBadge: View {
	private let day: String
	private let month: String
	// Scales with Dynamic Type like its text, so "OCT" fills the same share of the tile at every size.
	@ScaledMetric(relativeTo: .title3) private var width: CGFloat = DateBadgeMetrics.width

	init(day: String, month: String) {
		self.day = day
		self.month = month
	}

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: DateBadgeMetrics.cornerRadius, style: .continuous)
		VStack(spacing: 0) {
			Track1Text(day, role: DateBadgeMetrics.textRole, verbatim: true)
			Track1Text(month, role: DateBadgeMetrics.textRole, verbatim: true)
		}
		.foregroundStyle(Track1Tokens.colorTextPrimary)
		.lineLimit(1)
		.fixedSize()
		.padding(.horizontal, DateBadgeMetrics.textInset)
		.padding(.vertical, DateBadgeMetrics.padding + TodayTileSurface.borderWidth)
		.frame(minWidth: width)
		.todayTileSurface(in: shape)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Text(verbatim: DateBadgeMetrics.accessibilityLabel(day: day, month: month)))
	}
}
