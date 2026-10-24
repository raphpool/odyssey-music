import SwiftUI
import Track1Core

/// Measurements of `NodeTypeBadge`, read on 2026-10-23 from Figma `286:1668`. The square is 11.37 x 12 in
/// Figma; it is drawn 12 x 12.
enum NodeTypeBadgeMetrics {
	static let squareSize: CGFloat = 12
	/// Gap between the square and the tag, `theme.spacing.8`.
	static let spacing = Track1Tokens.spacing8
	static let identifier = "node-type-badge"
}

/// Figma `286:1668`: opens the node card with a square and the type of the node in capitals, both in the
/// graph color of the type. Figma sets the tag in JetBrains Mono Bold 14/25 outside any text style; it takes
/// the `monoSection` role (Bold 15/20) instead of a new role (decision D6 of the UI refresh plan).
struct NodeTypeBadge: View {
	private let type: NodeType

	init(type: NodeType) {
		self.type = type
	}

	/// The tag, the same capitals as the edge chips (`ARTIST`).
	static func tag(for type: NodeType) -> String {
		EdgeChip.tag(for: type)
	}

	/// `theme.color.node.<type>`, for the square and the tag.
	static func color(for type: NodeType) -> Color {
		Track1Tokens.colorNode(type)
	}

	/// The lowercase type ("artist"): the capitals of the tag are only a visual choice.
	static func accessibilityLabel(for type: NodeType) -> String {
		EdgeChipFormat.typeLabel(type)
	}

	var body: some View {
		HStack(spacing: NodeTypeBadgeMetrics.spacing) {
			Rectangle()
				.fill(Self.color(for: type))
				.frame(width: NodeTypeBadgeMetrics.squareSize, height: NodeTypeBadgeMetrics.squareSize)
			Track1Text(Self.tag(for: type), role: .monoSection, verbatim: true)
				.foregroundStyle(Self.color(for: type))
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Self.accessibilityLabel(for: type))
		.accessibilityIdentifier(NodeTypeBadgeMetrics.identifier)
	}
}
