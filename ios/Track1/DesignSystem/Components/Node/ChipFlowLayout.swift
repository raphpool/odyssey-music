import SwiftUI
import Track1Core

/// Where a chip sits vertically in its row when it is shorter than the row's tallest chip.
enum ChipRowAlignment {
	/// Centered on the tallest chip: the node page keeps it, its overflow chip is 2 pt shorter than a node chip.
	case center
	/// At the top of the row. 2026-10-24 (TRA-700, review of TRA-679, macOS probe): a subgenre chip folded on
	/// two lines can be narrower than the row and share it with a one-line chip, which then floated at
	/// mid-height beside it. The onboarding genre cards align those at the top.
	case top
}

/// Wraps its subviews into rows, left to right, with `theme.spacing.8` between chips on both axes (doc
/// `171:100`: "Chips wrap"). It places chips at their ideal size. A chip wider than the row is measured again
/// at the row width: it folds or truncates according to its own `lineLimit` (the node page chips truncate, the
/// subgenre chips fold), and the size it reports then flows like any other chip's, so a folded chip narrower
/// than the row can share it with a short neighbour. By default rows are centered on their tallest chip: the
/// overflow chip is 2 pt shorter than a node chip. `rowAlignment: .top` poses every chip at the top of its row
/// instead (see `ChipRowAlignment`).
///
/// The wrapping rule is `ChipFlow.rows` of `Track1Core`, which `swift test` covers; this type measures and
/// places only.
struct ChipFlowLayout: Layout {
	var spacing: CGFloat = Track1Tokens.spacing8
	var rowAlignment: ChipRowAlignment = .center

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
		arrange(width: proposal.width, subviews: subviews, sizes: cache).size
	}

	func placeSubviews(
		in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGSize]
	) {
		let arrangement = arrange(width: bounds.width, subviews: subviews, sizes: cache)
		for (index, frame) in arrangement.frames.enumerated() {
			subviews[index].place(
				at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), anchor: .topLeading,
				proposal: ProposedViewSize(width: frame.width, height: frame.height))
		}
	}

	private func arrange(width: CGFloat?, subviews: Subviews, sizes ideal: [CGSize]) -> (
		frames: [CGRect], size: CGSize
	) {
		let maxWidth = width ?? .infinity
		var sizes = ideal
		// 2026-10-24 (TRA-679, macOS probe): a chip wider than the row kept its one-line ideal height while its
		// text folded at the row width, so the pill grew out of a one-line slot and covered the next chip. Only
		// those chips are measured again, at the row width, and that size replaces the ideal one for the rows,
		// the row height and the frame. The `.zero` and `.unspecified` probes keep the cached sizes: `.zero`
		// is a flexibility probe, not a row.
		if maxWidth > 0, maxWidth < .infinity {
			for index in sizes.indices where sizes[index].width > maxWidth {
				sizes[index] = subviews[index].sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
			}
		}
		var frames = Array(repeating: CGRect.zero, count: sizes.count)
		var y: CGFloat = 0
		var widest: CGFloat = 0
		for row in Self.rows(sizes: sizes, maxWidth: maxWidth, spacing: spacing) {
			let rowHeight = row.map { sizes[$0].height }.max() ?? 0
			var x: CGFloat = 0
			for index in row {
				let size = sizes[index]
				let offset = rowAlignment == .top ? 0 : (rowHeight - size.height) / 2
				frames[index] = CGRect(
					x: x, y: y + offset, width: min(size.width, maxWidth), height: size.height)
				x += frames[index].width + spacing
			}
			widest = max(widest, x - spacing)
			y += rowHeight + spacing
		}
		return (frames, CGSize(width: max(widest, 0), height: max(y - spacing, 0)))
	}
}
