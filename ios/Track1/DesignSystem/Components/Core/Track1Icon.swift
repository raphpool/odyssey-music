import SwiftUI

/// Figma `Icon` (`14:2`, doc `170:78`): monochrome UI glyphs on a 20 pt frame, mapped to SF Symbols in code
/// (the doc's CODE line). A glyph is chosen by meaning; its color comes from a `Tone`, never from a variant
/// per color. The icon is decorative: the control that wraps it carries the accessibility label.
struct Track1Icon: View {
	/// Declaration order is the order of the Figma Icon frame and of its doc. `arrowDownRight` comes last: it
	/// is the icon added to the Figma frame after the others, for the "Tous" chip (TRA-636).
	enum Glyph: CaseIterable {
		case check, chevronDown, chevronRight, close, home, more, musicNote, play, search, arrowDownRight

		var systemName: String {
			switch self {
			case .check: "checkmark"
			case .chevronDown: "chevron.down"
			case .chevronRight: "chevron.right"
			case .close: "xmark"
			case .home: "house"
			case .more: "ellipsis"
			case .musicNote: "music.note"
			case .play: "play.fill"
			case .search: "magnifyingglass"
			case .arrowDownRight: "arrow.down.right"
			}
		}
	}

	/// Icons drawn for the Figma tab bar (`282:889`), which no SF Symbol matches. Each case is the name of an
	/// image set in `Assets.xcassets/Tab` (namespaced folder, hence the slash); the images are templates, so
	/// their color comes from a `Tone`.
	enum Asset: String, CaseIterable {
		case tabToday = "Tab/Today"
		case tabGenres = "Tab/Genres"
		case tabSearch = "Tab/Search"
	}

	/// Maps to the `theme.color.icon.*` tokens: primary, secondary (inactive tab), inverse (on bone buttons),
	/// action (active tab).
	enum Tone: CaseIterable {
		case primary, secondary, inverse, action

		var color: Color {
			switch self {
			case .primary: Track1Tokens.colorIconPrimary
			case .secondary: Track1Tokens.colorIconSecondary
			case .inverse: Track1Tokens.colorIconInverse
			case .action: Track1Tokens.colorIconAction
			}
		}
	}

	/// Frame of a standalone icon (`size/icon-medium`). Buttons draw it at `size/icon-large` in Size=Large.
	static let defaultSize = Track1Tokens.sizeIconMedium

	private enum Source {
		case glyph(Glyph)
		case asset(Asset)
	}

	private let source: Source
	private let color: Color
	private let size: CGFloat

	init(_ glyph: Glyph, tone: Tone = .primary, size: CGFloat = Track1Icon.defaultSize) {
		self.init(glyph, color: tone.color, size: size)
	}

	/// For controls whose glyph follows the label color of their state (disabled included), which no `Tone`
	/// covers.
	init(_ glyph: Glyph, color: Color, size: CGFloat = Track1Icon.defaultSize) {
		self.source = .glyph(glyph)
		self.color = color
		self.size = size
	}

	init(asset: Asset, tone: Tone = .primary, size: CGFloat = Track1Icon.defaultSize) {
		self.source = .asset(asset)
		self.color = tone.color
		self.size = size
	}

	var body: some View {
		icon
			.foregroundStyle(color)
			.frame(width: size, height: size)
			.accessibilityHidden(true)
	}

	@ViewBuilder
	private var icon: some View {
		switch source {
		case .glyph(let glyph):
			Image(systemName: glyph.systemName)
				// The Figma glyphs sit on a 24 pt grid with a heavy stroke inside a 20 pt frame.
				.font(.system(size: size * 0.8, weight: .semibold))
		case .asset(let asset):
			Image(asset.rawValue)
				.renderingMode(.template)
				.resizable()
				.scaledToFit()
		}
	}
}
