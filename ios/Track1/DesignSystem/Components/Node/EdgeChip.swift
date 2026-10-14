import SwiftUI
import Track1Core

/// Measurements shared by `EdgeChip` and `EdgeChipOverflow`, read on 2026-10-13 from Figma `171:96`,
/// `171:97` and the doc `171:100`. The doc's 34 pt visual height wins over the 36 pt of the component node:
/// the node's 1 pt border adds 2 pt around a 34 pt box (8 + 18 + 8), and the doc says 34.
enum EdgeChipMetrics {
	/// Padding of both chips, `theme.spacing.8`.
	static let padding = Track1Tokens.spacing8
	/// Gap between the tag, the name and the meta, `theme.spacing.4`.
	static let contentSpacing = Track1Tokens.spacing4
	/// Corner radius: Figma draws a square rectangle, `theme.radius.0`.
	static let cornerRadius = Track1Tokens.radius0
	/// Border width. Figma has no token for it: every border of the design system is 1 pt.
	static let borderWidth: CGFloat = 1
	/// Dash pattern of the overflow border: 4 pt drawn, 3 pt gap. Figma shows the dashes on `171:97` but
	/// gives no value, so this is the pattern chosen in TRA-392 (kept on 2026-10-13, TRA-443). A constant of
	/// the component, not a design token.
	static let overflowDash: [CGFloat] = [4, 3]
	/// Doc `171:100`: "Long names truncate with an ellipsis at 280pt". No token covers it.
	static let nameMaxWidth: CGFloat = 280
	/// Doc `171:100`: "Tap target >= 44pt high in code".
	static let hitHeight = Track1Tokens.sizeControlMedium

	/// 34 pt: the padding around one Body/Small line (18 pt).
	static var chipVisualHeight: CGFloat { visualHeight(lineHeight: Track1TextRole.bodySmall.lineHeight) }
	/// 32 pt: the padding around one Mono/Tag line (16 pt).
	static var overflowVisualHeight: CGFloat { visualHeight(lineHeight: Track1TextRole.monoTag.lineHeight) }

	/// The chip height for a line height. The view passes the line height scaled by Dynamic Type.
	static func visualHeight(lineHeight: CGFloat) -> CGFloat {
		2 * padding + lineHeight
	}

	/// How far the tap area reaches above and below a chip of `visualHeight`, so the touch zone is 44 pt
	/// high while the layout keeps the visual 8 pt gap between rows. The reaches of two rows overlap by 2 pt
	/// at the default text size (5 + 5 against an 8 pt gap): the later row wins there. A chip that is 44 pt
	/// high or more, at large text sizes, reaches nowhere.
	static func hitExtension(visualHeight: CGFloat) -> CGFloat {
		max(0, (hitHeight - visualHeight) / 2)
	}
}

/// Figma `Edge chip` (`171:96`, doc `171:100`): one edge of a node, as a link to the target node. The tag
/// shows the target type in its graph color; the meta carries the year and release type of the edge.
/// The name and the meta are third-party data, so they are always shown verbatim. Figma draws no pressed
/// state: it takes the `surface.pressed` fill like the other tappable rows.
struct EdgeChip: View {
	private let type: NodeType
	private let name: String
	private let meta: String?
	private let identity: NodeIdentity?
	private let action: () -> Void

	/// `identity` only names the control for UI tests (`edge-chip-<identity>`).
	init(
		type: NodeType, name: String, meta: String?, identity: NodeIdentity? = nil,
		action: @escaping () -> Void
	) {
		self.type = type
		self.name = name
		self.meta = meta
		self.identity = identity
		self.action = action
	}

	/// An API edge as it is: its type, name, identity, year and release type.
	init(edge: NodeEdge, action: @escaping () -> Void) {
		self.init(
			type: edge.type, name: edge.name, meta: EdgeChipFormat.meta(of: edge), identity: edge.slug,
			action: action)
	}

	static func accessibilityIdentifier(identity: NodeIdentity) -> String {
		"edge-chip-\(identity.rawValue)"
	}

	/// One spoken label, "artist, Kendrick Lamar, 2015, album": the `·` of the meta is a visual separator.
	static func accessibilityLabel(type: NodeType, name: String, meta: String?) -> String {
		let metaParts = (meta ?? "").split(separator: "·").map { $0.trimmingCharacters(in: .whitespaces) }
		return ([EdgeChipFormat.typeLabel(type), name] + metaParts).joined(separator: ", ")
	}

	/// The tag, drawn in capitals as in Figma (`ARTIST`).
	static func tag(for type: NodeType) -> String {
		EdgeChipFormat.typeLabel(type).uppercased()
	}

	var body: some View {
		Button(action: action) {
			HStack(spacing: EdgeChipMetrics.contentSpacing) {
				Track1Text(Self.tag(for: type), role: .monoTag, verbatim: true)
					.foregroundStyle(EdgeChipStyle.tagColor(type))
					.fixedSize()
				// The name keeps its width before the meta does, so a narrow row still shows the name.
				Track1Text(name, role: .bodySmall, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextPrimary)
					.lineLimit(1)
					.truncationMode(.tail)
					.frame(maxWidth: EdgeChipMetrics.nameMaxWidth, alignment: .leading)
					.layoutPriority(1)
				if let meta {
					Track1Text(meta, role: .bodySmall, verbatim: true)
						.foregroundStyle(Track1Tokens.colorTextTertiary)
						.lineLimit(1)
				}
			}
		}
		.buttonStyle(
			EdgeChipButtonStyle(
				fill: EdgeChipStyle.fill, pressedFill: EdgeChipStyle.pressedFill, border: EdgeChipStyle.border,
				dash: [], role: .bodySmall)
		)
		// One spoken label from the type, the name and the meta, which a screen reader would otherwise read
		// as three loose texts. On the Button itself, so the identifier and the label share one element.
		.accessibilityElement(children: .combine)
		.accessibilityLabel(Self.accessibilityLabel(type: type, name: name, meta: meta))
		.optionalAccessibilityIdentifier(identity.map { Self.accessibilityIdentifier(identity: $0) })
	}
}

