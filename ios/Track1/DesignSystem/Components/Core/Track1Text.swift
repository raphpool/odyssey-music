import SwiftUI
import UIKit

/// Figma `Text` (`11:33`, doc `170:39`): a semantic typography primitive. Pick a role by meaning, never by
/// size. `verbatim` is for data that does not belong to the app (third-party names and titles): it keeps
/// the string from being read as a localization key or as Markdown.
struct Track1Text: View {
	private let content: String
	private let role: Track1TextRole
	private let verbatim: Bool
	@ScaledMetric private var lineHeight: CGFloat
	@ScaledMetric private var naturalHeight: CGFloat

	init(_ content: String, role: Track1TextRole, verbatim: Bool = false) {
		self.content = content
		self.role = role
		self.verbatim = verbatim
		_lineHeight = ScaledMetric(wrappedValue: role.lineHeight, relativeTo: role.textStyle)
		let natural = UIFont(name: role.face.rawValue, size: role.size) ?? .systemFont(ofSize: role.size)
		_naturalHeight = ScaledMetric(wrappedValue: natural.lineHeight, relativeTo: role.textStyle)
	}

	var body: some View {
		Track1LineHeightLayout(lineHeight: lineHeight, naturalHeight: naturalHeight) {
			label.track1Text(role)
		}
	}

	private var label: Text {
		verbatim ? Text(verbatim: content) : Text(LocalizedStringKey(content))
	}
}

/// `Text.lineSpacing` only applies between two lines, so a single line keeps the natural height of its font
/// and the Figma line height is lost: `displayHero` measures 74 pt instead of 64 (TRA-384 review,
/// 2026-10-13). `Track1LineHeightLayout` gives a single line the Figma line height, scaled by Dynamic Type,
/// and leaves wrapped text at its measured height.
enum Track1LineHeight {
	/// A wrapped text is at least two natural lines tall, a single one is one; 1.5 separates them without
	/// depending on the exact rounding of the measured height.
	static func height(measured: CGFloat, lineHeight: CGFloat, naturalHeight: CGFloat) -> CGFloat {
		measured < naturalHeight * 1.5 ? lineHeight : measured
	}
}

private struct Track1LineHeightLayout: Layout {
	let lineHeight: CGFloat
	let naturalHeight: CGFloat

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		guard let text = subviews.first else { return .zero }
		let size = text.sizeThatFits(proposal)
		let height = Track1LineHeight.height(
			measured: size.height, lineHeight: lineHeight, naturalHeight: naturalHeight)
		return CGSize(width: size.width, height: height)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		// Centered on the line box: the extra or missing space is shared above and below the glyphs.
		subviews.first?.place(
			at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
			proposal: ProposedViewSize(width: bounds.width, height: nil))
	}
}
