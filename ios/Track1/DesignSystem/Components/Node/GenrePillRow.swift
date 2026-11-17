import SwiftUI
import Track1Core

/// Measurements of a genre pill, read on 2026-11-17 from Figma `324:1820`: the text plus 8 pt of padding and
/// the 1 pt border on each side ("IDM", 25 pt of text, is a 43 pt pill).
enum GenrePillMetrics {
	/// Between two pills, and between two rows once the row wraps.
	static let spacing = Track1Tokens.spacing8
	static let horizontalPadding = Track1Tokens.spacing8
	static let verticalPadding = Track1Tokens.spacing4
	static let cornerRadius = Track1Tokens.radiusFull
	static let textRole = Track1TextRole.bodySmall
	static let lineLimit = 1

	/// 28 pt: one Body/Small line (18), the padding and the border above and below.
	static var height: CGFloat {
		textRole.lineHeight + 2 * (verticalPadding + TodayTileSurface.borderWidth)
	}
}

/// Where each pill goes. `ChipFlow.rows` of `Track1Core` fills the rows and each row is centered, which
/// `ChipFlowLayout` does not do: it places every row from the left.
enum GenrePillFlow {
	/// Frames relative to the layout's origin, and the layout's size: its widest row by all the rows. `width`
	/// is the width on offer, infinite for a single row. A pill wider than `width` is clamped to it: its text
	/// is one line and truncates, so its height does not change.
	static func frames(sizes: [CGSize], width: CGFloat, spacing: CGFloat) -> (
		frames: [CGRect], size: CGSize
	) {
		let rows = ChipFlow.rows(sizes: sizes, maxWidth: width, spacing: spacing)
		let rowWidths = rows.map { row in
			row.reduce(0) { $0 + min(sizes[$1].width, width) } + spacing * CGFloat(row.count - 1)
		}
		let widest = rowWidths.max() ?? 0
		let container = width.isFinite ? width : widest
		var frames = Array(repeating: CGRect.zero, count: sizes.count)
		var y: CGFloat = 0
		for (row, rowWidth) in zip(rows, rowWidths) {
			let rowHeight = row.map { sizes[$0].height }.max() ?? 0
			var x = (container - rowWidth) / 2
			for index in row {
				let size = CGSize(width: min(sizes[index].width, width), height: sizes[index].height)
				frames[index] = CGRect(origin: CGPoint(x: x, y: y + (rowHeight - size.height) / 2), size: size)
				x += size.width + spacing
			}
			y += rowHeight + spacing
		}
		return (frames, CGSize(width: widest, height: max(y - spacing, 0)))
	}
}

private struct CenteredFlowLayout: Layout {
	let spacing: CGFloat

	func makeCache(subviews: Subviews) -> [CGSize] {
		subviews.map { $0.sizeThatFits(.unspecified) }
	}

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGSize]) -> CGSize {
		GenrePillFlow.frames(sizes: cache, width: proposal.width ?? .infinity, spacing: spacing).size
	}

	func placeSubviews(
		in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGSize]
	) {
		let arrangement = GenrePillFlow.frames(sizes: cache, width: bounds.width, spacing: spacing)
		for (subview, frame) in zip(subviews, arrangement.frames) {
			subview.place(
				at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), anchor: .topLeading,
				proposal: ProposedViewSize(frame.size))
		}
	}
}

/// Centered row of genre pills (Figma `324:1820`). When the pills no longer fit, at the largest text sizes
/// for one, they wrap onto further rows instead of leaving the screen. Names come from the network: they are
/// drawn as plain text, never interpreted and never turned into a link. No genre, no view: nothing is
/// reserved for it.
struct GenrePillRow: View {
	private let genres: [String]

	init(genres: [String]) {
		self.genres = genres
	}

	var body: some View {
		if !genres.isEmpty {
			CenteredFlowLayout(spacing: GenrePillMetrics.spacing) {
				// Offsets, not names, identify the pills: two genres can share a name.
				ForEach(Array(genres.enumerated()), id: \.offset) { _, name in
					GenrePill(name: name)
				}
			}
			.frame(maxWidth: .infinity)
		}
	}
}

private struct GenrePill: View {
	let name: String

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: GenrePillMetrics.cornerRadius, style: .continuous)
		Track1Text(name, role: GenrePillMetrics.textRole, verbatim: true)
			.foregroundStyle(Track1Tokens.colorTextPrimary)
			.lineLimit(GenrePillMetrics.lineLimit)
			.padding(.horizontal, GenrePillMetrics.horizontalPadding + TodayTileSurface.borderWidth)
			.padding(.vertical, GenrePillMetrics.verticalPadding + TodayTileSurface.borderWidth)
			.todayTileSurface(in: shape)
	}
}
