import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The Hero (Figma `171:34`) and the Release card (`172:16`), read 2026-10-13. The meta text and the finer
/// type mapping are also tested in `Track1Core` (`HeroFormatTests`); these tests pin what the app adds: the
/// Figma measurements, the placeholders and the identifiers. Main actor: the tests build `View` values.
@MainActor
final class HeroTests: XCTestCase {
	// MARK: - Kind

	func testKindMapsEveryNodeTypeToItsVariant() {
		XCTAssertEqual(NodeHero.Kind(.project), .release)
		XCTAssertEqual(NodeHero.Kind(.track), .release)
		XCTAssertEqual(NodeHero.Kind(.artist), .artist)
		XCTAssertEqual(NodeHero.Kind(.genre), .cover)
		XCTAssertEqual(NodeHero.Kind(.label), .cover)
	}

	func testKindSizesMatchFigma() {
		let release = NodeHero.Kind.release.size
		XCTAssertEqual(release.width, 276, accuracy: 0.001)
		// Figma `171:2` is 183.227 pt high; the ticket and the plan round it to 183.
		XCTAssertEqual(release.height, 183.227, accuracy: 0.001)
		XCTAssertEqual(release.height, 183, accuracy: 0.25)
		for kind in [NodeHero.Kind.artist, .cover] {
			XCTAssertEqual(kind.size.width, 164, accuracy: 0.001)
			XCTAssertEqual(kind.size.height, 164, accuracy: 0.001)
			XCTAssertEqual(kind.size.width, Track1Tokens.sizeHeroArtwork, accuracy: 0.001, "size/hero-artwork")
		}
	}

	func testTheJewelCaseAndTheDiscStayInsideTheReleaseFrame() {
		let frame = CGRect(origin: .zero, size: NodeHero.Kind.release.size)
		XCTAssertTrue(frame.contains(NodeHeroMetrics.caseFrame), "The case is never cropped.")
		XCTAssertTrue(frame.contains(NodeHeroMetrics.discFrame), "The disc is never cropped.")
		// `caseCover` and `spine` are measured in the case's own frame.
		let caseBounds = CGRect(origin: .zero, size: NodeHeroMetrics.caseFrame.size)
		XCTAssertTrue(caseBounds.contains(NodeHeroMetrics.caseCover), "The cover sits inside the case.")
		XCTAssertTrue(caseBounds.contains(NodeHeroMetrics.spine), "The spine sits inside the case.")
		XCTAssertGreaterThan(NodeHeroMetrics.discFrame.maxX, NodeHeroMetrics.caseFrame.maxX, "The disc comes out.")
	}

	func testEachVariantHasItsOwnPlaceholderGradientOnTheFigmaStops() {
		let all = NodeHeroKind.allCases.map { NodeHeroStyle.placeholderStops(for: $0) }
		for (index, stops) in all.enumerated() {
			XCTAssertEqual(stops.map(\.location), [0, 0.35714, 0.71429, 1])
			XCTAssertEqual(stops[2].color, stops[3].color, "CSS holds the last color to the end.")
			for other in all[(index + 1)...] {
				XCTAssertNotEqual(stops.map(\.color), other.map(\.color), "Each variant keeps a gradient of its own.")
			}
		}
		XCTAssertEqual(NodeHeroStyle.placeholderStops(for: .artist)[0].color, Track1Tokens.colorNodeArtist)
		XCTAssertEqual(NodeHeroStyle.placeholderStops(for: .cover)[0].color, Track1Tokens.colorNodeGenre)
		XCTAssertEqual(NodeHeroStyle.placeholderStops(for: .release)[0].color, Track1Tokens.colorNodeProject)
	}

	func testOnlyADecodedImageReplacesThePlaceholder() {
		XCTAssertNil(NodeHero.decodedImage(for: .loading))
		XCTAssertNil(NodeHero.decodedImage(for: .unavailable))
		let image = UIImage()
		XCTAssertIdentical(NodeHero.decodedImage(for: .image(image)), image)
	}

	func testTheHeroSitsSixteenPointsBelowTheTopBarAndIsNamedNodeHero() {
		XCTAssertEqual(NodeHero.topInset, 16, accuracy: 0.001)
		XCTAssertEqual(NodeHero.identifier, "node-hero")
	}

	func testTheReleaseCardIsAsWideAsItsTokenAndNamedByItsIdentity() throws {
		XCTAssertEqual(ReleaseCard.width, 120, accuracy: 0.001)
		XCTAssertEqual(ReleaseCard.titleLineLimit, 2)
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "project:to-pimp-a-butterfly"))
		XCTAssertEqual(ReleaseCard.identifier(for: identity), "release-card-project:to-pimp-a-butterfly")
	}

	func testTheReleaseCardMetaCoversEveryCombination() {
		XCTAssertEqual(ReleaseCard.meta(year: "2015", releaseType: "album"), "2015 · album")
		XCTAssertEqual(ReleaseCard.meta(year: "2015", releaseType: nil), "2015")
		XCTAssertEqual(ReleaseCard.meta(year: nil, releaseType: "album"), "album")
		XCTAssertNil(ReleaseCard.meta(year: nil, releaseType: nil))
	}
}
