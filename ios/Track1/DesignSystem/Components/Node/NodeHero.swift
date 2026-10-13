import SwiftUI
import Track1Core
import UIKit

/// Figma `Hero` (ensemble `171:34`, doc `171:36`): the visual anchor of a node page, one variant per node
/// family. `release` (project and track) is a jewel case with a partially exposed disc whose label takes the
/// dominant color of the cover; `artist` is a circular photo; `cover` (genre and label) is a square cover.
/// It is centered, 16 pt below the Top bar, and "never crops the case". The caller supplies the decoded image
/// and the tint (from `NodeHeroModel`), like `Track1Artwork`: this view never loads anything. Without an
/// image (loading or unavailable) each variant keeps its own gradient placeholder.
struct NodeHero: View {
	typealias Kind = NodeHeroKind

	/// `node-hero`.
	static let identifier = "node-hero"
	/// Doc `171:36`: "Center horizontally; 16pt below the top bar", `theme.spacing.16`. Part of the hero, so
	/// the page stacks it right under the Top bar without adding a gap of its own.
	static let topInset = Track1Tokens.spacing16

	private let kind: Kind
	private let image: Track1Artwork.State
	private let discTint: Color?
	private let accessibilityLabel: String?

	/// `discTint` only matters to `release`. `accessibilityLabel` is the node name: without one the hero is
	/// still addressable by its identifier, but it is not announced as an image.
	init(kind: Kind, image: Track1Artwork.State, discTint: Color? = nil, accessibilityLabel: String? = nil) {
		self.kind = kind
		self.image = image
		self.discTint = discTint
		self.accessibilityLabel = accessibilityLabel
	}

	/// Only a decoded image replaces the placeholder.
	static func decodedImage(for state: Track1Artwork.State) -> UIImage? {
		if case .image(let image) = state { image } else { nil }
	}

	var body: some View {
		content
			.frame(width: kind.size.width, height: kind.size.height)
			.accessibilityElement(children: .ignore)
			.accessibilityIdentifier(Self.identifier)
			.modifier(HeroAccessibility(label: accessibilityLabel, hasImage: Self.decodedImage(for: image) != nil))
			.frame(maxWidth: .infinity)
			.padding(.top, Self.topInset)
	}

	@ViewBuilder
	private var content: some View {
		switch kind {
		case .release:
			ReleaseHero(image: Self.decodedImage(for: image), tint: discTint ?? NodeHeroStyle.defaultDiscTint)
		case .artist:
			HeroPhoto(image: Self.decodedImage(for: image), kind: kind, shape: Circle())
		case .cover:
			HeroPhoto(
				image: Self.decodedImage(for: image), kind: kind,
				shape: RoundedRectangle(cornerRadius: NodeHeroMetrics.coverCornerRadius, style: .continuous))
		}
	}
}

extension NodeHeroKind {
	/// Figma frame of each variant: Release `171:2` is 276 x 183.227 pt, Artist `171:30` and Cover `171:31`
	/// are `size/hero-artwork`, 164 pt square. The ticket rounds the release height to 183.
	var size: CGSize {
		switch self {
		case .release: CGSize(width: NodeHeroMetrics.releaseWidth, height: NodeHeroMetrics.releaseHeight)
		case .artist, .cover: CGSize(width: Track1Tokens.sizeHeroArtwork, height: Track1Tokens.sizeHeroArtwork)
		}
	}
}

/// Measurements read on 2026-10-13 from Figma `171:2` (jewel case `171:15`, disc `171:4`) and `171:30`,
/// `171:31`. Only `size/hero-artwork` has a token: the jewel case and the disc are an illustration drawn at
/// fixed proportions. The case parts are measured in the case's own frame, the disc rings in the disc's.
enum NodeHeroMetrics {
	static let releaseWidth: CGFloat = 276
	static let releaseHeight: CGFloat = 183.227
	/// Figma rounds the Cover corners to 4 pt, which no `theme.radius` token matches (0, 8, 12, 16, 20).
	static let coverCornerRadius: CGFloat = 4
	/// Border of the Artist and Cover variants: Figma draws 1 pt in `theme.color.glass.border`.
	static let photoBorderWidth: CGFloat = 1

