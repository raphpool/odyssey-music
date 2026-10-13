import SwiftUI
import Track1Core
import UIKit

/// Figma `Genre tile` (`175:6`, doc `175:8`): a parent genre choice, two to a row. The backdrop is the genre
/// image, or the placeholder gradient while there is none (Q5), under a scrim that keeps the name readable.
/// Selected swaps the scrim for the selection surface and draws a 3 pt border inside the tile. The caller
/// supplies the decoded image, like `Track1Artwork`: this view never loads anything. A long press to preview
/// the genre is outside V1.
struct GenreTile: View {
	/// Figma gives the tile 164 pt in a 2-column grid. No token holds it (`size/genre-tile` is the 176 pt
	/// height), so the width is only used for the 164:176 ratio, and the tile fills the width it is given.
	static let figmaWidth: CGFloat = 164
	static let aspectRatio = figmaWidth / Track1Tokens.sizeGenreTile
	static let borderWidth: CGFloat = 3
	static let nameLineLimit = 3
	static let nameMinimumScale: CGFloat = 0.7

	/// `genre-tile-<identity>`: the tile does not know its identity, the screen sets this on it.
	static func identifier(for identity: NodeIdentity) -> String {
		"genre-tile-\(identity.rawValue)"
	}

	private let name: String
	private let isSelected: Bool
	private let artwork: Track1Artwork.State?
	private let action: () -> Void
	@State private var taps = 0

	/// `artwork` nil, `.loading` and `.unavailable` all show the placeholder gradient.
	init(name: String, isSelected: Bool, artwork: Track1Artwork.State?, action: @escaping () -> Void) {
		self.name = name
		self.isSelected = isSelected
		self.artwork = artwork
		self.action = action
	}

	/// Only a decoded image replaces the placeholder.
	static func image(for artwork: Track1Artwork.State?) -> UIImage? {
		if case .image(let image) = artwork { image } else { nil }
	}

	var body: some View {
		let style = GenreTileStyle.resolve(isSelected: isSelected)
		Button {
			taps += 1
			action()
		} label: {
			Color.clear
				.aspectRatio(Self.aspectRatio, contentMode: .fit)
				.frame(minWidth: 0, idealWidth: Self.figmaWidth, maxWidth: .infinity)
				.overlay { backdrop }
				.overlay { style.overlay }
				.overlay {
					Track1Text(name, role: .title2, verbatim: true)
						.foregroundStyle(style.content)
						.multilineTextAlignment(.center)
						// Figma draws one line. 22 pt mono glyphs are wide (about 10 per line here), so a
						// long name wraps on 3 lines at most and shrinks before it breaks inside a word.
						.lineLimit(Self.nameLineLimit)
						.minimumScaleFactor(Self.nameMinimumScale)
						.padding(.horizontal, Track1Tokens.spacing8)
				}
				.overlay {
					if let border = style.border {
						Rectangle().strokeBorder(border, lineWidth: Self.borderWidth)
					}
				}
				.clipShape(Rectangle())
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.sensoryFeedback(.selection, trigger: taps)
		.accessibilityLabel(Text(verbatim: name))
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}

	@ViewBuilder
	private var backdrop: some View {
		if let image = Self.image(for: artwork) {
			Image(uiImage: image)
				.resizable()
				.scaledToFill()
		} else {
			GenreTileStyle.placeholder
		}
	}
}

/// Colors of the two Genre tile states (`175:2`, `175:4`) and the placeholder gradient they sit on.
enum GenreTileStyle {
	/// `overlay` covers the backdrop, `border` is nil unless selected.
	typealias Resolved = (overlay: Color, border: Color?, content: Color)

	/// The selection surface is drawn at 90 % so that the genre image still shows through (ticket TRA-389).
	static let selectedSurfaceOpacity = 0.9

	static func resolve(isSelected: Bool) -> Resolved {
		if isSelected {
			(
				Track1Tokens.colorSelectionSurface.opacity(selectedSurfaceOpacity),
				Track1Tokens.colorSelectionBorder, Track1Tokens.colorSelectionContent
			)
		} else {
			(Track1Tokens.colorOverlayScrim, nil, Track1Tokens.colorTextPrimary)
		}
	}

	/// The Figma gradient, `132.98deg` over three stops at 0, 35.714 and 71.429 %, which are the tokens
	/// `border/strong`, `surface/pressed` and `background/base`. CSS keeps the last color to the end.
	static let angleDegrees = 132.97863505964398
	static let stops: [Gradient.Stop] = [
		.init(color: Track1Tokens.colorBorderStrong, location: 0),
		.init(color: Track1Tokens.colorSurfacePressed, location: 0.35714),
		.init(color: Track1Tokens.colorBackgroundBase, location: 0.71429),
		.init(color: Track1Tokens.colorBackgroundBase, location: 1),
	]

	static var placeholder: LinearGradient {
		let points = gradientPoints(angleDegrees: angleDegrees, aspectRatio: GenreTile.aspectRatio)
		return LinearGradient(stops: stops, startPoint: points.start, endPoint: points.end)
	}

	/// Start and end of a CSS `linear-gradient(<angle>)` on a box of the given width / height ratio, in unit
	/// coordinates. CSS measures the angle clockwise from "to top" and sizes the gradient line so that the
	/// corners get the first and the last color, which SwiftUI's own corner-to-corner presets do not give.
	static func gradientPoints(
		angleDegrees: Double, aspectRatio: CGFloat
	) -> (start: UnitPoint, end: UnitPoint) {
		let radians = angleDegrees * .pi / 180
		let dx = sin(radians)
		let dy = -cos(radians)
		// Work on a box of height 1 and width `aspectRatio`, then divide back to unit coordinates.
		let width = Double(aspectRatio)
		let length = abs(width * dx) + abs(dy)
		let halfX = dx * length / 2 / width
		let halfY = dy * length / 2
		return (UnitPoint(x: 0.5 - halfX, y: 0.5 - halfY), UnitPoint(x: 0.5 + halfX, y: 0.5 + halfY))
	}
}
