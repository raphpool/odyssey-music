import Foundation

/// One step of the path of visited nodes. `index` is its position in the path; -1 is the root (the screen the
/// path started from), so that a tap can pop back to it.
public struct TopBarCrumb: Hashable, Sendable {
	public let index: Int
	public let title: String

	public init(index: Int, title: String) {
		self.index = index
		self.title = title
	}
}

/// What the breadcrumb draws: a crumb, or the `…` that stands for the older ones.
public enum TopBarItem: Hashable, Sendable {
	case crumb(TopBarCrumb)
	case ellipsis
}

/// The text rules of the Top bar, kept apart from the view so that `swift test` covers them without rendering.
public enum TopBarFormat {
	/// The Doc `173:20` keeps the last 3 nodes of the path.
	public static let visibleCrumbCount = 3
	public static let separator = "›"
	public static let ellipsisText = "…"

	/// Long date without weekday, in French whatever the device language: "13 octobre" (the Figma Date
	/// variant `173:14`). The day is in the given time zone, not in UTC: 23:30 UTC on 31 October is already
	/// 1 November in Paris.
	public static func date(_ date: Date, timeZone: TimeZone) -> String {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "fr_FR")
		formatter.timeZone = timeZone
		formatter.setLocalizedDateFormatFromTemplate("dMMMM")
		return formatter.string(from: date)
	}

	/// The crumbs a tap can pop back to: every crumb but the last one, which is the node on screen. The
	/// ellipsis stands for several nodes at once, so it selects none.
	public static func selectable(_ items: [TopBarItem]) -> [TopBarCrumb] {
		items.dropLast().compactMap {
			if case .crumb(let crumb) = $0 { crumb } else { nil }
		}
	}

	/// What the Top bar must add above itself to clear the status bar and the Dynamic Island: the window's top
	/// inset minus the one the layout already gives it. Never negative, and 0 when the layout is right.
	/// 2026-10-14 (TRA-372): a crumb under the Dynamic Island did not receive taps; moved here with TRA-438.
	public static func clearance(windowInset: CGFloat, layoutInset: CGFloat) -> CGFloat {
		max(0, windowInset - layoutInset)
	}

	/// Keeps the last 3 crumbs, in path order, and folds the earlier ones into a single leading ellipsis.
	public static func collapsed(_ crumbs: [TopBarCrumb]) -> [TopBarItem] {
		let kept = crumbs.suffix(visibleCrumbCount).map(TopBarItem.crumb)
		return crumbs.count > visibleCrumbCount ? [.ellipsis] + kept : kept
	}
}
