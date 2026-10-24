import SwiftUI
import Track1Core

/// Measurements of the rounded card that wraps the whole node page, read on 2026-10-23 from Figma `285:1034`
/// (screen `282:835`, "UI Refresh"): radius 16, padding 12 horizontal / 8 top / 24 bottom, 18 pt between
/// sections, 16 pt from the screen edges (361 pt wide on a 393 pt screen).
enum NodeContentCardMetrics {
	static let cornerRadius = Track1Tokens.radius16
	static let horizontalPadding = Track1Tokens.spacing12
	static let topPadding = Track1Tokens.spacing8
	static let bottomPadding = Track1Tokens.spacing24
	/// Gap between the blocks of the card. Figma has no spacing token for 18 pt, so it is a constant of the
	/// component.
	static let sectionSpacing: CGFloat = 18
	/// Distance between the card and the edges of the screen.
	static let outerInset = Track1Tokens.spacing16
	static let identifier = "node-card"

	/// Width left to the content of the card on a page `width` pt wide: 393 gives 337.
	static func contentWidth(forPageWidth width: CGFloat) -> CGFloat {
		width - 2 * outerInset - 2 * horizontalPadding
	}
}

/// What fills the card: flat `background.elevated`, or the cover gradient ending in it.
enum NodeContentCardBackground: Equatable {
	case flat
	case tinted(CoverTint)
}

/// Figma `285:1034`: the card that holds the badge, the hero, the title, the teaser, the sections and the
/// carousel of a node page. The fill is flat `background.elevated` without a tint, and the cover gradient
/// ending in `background.elevated` with one.
/// It does not inset itself from the screen edges (`NodeContentCardMetrics.outerInset`): the page does.
struct NodeContentCard<Content: View>: View {
	private let tint: CoverTint?
	private let content: Content

	init(tint: CoverTint? = nil, @ViewBuilder content: () -> Content) {
		self.tint = tint
		self.content = content()
	}

	static func background(for tint: CoverTint?) -> NodeContentCardBackground {
		tint.map(NodeContentCardBackground.tinted) ?? .flat
	}

	@ViewBuilder
	private var fill: some View {
		let shape = RoundedRectangle(cornerRadius: NodeContentCardMetrics.cornerRadius, style: .continuous)
		switch Self.background(for: tint) {
		case .flat:
			shape.fill(Track1Tokens.colorBackgroundElevated)
		case .tinted(let tint):
			CoverTintGradient(tint: tint, endpoint: Track1Tokens.colorBackgroundElevated).clipShape(shape)
		}
	}

	var body: some View {
		VStack(alignment: .leading, spacing: NodeContentCardMetrics.sectionSpacing) {
			content
		}
		.padding(.horizontal, NodeContentCardMetrics.horizontalPadding)
		.padding(.top, NodeContentCardMetrics.topPadding)
		.padding(.bottom, NodeContentCardMetrics.bottomPadding)
		.background { fill }
		// 2026-10-24: without `.contain`, the identifier of a container is propagated to its children and
		// overwrites theirs; once the node page sat in this card, `node-title`, `node-hero`, `section-*`,
		// `edge-chip-*` and `streaming-bar` vanished for XCUITest and 11 UI tests went red (TRA-659).
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier(NodeContentCardMetrics.identifier)
	}
}
