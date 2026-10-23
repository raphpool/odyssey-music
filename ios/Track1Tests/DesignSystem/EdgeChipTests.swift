import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Edge chip, Overflow and ChipFlowLayout (TRA-392). Figma values are spelled out again here, read on
/// 2026-10-13 from `171:96` (chip), `171:97` (overflow) and the doc `171:100`: a token changed in the
/// components alone fails here. The wrapping rule and the meta text are tested in `Track1Core`
/// (`EdgeChipFormatTests`).
final class EdgeChipTests: XCTestCase {
	// MARK: Colors

	func testTagColorOfEachOfTheFiveTypesIsItsNodeToken() {
		XCTAssertEqual(NodeType.allCases.count, 5)
		for type in NodeType.allCases {
			XCTAssertEqual(
				rgbaHex(EdgeChipStyle.tagColor(type)), rgbaHex(Track1Tokens.colorNode(type)), "\(type)")
		}
	}

	func testTagColorsAreTheFigmaNodeColors() {
		XCTAssertEqual(rgbaHex(EdgeChipStyle.tagColor(.artist)), "5d7fa8ff")
		XCTAssertEqual(rgbaHex(EdgeChipStyle.tagColor(.project)), "e6a23aff")
		XCTAssertEqual(rgbaHex(EdgeChipStyle.tagColor(.track)), "f0642dff")
		XCTAssertEqual(rgbaHex(EdgeChipStyle.tagColor(.genre)), "8da66bff")
		XCTAssertEqual(rgbaHex(EdgeChipStyle.tagColor(.label)), "c8b6a3ff")
	}

	func testFillIsClearAndBorderIsTheChipToken() {
		XCTAssertEqual(rgbaHex(EdgeChipStyle.fill), "00000000")
		XCTAssertEqual(rgbaHex(EdgeChipStyle.border), "7d645933")
		XCTAssertEqual(rgbaHex(EdgeChipStyle.border), rgbaHex(Track1Tokens.colorBorderChip))
	}

	func testCornerRadiusIsSix() {
		XCTAssertEqual(EdgeChipMetrics.cornerRadius, 6)
		XCTAssertEqual(EdgeChipMetrics.cornerRadius, Track1Tokens.radius6)
	}

	func testOverflowHasAStrongBorderAndASecondaryLabel() {
		XCTAssertEqual(rgbaHex(EdgeChipStyle.overflowBorder), "6a4938ff")
		XCTAssertEqual(rgbaHex(EdgeChipStyle.overflowLabel), "c8b6a3ff")
	}

	// MARK: Measurements

	func testChipIs34PointsHighAndTheOverflow32() {
		XCTAssertEqual(EdgeChipMetrics.padding, 8)
		XCTAssertEqual(EdgeChipMetrics.chipVisualHeight, 34)
		XCTAssertEqual(EdgeChipMetrics.overflowVisualHeight, 32)
		XCTAssertEqual(EdgeChipMetrics.contentSpacing, 4)
		XCTAssertEqual(EdgeChipMetrics.cornerRadius, 0)
	}

	func testTouchZoneIs44PointsHighAndNeverShrinks() {
		XCTAssertEqual(EdgeChipMetrics.hitHeight, 44)
		XCTAssertEqual(EdgeChipMetrics.hitExtension(visualHeight: 34), 5)
		XCTAssertEqual(EdgeChipMetrics.hitExtension(visualHeight: 32), 6)
		XCTAssertEqual(EdgeChipMetrics.hitExtension(visualHeight: 60), 0)
	}

	func testOverflowBorderIsDashed4On3Off() {
		XCTAssertEqual(EdgeChipMetrics.overflowDash, [4, 3])
	}

	func testNamesTruncateAt280Points() {
		XCTAssertEqual(EdgeChipMetrics.nameMaxWidth, 280)
	}

	func testFlowSpacingIs8PointsOnBothAxes() {
		XCTAssertEqual(ChipFlowLayout().spacing, 8)
	}

	// MARK: Text and identifiers

	func testTagIsTheTypeInCapitals() {
		let tags = NodeType.allCases.map { EdgeChip.tag(for: $0) }
		XCTAssertEqual(tags, ["ARTIST", "PROJECT", "TRACK", "GENRE", "LABEL"])
	}

	func testOverflowLabelIsPlusNMore() {
		XCTAssertEqual(EdgeChipOverflow.label(hiddenCount: 2), "+2 more")
		XCTAssertEqual(EdgeChipOverflow.label(hiddenCount: 14), "+14 more")
	}

	func testIdentifiersFollowTheContract() throws {
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "artist:kendrick-lamar"))
		XCTAssertEqual(EdgeChip.accessibilityIdentifier(identity: identity), "edge-chip-artist:kendrick-lamar")
		XCTAssertEqual(EdgeChipOverflow.accessibilityIdentifier(field: "key_artists"), "edge-overflow-key_artists")
	}

	func testAccessibilityLabelSpeaksTypeNameAndMetaWithoutTheSeparator() {
		XCTAssertEqual(
			EdgeChip.accessibilityLabel(type: .project, name: "Alright", meta: "· 2015 · album"),
			"project, Alright, 2015, album")
		XCTAssertEqual(
			EdgeChip.accessibilityLabel(type: .artist, name: "Kendrick Lamar", meta: nil),
			"artist, Kendrick Lamar")
	}

	// MARK: Layout

	func testFlowLayoutForwardsTheWrappingRuleToTheCore() {
		let sizes = [CGSize(width: 100, height: 34), CGSize(width: 100, height: 34), CGSize(width: 60, height: 34)]
		XCTAssertEqual(ChipFlowLayout.rows(sizes: sizes, maxWidth: 220, spacing: 8), [[0, 1], [2]])
	}

	@MainActor
	func testFlowLayoutStacksTwoRowsWithAnEightPointGapInARealView() {
		let host = UIHostingController(
			rootView: ChipFlowLayout {
				Color.red.frame(width: 100, height: 34)
				Color.red.frame(width: 100, height: 34)
				Color.red.frame(width: 60, height: 34)
			})
		let size = host.sizeThatFits(in: CGSize(width: 220, height: 1000))
		XCTAssertEqual(size.height, 34 + 8 + 34, accuracy: 0.5)
		XCTAssertLessThanOrEqual(size.width, 220)
	}

	@MainActor
	func testALongNameTruncatesInsteadOfWideningTheChipPastTheRow() {
		let name = String(repeating: "Kendrick ", count: 40)
		let host = UIHostingController(
			rootView: ChipFlowLayout {
				EdgeChip(type: .artist, name: name, meta: "· 2015 · album") {}
			})
		let size = host.sizeThatFits(in: CGSize(width: 300, height: 1000))
		XCTAssertLessThanOrEqual(size.width, 300)
		XCTAssertEqual(size.height, EdgeChipMetrics.chipVisualHeight, accuracy: 0.5)
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
