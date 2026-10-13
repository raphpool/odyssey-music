import SwiftUI
import UIKit

/// Figma `Artwork` (`18:2`, doc `174:203`): an image container for covers (square) and artists (circle),
/// with loading and unavailable states. The caller supplies the decoded image: this view never loads
/// anything, so an image from a third party has already gone through `NodeImageLoader` and
/// `URLValidation.publicHTTPSURL` before it gets here. The accessibility label is required (Figma rule:
/// "always provide accessible image text in code").
struct Track1Artwork: View {
	/// Figma `Size`: 48, 64 and 96 pt.
	enum Size: CaseIterable {
		case small, medium, large

		var points: CGFloat {
			switch self {
			case .small: Track1Tokens.sizeArtworkSmall
			case .medium: Track1Tokens.sizeArtworkMedium
			case .large: Track1Tokens.sizeArtworkLarge
			}
		}

		/// Figma sets the glyph in Title/3 (20 pt) on Small and Medium, and in Title/1 (28 pt) on Large, which
		/// no Figma variable covers: Large takes the local token `sizeIconXLarge` (TRA-443).
		var glyphSize: CGFloat {
			switch self {
			case .small, .medium: Track1Tokens.sizeIconMedium
			case .large: Track1Tokens.sizeIconXLarge
			}
		}
	}

	/// Figma `Shape`: covers are square, artists are circles.
	enum Shape: CaseIterable {
		case square, circle

		/// 12 pt on Small and Medium squares, 16 pt on Large ones, fully round for circles.
		func cornerRadius(for size: Size) -> CGFloat {
			switch (self, size) {
			case (.circle, _): Track1Tokens.radiusFull
			case (.square, .small), (.square, .medium): Track1Tokens.radius12
			case (.square, .large): Track1Tokens.radius16
			}
		}
	}

	/// Figma `State`. `image` is Default with the media fill replaced by the real image.
	enum State: Equatable {
		case loading
		case image(UIImage)
		case unavailable
	}

	let state: State
	let size: Size
	let shape: Shape
	let fallback: Track1Icon.Glyph
	let accessibilityLabel: String

	init(
		state: State, size: Size, shape: Shape, fallback: Track1Icon.Glyph, accessibilityLabel: String
	) {
		self.state = state
		self.size = size
		self.shape = shape
		self.fallback = fallback
		self.accessibilityLabel = accessibilityLabel
	}

	/// The fallback glyph stands in for every state that has no image.
	static func showsFallback(_ state: State) -> Bool {
		Track1ArtworkStyle.resolve(state).glyph != nil
	}

	var body: some View {
		let resolved = Track1ArtworkStyle.resolve(state)
		let outline = RoundedRectangle(cornerRadius: shape.cornerRadius(for: size), style: .continuous)
		ZStack {
			outline.fill(resolved.fill)
			if case .image(let image) = state {
				Image(uiImage: image)
					.resizable()
					.scaledToFill()
					.frame(width: size.points, height: size.points)
					.clipped()
			} else if let glyph = resolved.glyph {
				Track1Icon(fallback, color: glyph, size: size.glyphSize)
			}
		}
		.frame(width: size.points, height: size.points)
		.clipShape(outline)
		.overlay {
			if let border = resolved.border { outline.strokeBorder(border, lineWidth: 1) }
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(accessibilityLabel)
		// A placeholder glyph is not an image: only a real one gets the trait (TRA-388 review).
		.accessibilityAddTraits(Track1ArtworkStyle.accessibilityTraits(state))
	}
}

/// Fill, border and glyph color of each Artwork state, read on `18:2` (2026-10-13). Size and Shape never
/// change a color.
enum Track1ArtworkStyle {
	typealias Resolved = (fill: Color, border: Color?, glyph: Color?)

	static func accessibilityTraits(_ state: Track1Artwork.State) -> AccessibilityTraits {
		if case .image = state { .isImage } else { [] }
	}

	static func resolve(_ state: Track1Artwork.State) -> Resolved {
		switch state {
		case .loading:
			(Track1Tokens.colorSurfacePressed, nil, Track1Tokens.colorTextTertiary)
		case .image:
			// Figma: "replace the media fill with the real image". The olive Default fill is the
			// placeholder, so it stays out from under images with transparency.
			(Color.clear, nil, nil)
		case .unavailable:
			(Track1Tokens.colorBackgroundSubtle, Track1Tokens.colorBorderDefault, Track1Tokens.colorTextTertiary)
		}
	}
}
