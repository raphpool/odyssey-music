import SwiftUI
import Track1Core

/// Measures of Figma `338:2493` (file `phudxrQNlzQJafXLma4FyX`, 306.3 x 50, TRA-728). The ticket wins.
enum PlayerNowBarMetrics {
	static let identifier = "player-now-bar"

	static func buttonIdentifier(for provider: ListeningProvider) -> String {
		"player-open-\(provider.rawValue)"
	}

	/// `#FFFFFF` at 15 %. No border and no blur material.
	static let fill = Track1Tokens.colorGlassPill
	static let cornerRadius = Track1Tokens.radiusFull
	static let horizontalPadding = Track1Tokens.spacing20
	static let verticalPadding = Track1Tokens.spacing4
	static let blockSpacing = Track1Tokens.spacing16
	/// A floor, not a fixed height: the pill grows with Dynamic Type and centers a title with no artist.
	static let height: CGFloat = 50
	/// Width of the mockup. The bar is as wide as its content; the page centers it.
	static let designWidth: CGFloat = 306.3
	/// `338:2517`, square, no corner radius.
	static let coverSize: CGFloat = 30.881
	static let textSpacing = Track1Tokens.spacing0
	static let titleRole = Track1TextRole.monoBarTitle
	static let titleColor = Track1Tokens.colorTextPrimary
	static let artistRole = Track1TextRole.bodySmall
	static let artistColor = Track1Tokens.colorTextPrimary
	static let logoSize: CGFloat = 17.6
	static let arrowSize: CGFloat = 18.7
	static let arrowColor = Track1Tokens.colorIconPrimary
	static let markSpacing: CGFloat = 4.4
	static let minimumTouchTarget = Track1Tokens.sizeControlMedium

	static var serviceVisualSize: CGSize {
		CGSize(width: logoSize + markSpacing + arrowSize, height: max(logoSize, arrowSize))
	}

	/// How far a touch area reaches past what is drawn, on each side, to make 44 x 44.
	static var touchOutset: CGSize {
		CGSize(
			width: max(0, (minimumTouchTarget - serviceVisualSize.width) / 2),
			height: max(0, (minimumTouchTarget - serviceVisualSize.height) / 2))
	}
}

/// Figma `338:2493`: the bar that stays above the tab bar in the player. It loads no cover, validates no URL
/// (`ListeningActions` did) and opens nothing: it hands the chosen action back. Placing it is the page's job.
struct PlayerNowBar: View {
	private let title: String
	private let artist: String?
	private let cover: Image?
	private let isOpening: Bool
	private let open: (ListeningAction) -> Void

	/// Apple Music, then Spotify, whatever the order `ListeningActions` returns.
	let buttonActions: [ListeningAction]

	init(
		title: String, artist: String?, cover: Image?, actions: [ListeningAction], isOpening: Bool,
		open: @escaping (ListeningAction) -> Void
	) {
		self.title = title
		self.artist = artist
		self.cover = cover
		self.buttonActions = StreamingBar.ordered(actions)
		self.isOpening = isOpening
		self.open = open
	}

	/// `nil` for a missing or blank artist: an empty line would still take 18 pt.
	var shownArtist: String? {
		guard let artist, !artist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
		return artist
	}

	/// While a link opens, a second tap must not open it twice.
	var buttonsAreDisabled: Bool { isOpening }

	/// The action title ("Écouter sur ..." or "Rechercher sur ...") tells an exact link from a search.
	static func accessibilityLabel(for action: ListeningAction) -> String {
		action.title
	}

	var body: some View {
		HStack(spacing: PlayerNowBarMetrics.blockSpacing) {
			coverView
			textBlock
			ForEach(buttonActions, id: \.provider) { action in
				PlayerOpenButton(action: action) { open(action) }
			}
		}
		.padding(.horizontal, PlayerNowBarMetrics.horizontalPadding)
		.padding(.vertical, PlayerNowBarMetrics.verticalPadding)
		.frame(minHeight: PlayerNowBarMetrics.height)
		.background(
			PlayerNowBarMetrics.fill,
			in: RoundedRectangle(cornerRadius: PlayerNowBarMetrics.cornerRadius, style: .continuous)
		)
		.disabled(buttonsAreDisabled)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier(PlayerNowBarMetrics.identifier)
	}

