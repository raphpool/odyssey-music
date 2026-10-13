import SwiftUI
import Track1Core

/// Wraps its subviews into rows, left to right, with `theme.spacing.8` between chips on both axes (doc
/// `171:100`: "Chips wrap"). It places chips at their ideal size and, when one is wider than the row, gives it
/// a row of its own and proposes the row width, so a long name truncates instead of overflowing. Rows are
/// centered on their tallest chip: the overflow chip is 2 pt shorter than a node chip.
///
/// The wrapping rule is `ChipFlow.rows` of `Track1Core`, which `swift test` covers; this type measures and
/// places only.
struct ChipFlowLayout: Layout {
	var spacing: CGFloat = Track1Tokens.spacing8

	/// Which subviews share a row, as indexes. The pure rule lives in `Track1Core`.
	static func rows(sizes: [CGSize], maxWidth: CGFloat, spacing: CGFloat) -> [[Int]] {
		ChipFlow.rows(sizes: sizes, maxWidth: maxWidth, spacing: spacing)
	}

	/// The ideal size of each subview, measured once per update instead of in every `sizeThatFits` and
	/// `placeSubviews` call.
	func makeCache(subviews: Subviews) -> [CGSize] {
		subviews.map { $0.sizeThatFits(.unspecified) }
	}

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGSize]) -> CGSize {
		arrange(width: proposal.width, sizes: cache).size
	}

	func placeSubviews(
		in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGSize]
	) {
		let arrangement = arrange(width: bounds.width, sizes: cache)
		for (index, frame) in arrangement.frames.enumerated() {
			subviews[index].place(
				at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), anchor: .topLeading,
				proposal: ProposedViewSize(width: frame.width, height: frame.height))
		}
	}

	private func arrange(width: CGFloat?, sizes: [CGSize]) -> (frames: [CGRect], size: CGSize) {
		let maxWidth = width ?? .infinity
		var frames = Array(repeating: CGRect.zero, count: sizes.count)
		var y: CGFloat = 0
		var widest: CGFloat = 0
		for row in Self.rows(sizes: sizes, maxWidth: maxWidth, spacing: spacing) {
			let rowHeight = row.map { sizes[$0].height }.max() ?? 0
			var x: CGFloat = 0
			for index in row {
				let size = sizes[index]
				frames[index] = CGRect(
					x: x, y: y + (rowHeight - size.height) / 2, width: min(size.width, maxWidth),
					height: size.height)
				x += frames[index].width + spacing
			}
			widest = max(widest, x - spacing)
			y += rowHeight + spacing
		}
		return (frames, CGSize(width: max(widest, 0), height: max(y - spacing, 0)))
	}
}
