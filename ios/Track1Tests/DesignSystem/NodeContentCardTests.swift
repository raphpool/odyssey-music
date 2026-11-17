import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Node content card and type badge (TRA-658, badge redrawn in TRA-726). Figma values are spelled out again
/// here, read on 2026-10-23 from `285:1034` (card) and on 2026-11-17 from `362:5098` and `362:5105`
/// (badge): a token changed in the components alone fails here.
final class NodeContentCardTests: XCTestCase {
	// MARK: Card

	func testCardMeasurementsAreTheFigmaOnes() {
		XCTAssertEqual(NodeContentCardMetrics.cornerRadius, 16)
		XCTAssertEqual(NodeContentCardMetrics.horizontalPadding, 12)
		XCTAssertEqual(NodeContentCardMetrics.topPadding, 8)
		XCTAssertEqual(NodeContentCardMetrics.bottomPadding, 24)
		XCTAssertEqual(NodeContentCardMetrics.sectionSpacing, 18)
		XCTAssertEqual(NodeContentCardMetrics.outerInset, 16)
	}

	func testContentWidthRemovesTheOuterInsetAndThePaddingOnBothSides() {
		XCTAssertEqual(NodeContentCardMetrics.contentWidth(forPageWidth: 393), 337)
		XCTAssertEqual(NodeContentCardMetrics.contentWidth(forPageWidth: 320), 264)
	}

	func testTheCardIsFlatWithoutATintAndTintedWithOne() {
		let tint = CoverTint(
			stops: Array(repeating: LinearRGB(red: 0.2, green: 0.1, blue: 0.1), count: 3),
			shadow: LinearRGB(red: 0.5, green: 0.2, blue: 0.2))

		XCTAssertEqual(NodeContentCard<EmptyView>.background(for: nil), .flat)
		XCTAssertEqual(NodeContentCard<EmptyView>.background(for: tint), .tinted(tint))
	}

	func testCardIdentifier() {
		XCTAssertEqual(NodeContentCardMetrics.identifier, "node-card")
	}

	func testCardStacksItsContentWithThePaddingAndTheSectionGap() {
		let host = UIHostingController(
			rootView: NodeContentCard {
				Color.clear.frame(height: 40)
				Color.clear.frame(height: 30)
			})
		let size = host.sizeThatFits(in: CGSize(width: 361, height: 1000))
		// 8 top + 40 + 18 gap + 30 + 24 bottom.
		XCTAssertEqual(size.height, 120, accuracy: 0.5)
	}

	// MARK: Badge

	// The badge measurements below are spelled out again from Figma `362:5098` (PROJECT) and `362:5105`
	// (TRACK), read on 2026-11-17 (TRA-726).

	func testBadgeMeasurementsAreTheFigmaOnes() {
		XCTAssertEqual(NodeTypeBadgeMetrics.squareSize, CGSize(width: 11.368, height: 12))
		XCTAssertEqual(NodeTypeBadgeMetrics.hexagonSize, 14)
		XCTAssertEqual(NodeTypeBadgeMetrics.identifier, "node-type-badge")
	}

	func testBadgeDrawsAHexagonForATrackAndASquareForTheFourOtherTypes() {
		XCTAssertEqual(NodeTypeBadge.shape(for: .track), .hexagon)
		for type in [NodeType.artist, .project, .genre, .label] {
			XCTAssertEqual(NodeTypeBadge.shape(for: type), .square, "\(type)")
		}
		XCTAssertEqual(NodeType.allCases.count, 5)
	}

	func testBadgeSpacingIs4ForATrackAnd8ForTheFourOtherTypes() {
		XCTAssertEqual(NodeTypeBadgeMetrics.spacing(for: .track), 4)
		XCTAssertEqual(NodeTypeBadgeMetrics.spacing(for: .project), 8)
		for type in [NodeType.artist, .genre, .label] {
			XCTAssertEqual(NodeTypeBadgeMetrics.spacing(for: type), 8, "\(type)")
		}
	}

	func testHexagonSitsOnePointBelowTheCentreOfTheLineAndTheSquareIsCentred() {
		// Figma `362:5107`: centre at 13.5 in a line of 25 whose centre is 12.5 (read on 2026-11-17).
		XCTAssertEqual(NodeTypeBadgeMetrics.hexagonOffsetY, 1)
		XCTAssertEqual(NodeTypeBadgeMetrics.offsetY(for: .track), 1)
		for type in [NodeType.artist, .project, .genre, .label] {
			XCTAssertEqual(NodeTypeBadgeMetrics.offsetY(for: type), 0, "\(type)")
		}
	}

	func testBadgeTagUsesTheMonoBadgeRole() {
		XCTAssertEqual(NodeTypeBadge.tagRole, .monoBadge)
	}