	/// Jewel case `171:15` in the release frame; its cover `171:28`, lid rim `171:18` and spine `171:19`.
	static let caseFrame = CGRect(x: 2.4, y: 0, width: 199.027, height: 175.2)
	static let caseCover = CGRect(x: 30.09, y: 6.26, width: 162.682, height: 162.682)
	static let lidRim = CGRect(x: 0.68, y: 0.7, width: 197.659, height: 173.808)
	static let spine = CGRect(x: 2.74, y: 2.78, width: 24.616, height: 169.6)

	/// Partially exposed disc `171:4` in the release frame, then its rings from the outside in.
	static let discFrame = CGRect(x: 111.2, y: 6.4, width: 159.635, height: 162.4)
	static let discOuterEdge = CGRect(x: 1.18, y: 1.2, width: 157.27, height: 159.994)
	static let discBoundary = CGRect(x: 4.14, y: 4.21, width: 151.358, height: 153.979)
	static let discGrooveOuter = CGRect(x: 5.91, y: 6.01, width: 147.811, height: 150.37)
	static let discGrooveInner = CGRect(x: 8.28, y: 8.42, width: 143.081, height: 145.559)
	static let discLabelTint = CGRect(x: 47.3, y: 48.12, width: 65.037, height: 66.163)
	static let discLabelEdge = CGRect(x: 47.89, y: 48.72, width: 63.854, height: 64.96)
	static let discHubBoundary = CGRect(x: 62.67, y: 63.76, width: 34.292, height: 34.886)
	static let discClearHub = CGRect(x: 69.18, y: 70.37, width: 21.285, height: 21.653)
	static let discCenterOpening = CGRect(x: 74.5, y: 75.79, width: 10.642, height: 10.827)
}

/// Colors of the hero. The placeholders are the three art-direction gradients of Figma (135 degrees over
/// three stops at 0, 35.714 and 71.429 %, which CSS holds to the end), built from tokens.
enum NodeHeroStyle {
	/// Figma: "No image at all -> keep the gradient placeholder of the variant". `Release` `171:28` and the
	/// Release card cover `172:17` share the first one.
	static func placeholderStops(for kind: NodeHeroKind) -> [Gradient.Stop] {
		let colors: (Color, Color, Color) =
			switch kind {
			case .release:
				(Track1Tokens.colorNodeProject, Track1Tokens.colorNodeTrack, Track1Tokens.colorSurfaceDefault)
			case .artist:
				(Track1Tokens.colorNodeArtist, Track1Tokens.colorSurfacePressed, Track1Tokens.colorBackgroundBase)
			case .cover:
				(Track1Tokens.colorNodeGenre, Track1Tokens.colorNodeProject, Track1Tokens.colorBackgroundBase)
			}
		return [
			.init(color: colors.0, location: 0), .init(color: colors.1, location: 0.35714),
			.init(color: colors.2, location: 0.71429), .init(color: colors.2, location: 1),
		]
	}

	/// 135 degrees on a square box runs from corner to corner.
	static func placeholder(for kind: NodeHeroKind) -> LinearGradient {
		LinearGradient(stops: placeholderStops(for: kind), startPoint: .topLeading, endPoint: .bottomTrailing)
	}

	/// The label of a disc whose cover has no dominant color yet: the orange of the Release placeholder
	/// (`171:10`), so the disc matches the cover it sits next to.
	static let defaultDiscTint = Track1Tokens.colorNodeTrack
}

/// A gradient placeholder with the decoded image over it: the one cover drawing of every variant and of the
/// Release card. The caller clips it and draws the border.
struct HeroCoverFill: View {
	let image: UIImage?
	let kind: NodeHeroKind
	let size: CGSize

	var body: some View {
		Rectangle()
			.fill(NodeHeroStyle.placeholder(for: kind))
			.overlay {
				if let image {
					Image(uiImage: image).resizable().scaledToFill().frame(width: size.width, height: size.height)
						.clipped()
				}
			}
			.frame(width: size.width, height: size.height)
	}
}

