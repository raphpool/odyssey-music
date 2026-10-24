import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Node content card and type badge (TRA-658). Figma values are spelled out again here, read on 2026-10-23
/// from `285:1034` (card) and `286:1668` (badge): a token changed in the components alone fails here.
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

	func testBadgeMeasurementsAreTheFigmaOnes() {
		XCTAssertEqual(NodeTypeBadgeMetrics.squareSize, 12)
		XCTAssertEqual(NodeTypeBadgeMetrics.spacing, 8)
		XCTAssertEqual(NodeTypeBadgeMetrics.identifier, "node-type-badge")
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