	func testHexagonIsPointyTopWithSixVerticesOnTheCircleOfThe14Square() {
		let frame = CGRect(x: 0, y: 0, width: 14, height: 14)
		let vertices = NodeTypeBadgeHexagon.vertices(in: frame)
		// Radius 7 around (7, 7), first vertex at the top, then every 60 degrees clockwise: the side vertices
		// sit at 7 +/- 7 cos(30 deg) = 7 +/- 6.062 and 7 +/- 3.5.
		let side: CGFloat = 7 * CGFloat(3).squareRoot() / 2
		let expected = [
			CGPoint(x: 7, y: 0), CGPoint(x: 7 + side, y: 3.5), CGPoint(x: 7 + side, y: 10.5),
			CGPoint(x: 7, y: 14), CGPoint(x: 7 - side, y: 10.5), CGPoint(x: 7 - side, y: 3.5),
		]
		XCTAssertEqual(vertices.count, 6)
		for (vertex, point) in zip(vertices, expected) {
			XCTAssertEqual(vertex.x, point.x, accuracy: 0.001)
			XCTAssertEqual(vertex.y, point.y, accuracy: 0.001)
		}
	}

	func testHexagonFitsInTheSquareOf14() {
		let frame = CGRect(
			x: 0, y: 0, width: NodeTypeBadgeMetrics.hexagonSize, height: NodeTypeBadgeMetrics.hexagonSize)
		let bounds = NodeTypeBadgeHexagon().path(in: frame).boundingRect
		XCTAssertTrue(frame.contains(bounds), "\(bounds)")
		XCTAssertEqual(bounds.height, 14, accuracy: 0.001)
		// Figma draws the polygon on the inscribed circle: 7 * sqrt(3) = 12.124 wide, 0.938 from each edge of
		// the slot (read on the pixels of the render of `362:5106`).
		XCTAssertEqual(bounds.width, 12.124, accuracy: 0.001)
		XCTAssertEqual(bounds.minX, 0.938, accuracy: 0.001)
	}

	func testBadgeIsTheShapeSlotPlusTheFigmaGapPlusTheTag() {
		// Figma literals, not the metrics: PROJECT is 11.368 + 8 (`362:5098`), TRACK is 14 + 4 (`362:5105`).
		let leading: [(NodeType, CGFloat)] = [
			(.artist, 11.368 + 8), (.project, 11.368 + 8), (.genre, 11.368 + 8), (.label, 11.368 + 8),
			(.track, 14 + 4),
		]
		for (type, expectedLeading) in leading {
			let badge = UIHostingController(rootView: NodeTypeBadge(type: type))
			let tag = UIHostingController(
				rootView: Track1Text(NodeTypeBadge.tag(for: type), role: .monoBadge, verbatim: true))
			let width = badge.sizeThatFits(in: CGSize(width: 400, height: 100)).width
			let tagWidth = tag.sizeThatFits(in: CGSize(width: 400, height: 100)).width
			// The hosting controller may round a size up to the pixel grid, hence 0.5.
			XCTAssertEqual(width, expectedLeading + tagWidth, accuracy: 0.5, "\(type)")
		}
	}

	func testBadgeTagIsTheEdgeChipTagOfEachOfTheFiveTypes() {
		XCTAssertEqual(NodeType.allCases.count, 5)
		for type in NodeType.allCases {
			XCTAssertEqual(NodeTypeBadge.tag(for: type), EdgeChip.tag(for: type), "\(type)")
		}
		XCTAssertEqual(NodeTypeBadge.tag(for: .artist), "ARTIST")
		XCTAssertEqual(NodeTypeBadge.tag(for: .project), "PROJECT")
		XCTAssertEqual(NodeTypeBadge.tag(for: .track), "TRACK")
		XCTAssertEqual(NodeTypeBadge.tag(for: .genre), "GENRE")
		XCTAssertEqual(NodeTypeBadge.tag(for: .label), "LABEL")
	}

	func testBadgeColorIsTheNodeTokenOfEachOfTheFiveTypes() {
		for type in NodeType.allCases {
			XCTAssertEqual(
				rgbaHex(NodeTypeBadge.color(for: type)), rgbaHex(Track1Tokens.colorNode(type)), "\(type)")
		}
		XCTAssertEqual(rgbaHex(NodeTypeBadge.color(for: .artist)), "5d7fa8ff")
		// Figma `362:5098` and `362:5105`: `theme.color.node.project` and `theme.color.node.track`.
		XCTAssertEqual(rgbaHex(NodeTypeBadge.color(for: .project)), "e6a23aff")
		XCTAssertEqual(rgbaHex(NodeTypeBadge.color(for: .track)), "f0642dff")
	}

	func testBadgeAccessibilityLabelIsTheLowercaseTypeOfEachOfTheFiveTypes() {
		for type in NodeType.allCases {
			XCTAssertEqual(
				NodeTypeBadge.accessibilityLabel(for: type), EdgeChipFormat.typeLabel(type), "\(type)")
		}
		XCTAssertEqual(NodeTypeBadge.accessibilityLabel(for: .artist), "artist")
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
