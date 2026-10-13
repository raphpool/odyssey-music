import SwiftUI

/// Figma `ListItem` (`22:142`, doc `174:192`): a dense tappable row for search suggestions, related content
/// and destination lists. The whole row is the tap target; a chevron means it navigates to another screen.
/// Pressed comes from the button style and Disabled from the `isEnabled` environment, like `Track1Button`.
/// Titles and subtitles are third-party data, so they are always shown verbatim.
struct Track1ListItem: View {
	/// Figma `Accessory`.
	enum Accessory: CaseIterable {
		case none, chevron
	}

	private let title: String
	private let subtitle: String?
	private let artwork: Track1Artwork?
	private let accessory: Accessory
	private let action: () -> Void

	init(
		title: String, subtitle: String? = nil, artwork: Track1Artwork? = nil, accessory: Accessory = .none,
		action: @escaping () -> Void
	) {
		self.title = title
		self.subtitle = subtitle
		self.artwork = artwork
		self.accessory = accessory
		self.action = action
	}

	/// Figma `Type=Standard` rows are 60 pt high, `Type=Artwork` rows 80 pt. A minimum, not a fixed height:
	/// the row grows with Dynamic Type instead of clipping its text, and stays above 44 pt.
	static func minHeight(hasArtwork: Bool) -> CGFloat {
		hasArtwork ? 80 : 60
	}

	static func accessibilityLabel(title: String, subtitle: String?) -> String {
		[title, subtitle].compactMap { $0 }.joined(separator: ", ")
	}

	var body: some View {
		Button(action: action) {
			EmptyView()
		}
		.buttonStyle(Track1ListItemStyle(title: title, subtitle: subtitle, artwork: artwork, accessory: accessory))
	}
}

/// The 3 State variants of Figma `ListItem`: Default `22:2`, Pressed `22:10`, Disabled `22:18` (the Artwork
/// and Chevron variants share them). The Disabled colors come with a 42 % opacity on the whole row.
enum Track1ListItemColors {
	typealias Resolved = (fill: Color, title: Color, subtitle: Color)

	/// Same `theme.opacity.disabled` as the buttons: Figma applies it to the whole row, on top of the
	/// disabled text color.
	static let disabledOpacity = Track1ButtonColors.disabledOpacity

	static func resolve(state: Track1ControlState) -> Resolved {
		switch state {
		case .normal:
			(Track1Tokens.colorActionGhost, Track1Tokens.colorTextPrimary, Track1Tokens.colorTextSecondary)
		case .pressed:
			(Track1Tokens.colorSurfacePressed, Track1Tokens.colorTextPrimary, Track1Tokens.colorTextSecondary)
		case .disabled:
			(Track1Tokens.colorActionGhost, Track1Tokens.colorTextDisabled, Track1Tokens.colorTextDisabled)
		}
	}

	static func opacity(state: Track1ControlState) -> Double {
		state == .disabled ? disabledOpacity : 1
	}
}

/// Draws the whole row: the style owns the layout because the text colors depend on the state.
private struct Track1ListItemStyle: ButtonStyle {
	let title: String
	let subtitle: String?
	let artwork: Track1Artwork?
	let accessory: Track1ListItem.Accessory

	func makeBody(configuration: Configuration) -> some View {
		Track1ListItemBody(
			title: title, subtitle: subtitle, artwork: artwork, accessory: accessory,
			isPressed: configuration.isPressed)
	}
}

/// A view of its own because `isEnabled` is an environment value, which a `ButtonStyle` cannot read.
private struct Track1ListItemBody: View {
	let title: String
	let subtitle: String?
	let artwork: Track1Artwork?
	let accessory: Track1ListItem.Accessory
	let isPressed: Bool
	@Environment(\.isEnabled) private var isEnabled

	var body: some View {
		let state = Track1ControlState(isEnabled: isEnabled, isPressed: isPressed)
		let colors = Track1ListItemColors.resolve(state: state)
		let shape = RoundedRectangle(cornerRadius: Track1Tokens.radius12, style: .continuous)
		HStack(spacing: Track1Tokens.spacing12) {
			if let artwork { artwork }
			VStack(alignment: .leading, spacing: Track1Tokens.spacing2) {
				Track1Text(title, role: .labelMedium, verbatim: true).foregroundStyle(colors.title)
				if let subtitle {
					Track1Text(subtitle, role: .bodySmall, verbatim: true).foregroundStyle(colors.subtitle)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			if accessory == .chevron { Track1Icon(.chevronRight) }
		}
		.padding(.horizontal, Track1Tokens.spacing16)
		// 8 pt around the 40 pt text block puts a Standard row under its 60 pt minimum, as in Figma.
		.padding(.vertical, Track1Tokens.spacing8)
		.frame(minHeight: Track1ListItem.minHeight(hasArtwork: artwork != nil))
		.background(colors.fill, in: shape)
		.opacity(Track1ListItemColors.opacity(state: state))
		.contentShape(shape)
		// One spoken label from the title and the subtitle: the artwork's own label would repeat the title and
		// its image trait does not belong on a button (TRA-388 review).
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Track1ListItem.accessibilityLabel(title: title, subtitle: subtitle))
	}
}