extension View {
	/// Places a view by its Figma rectangle inside a top-leading container.
	fileprivate func placed(_ rect: CGRect) -> some View {
		frame(width: rect.width, height: rect.height).offset(x: rect.minX, y: rect.minY)
	}
}

/// The hero is one element: its label is the node name, and only a real image carries the image trait.
private struct HeroAccessibility: ViewModifier {
	let label: String?
	let hasImage: Bool

	func body(content: Content) -> some View {
		if let label {
			content.accessibilityLabel(Text(verbatim: label)).accessibilityAddTraits(hasImage ? .isImage : [])
		} else {
			content
		}
	}
}

/// Artist and Cover: a 164 pt photo or cover in a circle or a square, with a glass border.
private struct HeroPhoto<ClipShape: InsettableShape>: View {
	let image: UIImage?
	let kind: NodeHeroKind
	let shape: ClipShape

	var body: some View {
		HeroCoverFill(image: image, kind: kind, size: kind.size)
			.clipShape(shape)
			.overlay { shape.strokeBorder(Track1Tokens.colorGlassBorder, lineWidth: NodeHeroMetrics.photoBorderWidth) }
	}
}

/// Release: the disc comes out of the case on the right, and the case is drawn over it, whole.
private struct ReleaseHero: View {
	let image: UIImage?
	let tint: Color

	var body: some View {
		ZStack(alignment: .topLeading) {
			HeroDisc(tint: tint).placed(NodeHeroMetrics.discFrame)
			HeroJewelCase(image: image).placed(NodeHeroMetrics.caseFrame)
		}
		.frame(width: NodeHeroMetrics.releaseWidth, height: NodeHeroMetrics.releaseHeight, alignment: .topLeading)
	}
}

/// The compact disc of `171:4` as concentric ellipses, redrawn from the Figma rectangles because a vector
/// export would not take the runtime tint. Colors are read by eye on the render (no vector is downloaded).
/// A line width of 0 fills the ring. The surface is a conic silver.
private struct HeroDisc: View {
	let tint: Color

	var body: some View {
		let silver = AngularGradient(
			colors: [
				Color(white: 0.95), Color(white: 0.72), Color(white: 0.9), Color(white: 0.66), Color(white: 0.95),
			],
			center: .center)
		let groove = Color.black.opacity(0.1)
		let rings: [(CGRect, AnyShapeStyle, CGFloat)] = [
			(CGRect(origin: .zero, size: NodeHeroMetrics.discFrame.size), AnyShapeStyle(silver), 0),
			(NodeHeroMetrics.discOuterEdge, AnyShapeStyle(Color.white.opacity(0.6)), 1),
			(NodeHeroMetrics.discBoundary, AnyShapeStyle(groove), 0.5),
			(NodeHeroMetrics.discGrooveOuter, AnyShapeStyle(groove), 0.5),
			(NodeHeroMetrics.discGrooveInner, AnyShapeStyle(groove), 0.5),
			(NodeHeroMetrics.discLabelTint, AnyShapeStyle(tint), 0),
			(NodeHeroMetrics.discLabelEdge, AnyShapeStyle(Color.white.opacity(0.35)), 1),
			(NodeHeroMetrics.discHubBoundary, AnyShapeStyle(Color(white: 0.85)), 0),
			(NodeHeroMetrics.discClearHub, AnyShapeStyle(Color(white: 0.96)), 0),
			(NodeHeroMetrics.discCenterOpening, AnyShapeStyle(Track1Tokens.colorBackgroundBase), 0),
		]
		ZStack(alignment: .topLeading) {
			ForEach(rings.indices, id: \.self) { index in
				let (rect, style, lineWidth) = rings[index]
				Group {
					if lineWidth > 0 {
						Ellipse().strokeBorder(style, lineWidth: lineWidth)
					} else {
						Ellipse().fill(style)
					}
				}
				.placed(rect)
			}
		}
	}
}

/// The jewel case `171:15`: a glass shell, the cover inside, a lid rim and the hinge spine, with the raw
/// values of its Figma layers (read 2026-10-13).
private struct HeroJewelCase: View {
	let image: UIImage?

