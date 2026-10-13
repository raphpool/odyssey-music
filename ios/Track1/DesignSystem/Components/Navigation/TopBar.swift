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

	private let content: Content
	private let onSelect: (TopBarCrumb) -> Void

	/// `onSelect` receives the tapped crumb: the caller pops back to that node.
	init(_ content: Content, onSelect: @escaping (TopBarCrumb) -> Void) {
		self.content = content
		self.onSelect = onSelect
	}

	var body: some View {
		switch content {
		case .date(let date):
			// Label/Eyebrow, centered (the Figma variant is `justify-center`).
			Track1Text(TopBarFormat.date(date, timeZone: .current), role: .eyebrow, verbatim: true)
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
