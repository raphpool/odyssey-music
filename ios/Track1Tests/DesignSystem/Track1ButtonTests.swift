import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// The 9 variants are spelled out again here from the Figma Button set `16:20` (read 2026-10-13): the
/// background is the `bg-` token of the variant in `get_design_context`, the label its `text-` token. A
/// color changed in `Track1ButtonColors` alone fails here.
final class Track1ButtonTests: XCTestCase {
	private typealias Row = (
		node: String, kind: Track1ButtonKind, state: Track1ControlState, fill: String, label: String
	)

	/// `15:9` to `15:41`, then the Large ones, which only differ by size: the colors are the same.
	private let figma: [Row] = [
		("15:9", .primary, .normal, "f6e9d8ff", "0b0706ff"),
		("15:13", .primary, .pressed, "c8b6a3ff", "0b0706ff"),
		("15:17", .primary, .disabled, "241713ff", "5b4a41ff"),
		("15:21", .secondary, .normal, "e6a23aff", "f6e9d8ff"),
		("15:25", .secondary, .pressed, "bc7722ff", "f6e9d8ff"),
		("15:29", .secondary, .disabled, "241713ff", "5b4a41ff"),
		("15:33", .ghost, .normal, "00000000", "f6e9d8ff"),
		("15:37", .ghost, .pressed, "1a110eff", "f6e9d8ff"),
		("15:41", .ghost, .disabled, "00000000", "5b4a41ff"),
	]

	func testTheNineStyleAndStateCombinationsMatchFigma() {
		XCTAssertEqual(figma.count, 9)
		XCTAssertEqual(Set(figma.map { "\($0.kind)-\($0.state)" }).count, 9)
		for row in figma {
			let resolved = Track1ButtonColors.resolve(kind: row.kind, state: row.state)
			XCTAssertEqual(rgbaHex(resolved.fill), row.fill, "fill of \(row.node)")
			XCTAssertEqual(rgbaHex(resolved.label), row.label, "label of \(row.node)")
			XCTAssertNil(resolved.border, "border of \(row.node)")
		}
	}

	func testEveryKindAndStateIsCovered() {
		let covered = Set(figma.map { "\($0.kind)-\($0.state)" })
		let all = Set(
			Track1ButtonKind.allCases.flatMap { kind in
				Track1ControlState.allCases.map { "\(kind)-\($0)" }
			})
		XCTAssertEqual(covered, all)
	}

	func testPrimaryIsBoneWithAnEspressoLabel() {
		let primary = Track1ButtonColors.resolve(kind: .primary, state: .normal)
		XCTAssertEqual(rgbaHex(primary.fill), rgbaHex(Track1Tokens.colorActionPrimary))
		XCTAssertEqual(rgbaHex(primary.label), rgbaHex(Track1Tokens.colorTextInverse))
	}

	func testDisabledDimsTheWholeControlTo42Percent() {
		XCTAssertEqual(Track1ButtonColors.disabledOpacity, 0.42)
	}

	func testHeightsAre44And52() {
		XCTAssertEqual(Track1ControlSize.medium.height, 44)
		XCTAssertEqual(Track1ControlSize.large.height, 52)
		XCTAssertEqual(Track1ControlSize.allCases.count, 2)
	}

	func testLabelRoleFollowsTheSizeAsInFigma() {
		XCTAssertEqual(Track1ControlSize.medium.labelRole, .labelMedium)
		XCTAssertEqual(Track1ControlSize.large.labelRole, .labelLarge)
	}

	func testPaddingGapAndIconFollowFigma() {
		XCTAssertEqual(Track1ControlSize.medium.horizontalPadding, 20)
		XCTAssertEqual(Track1ControlSize.large.horizontalPadding, 24)
		XCTAssertEqual(Track1ControlSize.medium.contentSpacing, 8)
		XCTAssertEqual(Track1ControlSize.large.contentSpacing, 10)
		XCTAssertEqual(Track1ControlSize.medium.iconSize, 20)
		XCTAssertEqual(Track1ControlSize.large.iconSize, 24)
	}

	/// TRA-444: `BottomActionBar` and the consent screen needed a capsule as wide as its container.
	func testFullWidthAsksForTheMaximumWidthAndOtherwiseForNone() throws {
		let full = try XCTUnwrap(Track1Button.maxWidth(fullWidth: true))
		XCTAssertTrue(full.isInfinite)
		XCTAssertNil(Track1Button.maxWidth(fullWidth: false))
	}

	func testStateComesFromTheEnvironmentAndThePressedFlag() {
		XCTAssertEqual(Track1ControlState(isEnabled: true, isPressed: false), .normal)
		XCTAssertEqual(Track1ControlState(isEnabled: true, isPressed: true), .pressed)
		XCTAssertEqual(Track1ControlState(isEnabled: false, isPressed: false), .disabled)
		XCTAssertEqual(Track1ControlState(isEnabled: false, isPressed: true), .disabled)
	}

	/// A single line keeps the natural height of its font, which is 74 pt for `displayHero` instead of the
	/// 64 pt of Figma (TRA-384 review): N lines must measure N x the Figma line height, one line or several.
	func testTextHeightIsAMultipleOfTheFigmaLineHeight() throws {
		for role in Track1TextRole.allCases {
			let natural = try XCTUnwrap(UIFont(name: role.face.rawValue, size: role.size)).lineHeight
			let spacing = role.lineSpacing(compatibleWith: defaultSize)
			for lines in 1...4 {
				// What `Text` measures for that many lines at the default content size.
				let measured = CGFloat(lines) * natural + CGFloat(lines - 1) * spacing
				XCTAssertEqual(
					Track1LineHeight.lineCount(
						measured: measured, lineHeight: role.lineHeight, naturalHeight: natural),
					lines, "\(role) on \(lines) lines")
				XCTAssertEqual(
					Track1LineHeight.height(measured: measured, lineHeight: role.lineHeight, naturalHeight: natural),
					CGFloat(lines) * role.lineHeight, accuracy: 0.001, "\(role) on \(lines) lines")
			}
		}
	}

	private let defaultSize = UITraitCollection(preferredContentSizeCategory: .large)

	// MARK: Helpers

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