/// The colors of `EdgeChip`, from the "CODE" rules of the doc `171:100`.
enum EdgeChipStyle {
	/// `theme.color.node.<type>`.
	static func tagColor(_ type: NodeType) -> Color { Track1Tokens.colorNode(type) }
	/// `theme.color.background.elevated`.
	static let fill = Track1Tokens.colorBackgroundElevated
	static let pressedFill = Track1Tokens.colorSurfacePressed
	/// `theme.color.border.default`.
	static let border = Track1Tokens.colorBorderDefault
	/// `theme.color.border.strong`, the dashed border of the overflow chip (`171:97`).
	static let overflowBorder = Track1Tokens.colorBorderStrong
	/// `theme.color.text.secondary`, the overflow label.
	static let overflowLabel = Track1Tokens.colorTextSecondary
}

/// Figma `Edge chip / Overflow` (`171:97`): "+N more" after the first 8 chips of a list edge, which expands
/// the section in place. Its dashed border tells it apart from a link to a node.
struct EdgeChipOverflow: View {
	private let hiddenCount: Int
	private let field: String?
	private let action: () -> Void

	/// `field` only names the control for UI tests (`edge-overflow-<field>`).
	init(hiddenCount: Int, field: String? = nil, action: @escaping () -> Void) {
		self.hiddenCount = hiddenCount
		self.field = field
		self.action = action
	}

	/// Q1: data labels stay in the English of the Data contract. The caller shows the chip only while
	/// `hiddenCount` is above 0.
	static func label(hiddenCount: Int) -> String {
		"+\(hiddenCount) more"
	}

	static func accessibilityIdentifier(field: String) -> String {
		"edge-overflow-\(field)"
	}

	var body: some View {
		Button(action: action) {
			Track1Text(Self.label(hiddenCount: hiddenCount), role: .monoTag, verbatim: true)
				.foregroundStyle(EdgeChipStyle.overflowLabel)
				.lineLimit(1)
				.fixedSize()
		}
		.buttonStyle(
			EdgeChipButtonStyle(
				fill: .clear, pressedFill: EdgeChipStyle.pressedFill, border: EdgeChipStyle.overflowBorder,
				dash: EdgeChipMetrics.overflowDash, role: .monoTag)
		)
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(hiddenCount) more")
		.accessibilityHint("Affiche les autres éléments")
		.optionalAccessibilityIdentifier(field.map { Self.accessibilityIdentifier(field: $0) })
	}
}

/// The box shared by both chips: padding, fill, 1 pt border inside, and a tap area stretched to 44 pt high.
private struct EdgeChipButtonStyle: ButtonStyle {
	let fill: Color
	let pressedFill: Color
	let border: Color
	/// Empty for a solid border.
	let dash: [CGFloat]
	/// The role of the one line of text, whose scaled line height gives the visual height.
	let role: Track1TextRole

	func makeBody(configuration: Configuration) -> some View {
		EdgeChipBox(
			label: configuration.label, isPressed: configuration.isPressed,
			colors: (fill: fill, pressedFill: pressedFill, border: border), dash: dash, role: role)
	}
}

private struct EdgeChipBox<Label: View>: View {
	let label: Label
	let isPressed: Bool
	let colors: (fill: Color, pressedFill: Color, border: Color)
	let dash: [CGFloat]
	@ScaledMetric private var lineHeight: CGFloat

	init(
		label: Label, isPressed: Bool, colors: (fill: Color, pressedFill: Color, border: Color), dash: [CGFloat],
		role: Track1TextRole
	) {
		self.label = label
		self.isPressed = isPressed
		self.colors = colors
		self.dash = dash
		// The same scaling as `Track1Text`, so the visual height tracks the text.
		_lineHeight = ScaledMetric(wrappedValue: role.lineHeight, relativeTo: role.textStyle)
	}

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: EdgeChipMetrics.cornerRadius, style: .continuous)
		let reach = EdgeChipMetrics.hitExtension(visualHeight: EdgeChipMetrics.visualHeight(lineHeight: lineHeight))
		label
			.padding(EdgeChipMetrics.padding)
			.background(isPressed ? colors.pressedFill : colors.fill, in: shape)
			.overlay {
				shape.strokeBorder(
					colors.border, style: StrokeStyle(lineWidth: EdgeChipMetrics.borderWidth, dash: dash))
			}
			// Pad out, shape the touch area, pad back in: the layout keeps the visual height (34 pt) and the
			// touch zone reaches 44 pt.
			.padding(.vertical, reach)
			.contentShape(Rectangle())
			.padding(.vertical, -reach)
	}
}

extension View {
	/// Sets the identifier only when there is one: an empty identifier would hide the one a container sets.
	@ViewBuilder
	fileprivate func optionalAccessibilityIdentifier(_ identifier: String?) -> some View {
		if let identifier { accessibilityIdentifier(identifier) } else { self }
	}
}
