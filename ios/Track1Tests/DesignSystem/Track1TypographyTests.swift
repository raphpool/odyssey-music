import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// The 20 roles of the Figma Typography frame `180:376` (read 2026-10-13) are spelled out again here: the
/// caption under each sample gives the font, the size and the line height. `monoHeadline` is the 21st, read
/// on the Top bar date instance `I282:838;173:15` (2026-10-23, TRA-660), which the frame does not list. A
/// value changed in `Track1TextRole` alone fails here.
final class Track1TypographyTests: XCTestCase {
	private typealias Row = (
		role: Track1TextRole, face: String, size: CGFloat, lineHeight: CGFloat,
		textStyle: Font.TextStyle, uiTextStyle: UIFont.TextStyle
	)

	private let figma: [Row] = [
		(.displayHero, "JetBrainsMono-Bold", 56, 64, .largeTitle, .largeTitle),
		(.display, "JetBrainsMono-Bold", 34, 41, .largeTitle, .largeTitle),
		(.title1, "JetBrainsMono-Bold", 28, 34, .title, .title1),
		(.title2, "JetBrainsMono-Bold", 22, 28, .title2, .title2),
		(.title3, "JetBrainsMono-Bold", 20, 25, .title3, .title3),
		(.headline, "JetBrainsMono-Bold", 18, 24, .headline, .headline),
		(.monoHeadline, "JetBrainsMono-Bold", 18, 24, .callout, .callout),
		(.monoSection, "JetBrainsMono-Bold", 15, 20, .subheadline, .subheadline),
		(.monoItem, "JetBrainsMono-Regular", 18, 22, .body, .body),
		(.monoTag, "JetBrainsMono-Regular", 13, 16, .footnote, .footnote),
		(.monoLabel, "JetBrainsMono-Regular", 12, 16, .caption, .caption1),
		(.monoMicro, "JetBrainsMono-Medium", 11, 14, .caption2, .caption2),
		(.bodyLarge, "Roboto-Regular", 17, 25, .body, .body),
		(.bodyMedium, "Roboto-Regular", 15, 22, .subheadline, .subheadline),
		(.bodySmall, "Roboto-Regular", 13, 18, .footnote, .footnote),
		(.labelLarge, "Roboto-SemiBold", 17, 22, .headline, .headline),
		(.labelMedium, "Roboto-SemiBold", 15, 20, .subheadline, .subheadline),
		(.labelSmall, "Roboto-SemiBold", 13, 16, .footnote, .footnote),
		(.labelTab, "Roboto-SemiBold", 10, 12, .caption2, .caption2),
		(.eyebrow, "RobotoCondensed-Medium", 16, 20, .callout, .callout),
		(.caption, "Roboto-Regular", 12, 16, .caption, .caption1),
	]

	private let defaultSize = UITraitCollection(preferredContentSizeCategory: .large)

	func testTheSixFontFacesLoadInTheApp() {
		XCTAssertEqual(Track1FontFace.allCases.count, 6)
		for face in Track1FontFace.allCases {
			XCTAssertEqual(UIFont(name: face.rawValue, size: 17)?.fontName, face.rawValue, face.rawValue)
		}
	}

	func testEveryRoleIsDocumentedOnceAndMatchesFigma() {
		XCTAssertEqual(Track1TextRole.allCases.count, 21)
		XCTAssertEqual(figma.count, 21)
		for row in figma {
			XCTAssertEqual(row.role.face.rawValue, row.face, "\(row.role) face")
			XCTAssertEqual(row.role.size, row.size, "\(row.role) size")
			XCTAssertEqual(row.role.lineHeight, row.lineHeight, "\(row.role) line height")
			XCTAssertEqual(row.role.textStyle, row.textStyle, "\(row.role) text style")
			XCTAssertEqual(row.role.uiTextStyle, row.uiTextStyle, "\(row.role) UIKit text style")
		}
		XCTAssertEqual(Set(figma.map { "\($0.role)" }).count, 21)
	}

	func testBodyLargeGrowsAtAccessibilityExtraExtraExtraLarge() {
		let accessibility = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
		XCTAssertEqual(Track1TextRole.bodyLarge.scaledSize(compatibleWith: defaultSize), 17, accuracy: 0.001)
		XCTAssertGreaterThan(Track1TextRole.bodyLarge.scaledSize(compatibleWith: accessibility), 17)
	}

	/// Expected values come from an independent read of the font files (CoreText ascent + descent + leading)
	/// on 2026-10-13, so a fallback to the system font or a wrong formula fails here. CoreText is not
	/// rounded but `UIFont.lineHeight` is, to the screen pixel (2026-10-13, ios-check: monoMicro gave
	/// -0.667 against -0.52, 14.52 becoming 14.667 at @3x). The tolerance is one screen pixel, so it does
	/// not depend on whether UIKit rounds up or to the nearest; a system-font fallback is off by more
	/// (displayHero would give about -2.8 instead of -9.92).
	func testLineSpacingIsTheFigmaLineHeightMinusTheNaturalOne() {
		let expected: [(Track1TextRole, CGFloat)] = [
			(.displayHero, -9.92), (.title1, -2.96), (.monoMicro, -0.52), (.bodyLarge, 5.08), (.eyebrow, 1.25),
		]
		let tolerance = 1 / max(UITraitCollection.current.displayScale, 1) + 0.01
		for (role, spacing) in expected {
			XCTAssertEqual(role.lineSpacing(compatibleWith: defaultSize), spacing, accuracy: tolerance, "\(role)")
		}
	}

	func testLineSpacingGrowsWithDynamicType() {
		let accessibility = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
		// Roboto is shorter than the Figma line (positive spacing), so the spacing grows with the category.
		let role = Track1TextRole.bodyLarge
		XCTAssertGreaterThan(role.lineSpacing(compatibleWith: defaultSize), 0)
		XCTAssertGreaterThan(
			role.lineSpacing(compatibleWith: accessibility), role.lineSpacing(compatibleWith: defaultSize))
	}

	func testOnlyTheTwoDisplayRolesTrack() {
		for role in Track1TextRole.allCases {
			switch role {
			case .displayHero: XCTAssertEqual(role.tracking, -1)
			case .display: XCTAssertEqual(role.tracking, -0.4, accuracy: 0.001)
			default: XCTAssertEqual(role.tracking, 0, "\(role)")
			}
		}
	}
}
