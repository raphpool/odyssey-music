import SwiftUI

enum Track1ButtonKind: CaseIterable {
	case primary, secondary, ghost
}

/// Figma `Size` property: 44 pt (Medium) and 52 pt (Large) tap targets.
enum Track1ControlSize: CaseIterable {
	case medium, large

	var height: CGFloat {
		switch self {
		case .medium: Track1Tokens.sizeControlMedium
		case .large: Track1Tokens.sizeControlLarge
		}
	}

	/// Figma sets Label/Medium on Medium variants and Label/Large on Large ones (read 2026-10-13 on `16:20`).
	var labelRole: Track1TextRole {
		switch self {
		case .medium: .labelMedium
		case .large: .labelLarge
		}
	}

	var iconSize: CGFloat {
		switch self {
		case .medium: Track1Tokens.sizeIconMedium
		case .large: Track1Tokens.sizeIconLarge
		}
	}

	var horizontalPadding: CGFloat {
		switch self {
		case .medium: Track1Tokens.spacing20
		case .large: Track1Tokens.spacing24
		}
	}

	var contentSpacing: CGFloat {
		switch self {
		case .medium: Track1Tokens.spacing8
		case .large: Track1Tokens.spacing10
		}
	}
}

/// Figma `State` property. Pressed comes from `ButtonStyle.Configuration.isPressed` and Disabled from the
/// `isEnabled` environment; the style never owns either.
enum Track1ControlState: CaseIterable {
	case normal, pressed, disabled

	/// A disabled control cannot be pressed: Disabled wins.
	init(isEnabled: Bool, isPressed: Bool) {
		self = !isEnabled ? .disabled : isPressed ? .pressed : .normal
	}
}

/// The 9 Style x State variants of Figma `Button` (`16:20`, nodes `15:9` to `15:77`) and of `IconButton`
/// (`14:58`), which share them. The Size does not change a color. No variant has a stroke, hence `border`
/// stays `nil`.
enum Track1ButtonColors {
	typealias Resolved = (fill: Color, label: Color, border: Color?)

	/// `theme.opacity.disabled` is 42 %. Figma applies it to the whole control, not to its colors.
	static let disabledOpacity = 0.42

	static func resolve(kind: Track1ButtonKind, state: Track1ControlState) -> Resolved {
		switch (kind, state) {
		case (.primary, .normal):
			(Track1Tokens.colorActionPrimary, Track1Tokens.colorTextInverse, nil)
		case (.primary, .pressed):
			(Track1Tokens.colorActionPrimaryPressed, Track1Tokens.colorTextInverse, nil)
		case (.secondary, .normal):
			(Track1Tokens.colorActionSecondary, Track1Tokens.colorTextPrimary, nil)
		case (.secondary, .pressed):
			(Track1Tokens.colorActionSecondaryPressed, Track1Tokens.colorTextPrimary, nil)
		case (.ghost, .normal):
			(Track1Tokens.colorActionGhost, Track1Tokens.colorTextPrimary, nil)
		case (.ghost, .pressed):
			(Track1Tokens.colorActionGhostPressed, Track1Tokens.colorTextPrimary, nil)
		case (.primary, .disabled), (.secondary, .disabled):
			(Track1Tokens.colorActionDisabled, Track1Tokens.colorTextDisabled, nil)
		case (.ghost, .disabled):
			(Track1Tokens.colorActionGhost, Track1Tokens.colorTextDisabled, nil)
		}
	}
}

/// Figma `Button` (`16:20`, doc `170:55`): a capsule with a label and an optional trailing icon. `haptic`
/// is for bottom CTAs and listening buttons: one light impact per tap. `fullWidth` stretches the capsule to
/// the width its container offers (bottom CTAs, consent choices); it sizes to its label otherwise.
struct Track1Button: View {
	private let title: String
	private let kind: Track1ButtonKind
	private let size: Track1ControlSize
	private let icon: Track1Icon.Glyph?
	private let haptic: Bool
	private let fullWidth: Bool
	private let action: () -> Void
	@State private var taps = 0

	init(
		_ title: String, kind: Track1ButtonKind, size: Track1ControlSize, icon: Track1Icon.Glyph? = nil,
		haptic: Bool = false, fullWidth: Bool = false, action: @escaping () -> Void
	) {
		self.title = title
		self.kind = kind
		self.size = size
		self.icon = icon
		self.haptic = haptic
		self.fullWidth = fullWidth
		self.action = action
	}

	/// The widest frame the capsule asks for: unbounded when `fullWidth`, none (the label's own width)
	/// otherwise.
	static func maxWidth(fullWidth: Bool) -> CGFloat? {
		fullWidth ? .infinity : nil
	}

	var body: some View {
		Button {
			if haptic { taps += 1 }
			action()
		} label: {
			Track1Text(title, role: size.labelRole).multilineTextAlignment(.center)
		}
		.buttonStyle(Track1ButtonStyle(kind: kind, size: size, icon: icon, iconOnly: false, fullWidth: fullWidth))
		.sensoryFeedback(.impact(weight: .light), trigger: taps)
	}
}

/// Shared by `Track1Button` and `Track1IconButton`.
struct Track1ButtonStyle: ButtonStyle {
	let kind: Track1ButtonKind
	let size: Track1ControlSize
	let icon: Track1Icon.Glyph?
	let iconOnly: Bool
	var fullWidth = false

	func makeBody(configuration: Configuration) -> some View {
		Track1ButtonBody(
			kind: kind, size: size, icon: icon, iconOnly: iconOnly, fullWidth: fullWidth,
			isPressed: configuration.isPressed, label: configuration.label)
	}
}

/// A view of its own because `isEnabled` is an environment value, which a `ButtonStyle` cannot read.
private struct Track1ButtonBody: View {
	let kind: Track1ButtonKind
	let size: Track1ControlSize
	let icon: Track1Icon.Glyph?
	let iconOnly: Bool
	let fullWidth: Bool
	let isPressed: Bool
	let label: ButtonStyleConfiguration.Label
	@Environment(\.isEnabled) private var isEnabled

	var body: some View {
		let state = Track1ControlState(isEnabled: isEnabled, isPressed: isPressed)
		let colors = Track1ButtonColors.resolve(kind: kind, state: state)
		let shape = RoundedRectangle(cornerRadius: Track1Tokens.radiusFull, style: .continuous)
		content(color: colors.label)
			.foregroundStyle(colors.label)
			.background(colors.fill, in: shape)
			.opacity(state == .disabled ? Track1ButtonColors.disabledOpacity : 1)
			.contentShape(shape)
	}

	@ViewBuilder
	private func content(color: Color) -> some View {
		if iconOnly {
			// Square: the whole control is the tap target, 44 or 52 pt.
			let target = Track1IconButton.targetSize(for: size)
			ZStack {
				if let icon { Track1Icon(icon, color: color, size: size.iconSize) }
			}
			.frame(width: target.width, height: target.height)
		} else {
			HStack(spacing: size.contentSpacing) {
				label
				if let icon { Track1Icon(icon, color: color, size: size.iconSize) }
			}
			.padding(.horizontal, size.horizontalPadding)
			// 12 pt as in Figma Medium; Large is 16 pt there at a fixed 52 pt height, which `minHeight` keeps.
			// Leaving room above and below lets the label grow with Dynamic Type instead of being clipped.
			.padding(.vertical, Track1Tokens.spacing12)
			.frame(maxWidth: Track1Button.maxWidth(fullWidth: fullWidth), minHeight: size.height)
		}
	}
}
