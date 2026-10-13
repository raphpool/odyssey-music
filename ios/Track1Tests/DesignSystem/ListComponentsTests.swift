import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// ListItem, Artwork and SearchField (TRA-388). Figma values are spelled out again here, read on 2026-10-13
/// from `22:142` (ListItem), `18:2` (Artwork) and `30:21` (SearchField): a token changed in the components
/// alone fails here.
final class ListComponentsTests: XCTestCase {
	// MARK: Artwork

	func testArtworkSizesAre48And64And96Points() {
		XCTAssertEqual(Track1Artwork.Size.small.points, 48)
		XCTAssertEqual(Track1Artwork.Size.medium.points, 64)
		XCTAssertEqual(Track1Artwork.Size.large.points, 96)
		XCTAssertEqual(Track1Artwork.Size.allCases.count, 3)
	}

	func testArtworkCornerRadiusFollowsShapeAndSize() {
		for size in Track1Artwork.Size.allCases {
			XCTAssertEqual(Track1Artwork.Shape.circle.cornerRadius(for: size), 999, "circle \(size)")
		}
		XCTAssertEqual(Track1Artwork.Shape.square.cornerRadius(for: .small), 12)
		XCTAssertEqual(Track1Artwork.Shape.square.cornerRadius(for: .medium), 12)
		XCTAssertEqual(Track1Artwork.Shape.square.cornerRadius(for: .large), 16)
	}

	func testUnavailableShowsTheFallbackGlyphOnAQuietSurfaceWithABorder() {
		XCTAssertTrue(Track1Artwork.showsFallback(.unavailable))
		let style = Track1ArtworkStyle.resolve(.unavailable)
		XCTAssertEqual(rgbaHex(style.fill), "1a110eff")
		XCTAssertEqual(style.border.map(rgbaHex), "443027ff")
		XCTAssertEqual(style.glyph.map(rgbaHex), "8d7a6dff")
	}

	func testLoadingShowsTheFallbackGlyphOnThePressedSurface() {
		XCTAssertTrue(Track1Artwork.showsFallback(.loading))
		let style = Track1ArtworkStyle.resolve(.loading)
		XCTAssertEqual(rgbaHex(style.fill), "302019ff")
		XCTAssertNil(style.border)
		XCTAssertEqual(style.glyph.map(rgbaHex), "8d7a6dff")
	}

	func testAnImageReplacesTheFallbackGlyph() {
		let image = makeImage()
		XCTAssertFalse(Track1Artwork.showsFallback(.image(image)))
		let style = Track1ArtworkStyle.resolve(.image(image))
		XCTAssertEqual(rgbaHex(style.fill), "00000000")
		XCTAssertNil(style.border)
		XCTAssertNil(style.glyph)
	}

	func testArtworkStateEqualityCoversTheImage() {
		let image = makeImage()
		XCTAssertEqual(Track1Artwork.State.image(image), .image(image))
		XCTAssertNotEqual(Track1Artwork.State.image(image), .loading)
		XCTAssertNotEqual(Track1Artwork.State.loading, .unavailable)
	}

	func testAccessibilityLabelIsSetInEveryState() {
		let states: [Track1Artwork.State] = [.loading, .image(makeImage()), .unavailable]
		for state in states {
			let artwork = Track1Artwork(
				state: state, size: .small, shape: .square, fallback: .musicNote,
				accessibilityLabel: "Pochette de Kind of Blue")
			XCTAssertEqual(artwork.accessibilityLabel, "Pochette de Kind of Blue", "\(state)")
			XCTAssertEqual(artwork.fallback, .musicNote)
		}
	}

	func testOnlyARealImageCarriesTheImageTrait() {
		XCTAssertEqual(Track1ArtworkStyle.accessibilityTraits(.image(makeImage())), .isImage)
		XCTAssertEqual(Track1ArtworkStyle.accessibilityTraits(.loading), [])
		XCTAssertEqual(Track1ArtworkStyle.accessibilityTraits(.unavailable), [])
	}

