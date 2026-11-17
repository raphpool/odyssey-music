import SwiftUI
import Track1Core

/// Measures of Figma `324:1788` (file `phudxrQNlzQJafXLma4FyX`, 393 x 844, TRA-736). The ticket wins.
/// Both blocks are placed from the top of the screen, status bar included, as the mock-up is.
enum TodayHomeMetrics {
	static let identifier = "today-home"
	static let titleIdentifier = "today-title"

	/// `324:1817`: the date, then the genres, centred and 16 apart.
	static let topBlockTop: CGFloat = 72
	static let topBlockWidth: CGFloat = 345
	static let topBlockSpacing = Track1Tokens.spacing16

	/// `324:1804`: the cover, the type, the title block and the button, centred and 12 apart.
	static let mainBlockTop: CGFloat = 222
	static let mainBlockWidth: CGFloat = 343
	static let mainBlockSpacing = Track1Tokens.spacing12

	/// `324:1808`: a square without radius, and its shadow `0 0 18.982 7.593` (blur, then spread).
	static let coverSide: CGFloat = 308.808
	static let coverShadowBlur: CGFloat = 18.982
	static let coverShadowSpread: CGFloat = 7.593
	static let coverShadowColor = Track1Tokens.colorCoverShadow

	/// `324:1811` and `324:1812`, 6 apart.
	static let titleRole = Track1TextRole.title2
	static let subtitleRole = Track1TextRole.bodyMedium
	static let subtitleSpacing = Track1Tokens.spacing6

	/// The mock-up frame, and where its tab bar starts (`324:1792`): the card ends above it.
	static let designHeight: CGFloat = 844
	static let tabBarTop: CGFloat = 749
	/// Room under the card once it scrolls (a short screen). Not measured on the mock-up, which has no scroll.
	static let bottomPadding = Track1Tokens.spacing24

	/// `324:1790`: the same four-stop gradient as the reader's (`338:2463`), so `PlayerMetrics` draws it.
	static let tintHeight = PlayerMetrics.tintHeight

	/// `nil` without a tint: the screen is then `background.elevated` alone.
	static func tintStops(_ tint: CoverTint?) -> [Gradient.Stop]? {
		tint.map(PlayerMetrics.tintStops)
	}

	/// The Artwork of the "unavailable" state at the size of the cover: `Track1Artwork` only draws 48, 64 and
	/// 96 pt, and scaling it would round the corners the cover does not have, so its colours and its glyph
	/// (in the same share of the side as the large Artwork) are drawn here.
	static var placeholderGlyphSize: CGFloat {
		Track1Artwork.Size.large.glyphSize * coverSide / Track1Artwork.Size.large.points
	}

	/// What the main block adds up to at the default text size: the type tag, the two text lines and the button
	/// are the heights of the mock-up (25, 28 + 6 + 22, 44).
	static var mainBlockHeight: CGFloat {
		let title = titleRole.lineHeight + subtitleSpacing + subtitleRole.lineHeight
		let children = [coverSide, NodeTypeBadge.tagRole.lineHeight, title, DiscoverButtonMetrics.height]
		return children.reduce(0, +) + mainBlockSpacing * CGFloat(children.count - 1)
	}
}

/// What the home draws for what it is given, apart from the view so that the tests pin it.
enum TodayHomeContent {
	enum Cover: Equatable {
		case image, placeholder
	}

	static func cover(hasImage: Bool) -> Cover {
		hasImage ? .image : .placeholder
	}

	/// No genre, no row: nothing is reserved for it.
	static func showsGenres(of home: TodayHome) -> Bool {
		!home.genres.isEmpty
	}

	/// The line under the title is left out when there is no artist and no year.
	static func subtitle(of home: TodayHome) -> String? {
		guard let subtitle = home.subtitle, !subtitle.isEmpty else { return nil }
		return subtitle
	}

	static func coverAccessibilityLabel(title: String) -> String {
		"Pochette de \(title)"
	}
}

/// Which screen the Today tab shows. The node of the recommendation is read before the home is drawn, and a
/// node that cannot be read is the retry status, never an empty card.
enum TodayHomeScreen: Equatable {
	case loading, home, emptyCatalog, unavailable

	/// What reading the node of a recommendation gave, for that recommendation.
	enum NodeOutcome: Equatable {
		case ready(UUID)
		case failed(UUID)
	}

	/// An outcome only counts for the recommendation it was read for: the one of another taste must not show
	/// yesterday's node. Until the matching one arrives the loading screen stays, and `isRetrying` brings it
	/// back for a retry whose result is not in yet.
	static func choose(state: TodayState, outcome: NodeOutcome?, isRetrying: Bool) -> TodayHomeScreen {
		if isRetrying { return .loading }
		switch state {
		case .loading:
			return .loading
		case .recommendation(let recommendation):
			switch outcome {
			case .ready(let id) where id == recommendation.recommendationID: return .home
			case .failed(let id) where id == recommendation.recommendationID: return .unavailable
			default: return .loading
			}
		case .emptyCatalog:
			return .emptyCatalog
		case .unavailable:
			return .unavailable
		}
	}
}