	var body: some View {
		let shell = RoundedRectangle(cornerRadius: 4.32, style: .continuous)
		ZStack(alignment: .topLeading) {
			// Molded plastic shell `171:16`. Figma also blurs the disc behind it by 9.658 pt, which only
			// reaches the few points of glass around the cover: left out, like the -6.899 pt shadow spread.
			shell.fill(Self.glass)
				.overlay { shell.strokeBorder(Track1Tokens.colorGlassBorder, lineWidth: 0.69) }
				.shadow(color: .black.opacity(0.18), radius: 20.696 / 2, x: 0, y: 8.278)
			// The cover sits inside the case and is never larger than it.
			HeroCoverFill(image: image, kind: .release, size: NodeHeroMetrics.caseCover.size)
				.overlay { Rectangle().strokeBorder(Self.coverBorder, lineWidth: 0.401) }
				.offset(x: NodeHeroMetrics.caseCover.minX, y: NodeHeroMetrics.caseCover.minY)
			RoundedRectangle(cornerRadius: 3.449, style: .continuous)
				.strokeBorder(.white.opacity(0.68), lineWidth: 0.759)
				.placed(NodeHeroMetrics.lidRim)
			HeroSpine().placed(NodeHeroMetrics.spine)
		}
	}

	/// Shell fill, left to right: 22 % white, a pale blue-grey at 45 %, 41 % white.
	private static let glass = LinearGradient(
		stops: [
			.init(color: .white.opacity(0.22), location: 0),
			.init(color: Color(red: 169 / 255, green: 186 / 255, blue: 192 / 255).opacity(0.1), location: 0.45),
			.init(color: .white.opacity(0.41), location: 1),
		], startPoint: .leading, endPoint: .trailing)
	private static let coverBorder = Color(red: 201 / 255, green: 212 / 255, blue: 216 / 255).opacity(0.5)
}

/// Hinge spine `171:19`: a base gradient under five highlight and shadow strips, as in the Figma layers.
private struct HeroSpine: View {
	private static let shade = Color(red: 0, green: 20 / 255, blue: 40 / 255)
	/// x, width and left-to-right stops of each strip.
	private static let strips: [(CGFloat, CGFloat, [(Color, CGFloat)])] = [
		(0, 4, [(.white.opacity(0.72), 0), (.white.opacity(0.18), 1)]),
		(0, 1.2, [(.white.opacity(0.9), 0), (.white.opacity(0.3), 1)]),
		(5.6, 1.6, [(.white.opacity(0.45), 0), (.white.opacity(0.08), 1)]),
		(7.2, 11.2, [(.white.opacity(0.1), 0), (.white.opacity(0.22), 0.5), (.white.opacity(0.05), 1)]),
		(17.6, 7.016, [(shade.opacity(0.04), 0), (shade.opacity(0.28), 1)]),
	]
	private static let base: [(Color, CGFloat)] = [
		(Color(red: 180 / 255, green: 200 / 255, blue: 215 / 255).opacity(0.38), 0),
		(Color(red: 140 / 255, green: 165 / 255, blue: 180 / 255).opacity(0.28), 0.45),
		(Color(red: 100 / 255, green: 130 / 255, blue: 150 / 255).opacity(0.22), 1),
	]

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: 1.376, style: .continuous)
		ZStack(alignment: .topLeading) {
			shape.fill(Self.gradient(Self.base))
			ForEach(Self.strips.indices, id: \.self) { index in
				let (x, width, stops) = Self.strips[index]
				Rectangle().fill(Self.gradient(stops)).frame(width: width).offset(x: x)
			}
			shape.strokeBorder(.white.opacity(0.31), lineWidth: 0.48)
		}
		.clipShape(shape)
	}

	private static func gradient(_ stops: [(Color, CGFloat)]) -> LinearGradient {
		LinearGradient(
			stops: stops.map { Gradient.Stop(color: $0.0, location: $0.1) }, startPoint: .leading, endPoint: .trailing)
	}
}
