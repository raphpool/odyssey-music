import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The values are spelled out again from the TRA-733 ticket (the profile header of the v1 Genres tab): a
/// measure changed in `ProfileHeaderMetrics` alone fails here. Each value has its own test, named after it.
final class ProfileHeaderTests: XCTestCase {
	// MARK: Measures

	func testTheAvatarIs89() {
		XCTAssertEqual(ProfileHeaderMetrics.avatarSize, 89)
	}

	func testTheRingBorderIs3Point296() {
		XCTAssertEqual(ProfileHeaderMetrics.borderWidth, 3.296)
	}

	func testTheRingRadiusIs19Point469() {
		XCTAssertEqual(ProfileHeaderMetrics.ringCornerRadius, 19.469)
	}

	func testTheTileIs85Point618() {
		XCTAssertEqual(ProfileHeaderMetrics.tileSize, 85.618)
	}

	func testTheTileRadiusIs18Point729() {
		XCTAssertEqual(ProfileHeaderMetrics.tileCornerRadius, 18.729)
	}

	func testTheDiscIs72Point7() {
		XCTAssertEqual(ProfileHeaderMetrics.discSize, 72.7)
	}

	func testTheDiscIsInsetBy5Point54InTheTile() {
		XCTAssertEqual(ProfileHeaderMetrics.discInset, 5.54)
	}

	func testTheGapBetweenAvatarAndNameIs16() {
		XCTAssertEqual(ProfileHeaderMetrics.nameSpacing, 16)
	}

	// MARK: Colours and text

	func testTheRingIsIconPrimary() {
		XCTAssertEqual(rgbaHex(ProfileHeaderMetrics.ringColor), "f6e9d8ff")
		XCTAssertEqual(ProfileHeaderMetrics.ringColor, Track1Tokens.colorIconPrimary)
	}

	/// `#F6E9D8` at 10 % at the top, the same tint at 0 % at 151.15 % of the height, past the bottom edge.
	func testTheTileGradientMatchesTheMockUp() {
		XCTAssertEqual(rgbaHex(ProfileHeaderMetrics.tileTopColor), "f6e9d81a")
		XCTAssertEqual(rgbaHex(ProfileHeaderMetrics.tileBottomColor), "f6e9d800")
		XCTAssertEqual(ProfileHeaderMetrics.tileGradientStart, UnitPoint(x: 0.5, y: 0))
		XCTAssertEqual(ProfileHeaderMetrics.tileGradientEnd, UnitPoint(x: 0.5, y: 1.5115))
	}

	func testTheNameIsTitle3InTextPrimary() {
		XCTAssertEqual(ProfileHeaderMetrics.nameRole, .title3)
		XCTAssertEqual(ProfileHeaderMetrics.nameRole.face, .jetBrainsMonoBold)
		XCTAssertEqual(ProfileHeaderMetrics.nameRole.size, 20)
		XCTAssertEqual(ProfileHeaderMetrics.nameRole.lineHeight, 25)
		XCTAssertEqual(rgbaHex(ProfileHeaderMetrics.nameColor), "f6e9d8ff")
		XCTAssertEqual(ProfileHeaderMetrics.nameColor, Track1Tokens.colorTextPrimary)
	}

	func testTheNameStaysOnOneLine() {
		XCTAssertEqual(ProfileHeaderMetrics.nameLineLimit, 1)
	}

	// MARK: Accessibility

	func testTheLabelHoldsTheNameAndTheDiscLabel() {
		for disc in ProfileDisc.allCases {
			let label = ProfileHeaderMetrics.accessibilityLabel(name: "Raphael", disc: disc)
			let discLabel = ProfileDiscImage.accessibilityLabel(for: disc)
			XCTAssertEqual(label, "Raphael, \(discLabel)", "\(disc)")
			XCTAssertTrue(label.contains("Raphael"), "name in the label of \(disc)")
			XCTAssertTrue(label.contains(discLabel), "disc in the label of \(disc)")
		}
	}

	func testTheLabelReadsTheNameAsItIs() {
		XCTAssertEqual(
			ProfileHeaderMetrics.accessibilityLabel(name: "Disque_%@", disc: .blue), "Disque_%@, Disque bleu")
	}

	func testTheIdentifierIsProfileHeader() {
		XCTAssertEqual(ProfileHeaderMetrics.accessibilityIdentifier, "profile-header")
	}

	// MARK: Layout

	@MainActor
	private func headerSize(name: String, width: CGFloat = 390) -> CGSize {
		UIHostingController(rootView: ProfileHeader(disc: .iridescent, name: name))
			.sizeThatFits(in: CGSize(width: width, height: 1000))
	}

	/// 130 pt: the 89 pt avatar, the 16 pt gap and one Title/3 line of 25 pt.
	@MainActor
	func testTheHeaderIsTheAvatarThenTheNameOnOneLine() {
		let size = headerSize(name: "Raphael")
		XCTAssertEqual(size.height, 89 + 16 + 25, accuracy: 0.5)
		XCTAssertGreaterThanOrEqual(size.width, 89 - 0.5)
	}

	/// A hard line break gives the exact count whatever the font: two lines would measure 25 pt more.
	@MainActor
	func testTheNameNeverWrapsOnASecondLine() {
		let oneLine = headerSize(name: "Raphael")
		XCTAssertEqual(headerSize(name: "Raph\nael").height, oneLine.height, accuracy: 0.5)
	}

	/// 20 characters: wide enough to fit a phone, and still one line when the width is too small for it.
	@MainActor
	func testAPseudoOf20CharactersStaysOnOneLine() {
		let pseudo = String(repeating: "W", count: 20)
		let oneLine = headerSize(name: "Raphael").height
		XCTAssertEqual(headerSize(name: pseudo).height, oneLine, accuracy: 0.5, "on a phone")
		XCTAssertEqual(headerSize(name: pseudo, width: 150).height, oneLine, accuracy: 0.5, "on 150 pt")
		XCTAssertLessThanOrEqual(headerSize(name: pseudo, width: 150).width, 150.5)
	}

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