	@ViewBuilder
	private var coverView: some View {
		let side = PlayerNowBarMetrics.coverSize
		if let cover {
			cover.resizable().scaledToFill().frame(width: side, height: side).clipped()
				.accessibilityHidden(true)
		} else {
			// `Track1Artwork` has three fixed sizes: the smallest (48) is scaled down to the cover, so the bar
			// measures the same with or without an image. It keeps its own corner radius, scaled with it.
			Track1Artwork(
				state: .unavailable, size: .small, shape: .square, fallback: .musicNote, accessibilityLabel: ""
			)
			.scaleEffect(side / Track1Artwork.Size.small.points)
			.frame(width: side, height: side)
			.accessibilityHidden(true)
		}
	}

	private var textBlock: some View {
		VStack(alignment: .leading, spacing: PlayerNowBarMetrics.textSpacing) {
			// Both lines come from the network: `verbatim` keeps them from being read as a key or Markdown. One
			// line each, cut at the end, so that the buttons never leave the pill.
			Track1Text(title, role: PlayerNowBarMetrics.titleRole, verbatim: true)
				.foregroundStyle(PlayerNowBarMetrics.titleColor)
				.lineLimit(1)
			if let shownArtist {
				Track1Text(shownArtist, role: PlayerNowBarMetrics.artistRole, verbatim: true)
					.foregroundStyle(PlayerNowBarMetrics.artistColor)
					.lineLimit(1)
			}
		}
		.truncationMode(.tail)
		.accessibilityElement(children: .combine)
	}
}

/// One service: its brand mark (never recolored, Figma `169:122`) and the outgoing arrow, drawn at the sizes
/// of the mockup in a button whose touch area is at least 44 x 44.
private struct PlayerOpenButton: View {
	let action: ListeningAction
	let open: () -> Void
	@State private var taps = 0
	@Environment(\.isEnabled) private var isEnabled

	var body: some View {
		let outset = PlayerNowBarMetrics.touchOutset
		Button {
			taps += 1
			open()
		} label: {
			HStack(spacing: PlayerNowBarMetrics.markSpacing) {
				Image(StreamingButton.logoName(for: action.provider))
					.resizable()
					.scaledToFit()
					.frame(width: PlayerNowBarMetrics.logoSize, height: PlayerNowBarMetrics.logoSize)
					.accessibilityHidden(true)
				// The Figma arrow is `arrow-down-right` flipped vertically.
				Track1Icon(
					.arrowDownRight, color: PlayerNowBarMetrics.arrowColor, size: PlayerNowBarMetrics.arrowSize
				)
				.scaleEffect(x: 1, y: -1)
			}
			// Pad out to 44 x 44 for the hit area, then take the room back: the parent lays out what is drawn,
			// so the 16 pt between services and the 50 pt of the pill hold.
			.padding(.horizontal, outset.width)
			.padding(.vertical, outset.height)
			.contentShape(Rectangle())
			.padding(.horizontal, -outset.width)
			.padding(.vertical, -outset.height)
		}
		.buttonStyle(PlayerOpenButtonStyle(isEnabled: isEnabled))
		.sensoryFeedback(.impact(weight: .light), trigger: taps)
		.accessibilityLabel(PlayerNowBar.accessibilityLabel(for: action))
		.accessibilityIdentifier(PlayerNowBarMetrics.buttonIdentifier(for: action.provider))
	}
}

/// Figma draws no Disabled state here: it takes the opacity of the other buttons. A custom style is the only
/// source of it, so that the system never dims the label a second time.
private struct PlayerOpenButtonStyle: ButtonStyle {
	let isEnabled: Bool

	func makeBody(configuration: Configuration) -> some View {
		configuration.label.opacity(isEnabled ? 1 : Track1ButtonColors.disabledOpacity)
	}
}
