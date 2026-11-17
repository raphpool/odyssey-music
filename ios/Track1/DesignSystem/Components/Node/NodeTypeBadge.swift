import SwiftUI
import Track1Core

/// What opens the badge: a square for four types, a hexagon for a track.
enum NodeTypeBadgeShape {
	case square, hexagon
}

/// Measurements of `NodeTypeBadge`, read on 2026-11-17 from Figma `362:5098` (PROJECT) and `362:5105`
/// (TRACK).
enum NodeTypeBadgeMetrics {
	/// Figma `362:5099`. The 11.368 is kept as is: 2026-10-23 the square was rounded to 12 x 12, which drew
	/// the PROJECT badge about 0.6 pt wider than the design.
	static let squareSize = CGSize(width: 11.368, height: 12)
	/// Figma `362:5107`: the polygon is 14 x 14 and its frame is the slot that the spacing is measured from.
	static let hexagonSize: CGFloat = 14
	/// How far below the centre of the 25 high line the hexagon sits. Figma `362:5107` is at y = 2.5 in its
	/// 14 x 17 frame `362:5106`, which is at y = 4 in the line `362:5105`: its centre is at 13.5 for a line
	/// centre of 12.5 (read on 2026-11-17). The square `362:5099` is centred. Kept on purpose, the screens
	/// are matched to the pixel (arbitration Q6).
	static let hexagonOffsetY: CGFloat = 1
	static let identifier = "node-type-badge"

	/// Vertical shift of the shape from the centre of the line: `hexagonOffsetY` for a track, 0 for a square.
	static func offsetY(for type: NodeType) -> CGFloat {
		switch NodeTypeBadge.shape(for: type) {
		case .hexagon: hexagonOffsetY
		case .square: 0
		}
	}

	/// Gap between the shape and the tag: 4 after the hexagon (`362:5105`), `theme.spacing.8` after the
	/// square (`362:5098`). It follows the shape, so a type cannot get one shape and the other's gap.
	static func spacing(for type: NodeType) -> CGFloat {
		switch NodeTypeBadge.shape(for: type) {
		case .hexagon: Track1Tokens.spacing4
		case .square: Track1Tokens.spacing8
		}
	}
}

/// A regular hexagon with a vertex at the top, Figma `362:5107` (a 6-sided polygon). Its vertices sit on the
/// ellipse inscribed in the rect, as Figma draws a polygon: in a 14 x 14 frame the hexagon is 14 high and
/// about 12.1 wide, 0.94 away from the left and right edges of the slot. Checked on 2026-11-17 on the pixels
/// of the Figma render of `362:5106`: the inset is the design's, not a drift, and the 4 gap to the tag is
/// measured from the slot, not from the visible edge.
struct NodeTypeBadgeHexagon: Shape {
	static func vertices(in rect: CGRect) -> [CGPoint] {
		let sides = 6
		return (0..<sides).map { index in
			let angle = -CGFloat.pi / 2 + CGFloat(index) * 2 * CGFloat.pi / CGFloat(sides)
			return CGPoint(
				x: rect.midX + rect.width / 2 * cos(angle), y: rect.midY + rect.height / 2 * sin(angle))
		}
	}

	func path(in rect: CGRect) -> Path {
		var path = Path()
		path.addLines(Self.vertices(in: rect))
		path.closeSubpath()
		return path
	}
}

/// Figma `362:5098` and `362:5105`: opens the node card with a shape and the type of the node in capitals,
/// both in the graph color of the type. The shape is a hexagon for a track and a square for every other type
/// (artist, project, genre, label keep the square and their color). The tag is JetBrains Mono Bold 14/25, the
/// `monoBadge` role.
struct NodeTypeBadge: View {
	/// 2026-11-17: the tag moved from `monoSection` (Bold 15/20, a stand-in picked on 2026-10-23) to the
	/// `monoBadge` role, which has the Figma size and line height.
	static let tagRole: Track1TextRole = .monoBadge

	private let type: NodeType

	init(type: NodeType) {
		self.type = type
	}

	/// The tag, the same capitals as the edge chips (`ARTIST`).
	static func tag(for type: NodeType) -> String {
		EdgeChip.tag(for: type)
	}

	/// `theme.color.node.<type>`, for the shape and the tag.
	static func color(for type: NodeType) -> Color {
		Track1Tokens.colorNode(type)
	}

	static func shape(for type: NodeType) -> NodeTypeBadgeShape {
		switch type {
		case .track: .hexagon
		case .artist, .project, .genre, .label: .square
		}
	}

	/// The lowercase type ("artist"): the capitals of the tag are only a visual choice.
	static func accessibilityLabel(for type: NodeType) -> String {
		EdgeChipFormat.typeLabel(type)
	}

	var body: some View {
		HStack(spacing: NodeTypeBadgeMetrics.spacing(for: type)) {
			mark
				.offset(y: NodeTypeBadgeMetrics.offsetY(for: type))
			Track1Text(Self.tag(for: type), role: Self.tagRole, verbatim: true)
				.foregroundStyle(Self.color(for: type))
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Self.accessibilityLabel(for: type))
		.accessibilityIdentifier(NodeTypeBadgeMetrics.identifier)
	}

	@ViewBuilder
	private var mark: some View {
		switch Self.shape(for: type) {
		case .square:
			Rectangle()
				.fill(Self.color(for: type))
				.frame(width: NodeTypeBadgeMetrics.squareSize.width, height: NodeTypeBadgeMetrics.squareSize.height)
		case .hexagon:
			NodeTypeBadgeHexagon()
				.fill(Self.color(for: type))
				.frame(width: NodeTypeBadgeMetrics.hexagonSize, height: NodeTypeBadgeMetrics.hexagonSize)
		}
	}
}
