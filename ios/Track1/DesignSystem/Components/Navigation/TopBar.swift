import SwiftUI
import Track1Core

/// Figma `Top bar` (`173:18`): the first line of a node page. The date on the daily recommendation, the
/// breadcrumb once the user has moved from node to node. It is plain content, not pinned: it scrolls away
/// with the page (Doc `173:20`). It is 345 pt wide on a 393 pt screen in Figma: the screen owns the 24 pt
/// margins, the bar fills what it is given.
struct TopBar: View {
	enum Content {
		case date(Date)
		case breadcrumb([TopBarCrumb])
	}

	/// Figma `I282:838;173:15` (2026-10-23, TRA-660): JetBrains Mono Bold 18 / 24, where the previous build
	/// used the Roboto Condensed `.eyebrow`.
	static let dateRole: Track1TextRole = .monoHeadline

	private let content: Content
	private let onSelect: (TopBarCrumb) -> Void

	/// `onSelect` receives the tapped crumb: the caller pops back to that node.
	init(_ content: Content, onSelect: @escaping (TopBarCrumb) -> Void) {
		self.content = content
		self.onSelect = onSelect
	}

	var body: some View {
		bar.modifier(TopBarClearance())
	}

	@ViewBuilder
	private var bar: some View {
		switch content {
		case .date(let date):
			// Centered (the Figma variant is `justify-center`).
			Track1Text(TopBarFormat.date(date, timeZone: .current), role: Self.dateRole, verbatim: true)
				.foregroundStyle(Track1Tokens.colorTextSecondary)
				.frame(maxWidth: .infinity, minHeight: Track1Tokens.sizeControlMedium)
				.accessibilityIdentifier("top-bar-date")
		case .breadcrumb(let crumbs):
			breadcrumb(TopBarFormat.collapsed(crumbs))
		}
	}

	private func breadcrumb(_ items: [TopBarItem]) -> some View {
		let selectable = Set(TopBarFormat.selectable(items))
		return HStack(spacing: Track1Tokens.spacing8) {
			ForEach(Array(items.enumerated()), id: \.offset) { position, item in
				if position > 0 {
					separator
				}
				itemView(item, isSelectable: { selectable.contains($0) })
			}
		}
		.frame(maxWidth: .infinity, minHeight: Track1Tokens.sizeControlMedium, alignment: .leading)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("top-bar-breadcrumb")
	}

	private var separator: some View {
		Track1Text(TopBarFormat.separator, role: .caption, verbatim: true)
			.foregroundStyle(Track1Tokens.colorTextSecondary)
			.accessibilityHidden(true)
	}

	@ViewBuilder
	private func itemView(_ item: TopBarItem, isSelectable: (TopBarCrumb) -> Bool) -> some View {
		switch item {
		case .ellipsis:
			// The older crumbs are folded away: there is no single node to pop back to, but a screen reader
			// must still learn that the path is longer than what it reads.
			Track1Text(TopBarFormat.ellipsisText, role: .caption, verbatim: true)
				.foregroundStyle(Track1Tokens.colorTextSecondary)
				.accessibilityLabel(Text(verbatim: "Étapes précédentes"))
		case .crumb(let crumb):
			// Titles are third-party data: shown verbatim, on one line.
			let title = Track1Text(crumb.title, role: .caption, verbatim: true)
				.foregroundStyle(Track1Tokens.colorTextSecondary)
				.lineLimit(1)
			if isSelectable(crumb) {
				Button {
					onSelect(crumb)
				} label: {
					title
						.frame(
							minWidth: Track1Tokens.sizeControlMedium, minHeight: Track1Tokens.sizeControlMedium
						)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityIdentifier("top-bar-crumb-\(crumb.index)")
			} else {
				// The last crumb is the node on screen: popping back to it would do nothing.
				title.accessibilityIdentifier("top-bar-crumb-\(crumb.index)")
			}
		}
	}
}

/// Keeps the Top bar out of the status bar. 2026-10-14 (TRA-372): on a page pushed from the search sheet, the
/// XCUITest tap on the crumb "Artist A" did nothing and the hierarchy put it at y = 0, under the Dynamic Island,
/// where the system takes the touch. The bar measures the top inset its layout gets and adds what the window
/// has more, so that it is a no-op where the safe area is already applied.
private struct TopBarClearance: ViewModifier {
	@State private var layoutInset: CGFloat = 0

	func body(content: Content) -> some View {
		content
			.padding(.top, TopBarFormat.clearance(windowInset: Self.windowInset, layoutInset: layoutInset))
			.background {
				GeometryReader { proxy in
					Color.clear.preference(key: TopInsetKey.self, value: proxy.safeAreaInsets.top)
				}
			}
			.onPreferenceChange(TopInsetKey.self) { layoutInset = $0 }
	}

	private static var windowInset: CGFloat {
		UIApplication.shared.connectedScenes
			.compactMap { $0 as? UIWindowScene }
			.flatMap(\.windows)
			.first(where: \.isKeyWindow)?.safeAreaInsets.top ?? 0
	}
}

private struct TopInsetKey: PreferenceKey {
	static let defaultValue: CGFloat = 0

	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
		value = max(value, nextValue())
	}
}
