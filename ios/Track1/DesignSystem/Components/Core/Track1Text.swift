import SwiftUI
import UIKit

/// Figma `Text` (`11:33`, doc `170:39`): a semantic typography primitive. Pick a role by meaning, never by
/// size. `verbatim` is for data that does not belong to the app (third-party names and titles): it keeps
/// the string from being read as a localization key or as Markdown.
struct Track1Text: View {
	private let label: Text
	private let role: Track1TextRole
	@ScaledMetric private var lineHeight: CGFloat
	@ScaledMetric private var naturalHeight: CGFloat

	/// For a line made of several styled runs (a `Text` built with `+`): it takes the same line boxes as the
	/// string initialiser. The caller owns the runs, so a network string goes in with `Text(verbatim:)`.
	init(_ text: Text, role: Track1TextRole) {
		label = text
		self.role = role
		_lineHeight = ScaledMetric(wrappedValue: role.lineHeight, relativeTo: role.textStyle)
		let natural = UIFont(name: role.face.rawValue, size: role.size) ?? .systemFont(ofSize: role.size)
		_naturalHeight = ScaledMetric(wrappedValue: natural.lineHeight, relativeTo: role.textStyle)
	}

	init(_ content: String, role: Track1TextRole, verbatim: Bool = false) {
		self.init(verbatim ? Text(verbatim: content) : Text(LocalizedStringKey(content)), role: role)
	}

	var body: some View {
		Track1LineHeightLayout(lineHeight: lineHeight, naturalHeight: naturalHeight) {
			label.track1Text(role)
		}
	}
}

/// `Text.lineSpacing` only applies between two lines, so a single line keeps the natural height of its font
/// and the Figma line height is lost: `displayHero` measures 74 pt instead of 64 (TRA-384 review,
/// 2026-10-13). `Track1LineHeightLayout` gives a text N lines of the Figma line height, N x `lineHeight`,
/// scaled by Dynamic Type, so that one line and a wrapped text share one rule.
enum Track1LineHeight {
	/// `Text` measures `(n - 1) x lineHeight + naturalHeight` for n lines: the spacing between lines is
	/// `lineHeight - naturalHeight`. Solving for n absorbs any rounding in the measured height.
	static func lineCount(measured: CGFloat, lineHeight: CGFloat, naturalHeight: CGFloat) -> Int {
		guard lineHeight > 0 else { return 1 }
		return max(1, Int(((measured - naturalHeight) / lineHeight).rounded()) + 1)
	}

	static func height(measured: CGFloat, lineHeight: CGFloat, naturalHeight: CGFloat) -> CGFloat {
		CGFloat(lineCount(measured: measured, lineHeight: lineHeight, naturalHeight: naturalHeight)) * lineHeight
	}
}

private struct Track1LineHeightLayout: Layout {
	let lineHeight: CGFloat
	let naturalHeight: CGFloat

	/// The text is always measured and placed with the width alone. 2026-10-23 (TRA-664 review): `sizeThatFits`
	/// forwarded the height a parent proposed, and a `Text` offered less height than its lines need reports the
	/// clipped height, so a title that folds on three lines was counted as two: the card was sized for two
	/// lines, the text still drew three and overran the line under it. A stack proposes a height when it places
	/// its children, so only the final pass was wrong, which is why the size and the drawing disagreed.
	private func measuring(width: CGFloat?) -> ProposedViewSize {
		ProposedViewSize(width: width, height: nil)
	}

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		guard let text = subviews.first else { return .zero }
		let size = text.sizeThatFits(measuring(width: proposal.width))
		let height = Track1LineHeight.height(
			measured: size.height, lineHeight: lineHeight, naturalHeight: naturalHeight)
		return CGSize(width: size.width, height: height)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		// Centered on the line box: the extra or missing space is shared above and below the glyphs.
		subviews.first?.place(
			at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
			proposal: measuring(width: bounds.width))
	}

	/// Hands the baselines of the text to the stack around it. Without this a custom layout has no baseline of
	/// its own, `.firstTextBaseline` falls back to the bottom edge and a badge next to a folded title lands on
	/// its last line (macOS probe, 2026-10-24). The text is centered in the box (see `placeSubviews`), so its
	/// baselines are offset by the same amount.
	func explicitAlignment(
		of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews,
		cache: inout ()
	) -> CGFloat? {
		guard guide == .firstTextBaseline || guide == .lastTextBaseline, let text = subviews.first else {
			return nil
		}
		let measured = measuring(width: bounds.width)
		let top = bounds.midY - text.sizeThatFits(measured).height / 2
		return top + text.dimensions(in: measured)[guide]
	}
}