	// MARK: SearchField

	func testClearButtonShowsOnlyWhenThereIsText() {
		XCTAssertFalse(Track1SearchField.showsClear(""))
		XCTAssertTrue(Track1SearchField.showsClear("a"))
		XCTAssertTrue(Track1SearchField.showsClear(" "))
	}

	func testSearchFieldIdentifiersAndPlaceholder() {
		XCTAssertEqual(Track1SearchField.fieldIdentifier, "search-field")
		XCTAssertEqual(Track1SearchField.clearIdentifier, "search-clear")
		XCTAssertEqual(Track1SearchField.placeholder, "Rechercher un artiste ou une œuvre")
	}

	func testBorderTurnsToTheFocusColorWhileFocused() {
		XCTAssertEqual(rgbaHex(Track1SearchField.borderColor(isFocused: false)), "443027ff")
		XCTAssertEqual(rgbaHex(Track1SearchField.borderColor(isFocused: true)), "5d7fa8ff")
	}

	// MARK: ListItem

	/// `22:2`, `22:10` and `22:18` (Standard, Accessory=None): the Artwork and Chevron variants share them.
	private typealias Row = (
		node: String, state: Track1ControlState, fill: String, title: String, subtitle: String
	)

	private let figma: [Row] = [
		("22:2", .normal, "00000000", "f6e9d8ff", "c8b6a3ff"),
		("22:10", .pressed, "302019ff", "f6e9d8ff", "c8b6a3ff"),
		("22:18", .disabled, "00000000", "5b4a41ff", "5b4a41ff"),
	]

	func testDefaultPressedAndDisabledColorsMatchFigma() {
		XCTAssertEqual(Set(figma.map(\.state)).count, Track1ControlState.allCases.count)
		for row in figma {
			let resolved = Track1ListItemColors.resolve(state: row.state)
			XCTAssertEqual(rgbaHex(resolved.fill), row.fill, "fill of \(row.node)")
			XCTAssertEqual(rgbaHex(resolved.title), row.title, "title of \(row.node)")
			XCTAssertEqual(rgbaHex(resolved.subtitle), row.subtitle, "subtitle of \(row.node)")
		}
	}

	func testOnlyDisabledDimsTheRowTo42Percent() {
		XCTAssertEqual(Track1ListItemColors.opacity(state: .normal), 1)
		XCTAssertEqual(Track1ListItemColors.opacity(state: .pressed), 1)
		XCTAssertEqual(Track1ListItemColors.opacity(state: .disabled), 0.42)
	}

	func testRowHeightsAreAboveTheTapTarget() {
		XCTAssertEqual(Track1ListItem.minHeight(hasArtwork: false), 60)
		XCTAssertEqual(Track1ListItem.minHeight(hasArtwork: true), 80)
		XCTAssertGreaterThanOrEqual(Track1ListItem.minHeight(hasArtwork: false), 44)
	}

	func testRowIsSpokenFromItsTitleAndSubtitle() {
		XCTAssertEqual(
			Track1ListItem.accessibilityLabel(title: "Kind of Blue", subtitle: "Miles Davis · Album"),
			"Kind of Blue, Miles Davis · Album")
		XCTAssertEqual(Track1ListItem.accessibilityLabel(title: "Kind of Blue", subtitle: nil), "Kind of Blue")
	}

	func testAccessoryCases() {
		XCTAssertEqual(Track1ListItem.Accessory.allCases.count, 2)
	}

	// MARK: Helpers

	private func makeImage() -> UIImage {
		UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
			UIColor.red.setFill()
			context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
		}
	}

	/// `rrggbbaa`, to compare with the Figma hex and to read a failure.
	private func rgbaHex(_ color: Color) -> String {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "no-rgb" }
		return [red, green, blue, alpha].map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}
}
