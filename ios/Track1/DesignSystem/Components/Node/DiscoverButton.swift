import SwiftUI

/// Measurements of the "Découvrir" button, read on 2026-11-17 from Figma `324:1813`: 44 pt high, and 133 pt
/// wide in the mockup (12 + 20 + 4 + 81 + 16). Its width is its content's.
enum DiscoverButtonMetrics {
	static let leadingPadding = Track1Tokens.spacing12
	static let trailingPadding = Track1Tokens.spacing16
	static let verticalPadding = Track1Tokens.spacing12
	static let height = Track1Tokens.sizeControlMedium
	static let cornerRadius = Track1Tokens.radiusFull
	static let fill = Track1Tokens.colorActionPrimary
	/// Figma draws no Pressed state: the pressed token of the fill, as `StreamingButton` does.
	static let pressedFill = Track1Tokens.colorActionPrimaryPressed
	static let labelColor = Track1Tokens.colorTextInverse
	static let iconTone = Track1Icon.Tone.inverse
	/// Icon `338:2511`.
	static let iconSize = Track1Tokens.sizeIconMedium
	static let iconSpacing = Track1Tokens.spacing4
	static let labelRole = Track1TextRole.monoButton
	static let title = "Découvrir"
	/// For the UI tests of the home screen.
	static let identifier = "today-discover"
}

/// What a tap does: it runs the action once, unless a request is already under way.
enum DiscoverButtonTap {
	/// The one rule: the view disables the button with it and `handle` checks it, so they cannot disagree.
	static func isEnabled(isLoading: Bool) -> Bool {
		!isLoading
	}

	/// `true` when the action ran, which is also when the haptic plays.
	@discardableResult
	static func handle(isLoading: Bool, action: () -> Void) -> Bool {
		guard isEnabled(isLoading: isLoading) else { return false }
		action()
		return true
	}
}

/// "Découvrir" button of the home screen (Figma `324:1813`): a bone capsule with a play icon and a mono
/// label. Not a `Track1Button`: its 12 / 16 pt paddings and its mono label match none of its sizes. One light
/// impact per tap, as `Track1Button` does with `haptic`.
struct DiscoverButton: View {
	private let isLoading: Bool
	private let action: () -> Void
	@State private var taps = 0

	init(isLoading: Bool = false, action: @escaping () -> Void) {
		self.isLoading = isLoading
		self.action = action
	}

	var body: some View {
		Button {
			if DiscoverButtonTap.handle(isLoading: isLoading, action: action) { taps += 1 }
		} label: {
			HStack(spacing: DiscoverButtonMetrics.iconSpacing) {
				Track1Icon(.play, tone: DiscoverButtonMetrics.iconTone, size: DiscoverButtonMetrics.iconSize)
				Track1Text(DiscoverButtonMetrics.title, role: DiscoverButtonMetrics.labelRole)
					.lineLimit(1)
					.fixedSize(horizontal: true, vertical: false)
			}
		}
		.buttonStyle(DiscoverButtonStyle())
		.disabled(!DiscoverButtonTap.isEnabled(isLoading: isLoading))
		.sensoryFeedback(.impact(weight: .light), trigger: taps)
		.accessibilityIdentifier(DiscoverButtonMetrics.identifier)
	}
}

/// Figma draws no Pressed or Disabled state. Like `StreamingButton`, the button takes the pressed token of
/// its fill and, disabled (while loading), the opacity of the buttons.
private struct DiscoverButtonStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		DiscoverButtonBody(isPressed: configuration.isPressed, label: configuration.label)
	}
}

private struct DiscoverButtonBody: View {
	let isPressed: Bool
	let label: ButtonStyleConfiguration.Label
	@Environment(\.isEnabled) private var isEnabled

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: DiscoverButtonMetrics.cornerRadius, style: .continuous)
		let fill = isPressed ? DiscoverButtonMetrics.pressedFill : DiscoverButtonMetrics.fill
		label
			.foregroundStyle(DiscoverButtonMetrics.labelColor)
			.padding(.leading, DiscoverButtonMetrics.leadingPadding)
			.padding(.trailing, DiscoverButtonMetrics.trailingPadding)
			.padding(.vertical, DiscoverButtonMetrics.verticalPadding)
			.frame(minHeight: DiscoverButtonMetrics.height)
			.background(fill, in: shape)
			.opacity(isEnabled ? 1 : Track1ButtonColors.disabledOpacity)
			.contentShape(shape)
	}
}