/// The home of the day (Figma `324:1788`): the date and the genres, then the cover, the type, the title and
/// "Découvrir". Every string comes from `TodayHome` and is drawn as it is. It scrolls only when the card does
/// not fit the screen.
struct TodayHomeView: View {
	private typealias Metrics = TodayHomeMetrics

	private let home: TodayHome
	private let tint: CoverTint?
	private let cover: Image?
	private let isOpening: Bool
	private let discover: () -> Void

	init(home: TodayHome, tint: CoverTint?, cover: Image?, isOpening: Bool, discover: @escaping () -> Void) {
		self.home = home
		self.tint = tint
		self.cover = cover
		self.isOpening = isOpening
		self.discover = discover
	}

	var body: some View {
		ScrollView {
			VStack(spacing: 0) {
				topBlock
					.frame(maxWidth: Metrics.topBlockWidth)
					// The main block starts at 222 whatever the height of the top one, unless that one grows past it.
					.frame(minHeight: Metrics.mainBlockTop - Metrics.topBlockTop, alignment: .top)
				mainBlock
					.frame(maxWidth: Metrics.mainBlockWidth)
			}
			.padding(.top, Metrics.topBlockTop)
			.padding(.bottom, Metrics.bottomPadding)
			.frame(maxWidth: .infinity)
			// `.contain`: an identifier on a container would overwrite those of its children (TRA-659). On the
			// column and not on the `ScrollView`, as `NodeContentCard` does: a scroll view is a platform
			// container of its own.
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier(Metrics.identifier)
		}
		.scrollBounceBehavior(.basedOnSize)
		.background(alignment: .top) { backdrop }
		.ignoresSafeArea(.container, edges: .top)
	}

	/// `background.elevated` under everything, and the tint of the cover over its first 15 %.
	private var backdrop: some View {
		ZStack(alignment: .top) {
			Track1Tokens.colorBackgroundElevated
			if let stops = Metrics.tintStops(tint) {
				LinearGradient(stops: stops, startPoint: .top, endPoint: .bottom)
					.frame(height: Metrics.tintHeight)
			}
		}
		.ignoresSafeArea()
	}

	private var topBlock: some View {
		VStack(spacing: Metrics.topBlockSpacing) {
			DateBadge(day: home.day, month: home.month)
			if TodayHomeContent.showsGenres(of: home) {
				GenrePillRow(genres: home.genres)
			}
		}
	}

	private var mainBlock: some View {
		VStack(spacing: Metrics.mainBlockSpacing) {
			coverView
			NodeTypeBadge(type: home.type)
			titleBlock
			DiscoverButton(isLoading: isOpening, action: discover)
		}
	}

	@ViewBuilder
	private var coverView: some View {
		let side = Metrics.coverSide
		Group {
			switch TodayHomeContent.cover(hasImage: cover != nil) {
			case .image:
				if let cover {
					cover.resizable().scaledToFill()
						.frame(width: side, height: side)
						.clipped()
						.accessibilityElement(children: .ignore)
						.accessibilityLabel(Text(verbatim: TodayHomeContent.coverAccessibilityLabel(title: home.title)))
						.accessibilityAddTraits(.isImage)
				}
			case .placeholder:
				placeholder.accessibilityHidden(true)
			}
		}
		.frame(width: side, height: side)
		.background {
			// The spread grows the shape that the blur is drawn from: `shadow` has none of its own.
			Rectangle()
				.fill(Metrics.coverShadowColor)
				.frame(
					width: side + 2 * Metrics.coverShadowSpread, height: side + 2 * Metrics.coverShadowSpread
				)
				.blur(radius: Metrics.coverShadowBlur / 2)
		}
	}

	/// `Track1Artwork` in its unavailable state, square and at the size of the cover.
	private var placeholder: some View {
		let style = Track1ArtworkStyle.resolve(.unavailable)
		return ZStack {
			Rectangle().fill(style.fill)
			if let glyph = style.glyph {
				Track1Icon(.musicNote, color: glyph, size: Metrics.placeholderGlyphSize)
			}
		}
		.overlay {
			if let border = style.border { Rectangle().strokeBorder(border, lineWidth: 1) }
		}
	}

	private var titleBlock: some View {
		VStack(spacing: Metrics.subtitleSpacing) {
			Track1Text(home.title, role: Metrics.titleRole, verbatim: true)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
				.accessibilityIdentifier(Metrics.titleIdentifier)
				.accessibilityAddTraits(.isHeader)
			if let subtitle = TodayHomeContent.subtitle(of: home) {
				Track1Text(subtitle, role: Metrics.subtitleRole, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextSecondary)
			}
		}
		.multilineTextAlignment(.center)
		.frame(maxWidth: .infinity)
	}
}
