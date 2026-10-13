import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Every token is spelled out again here, with the name and the value read from the Figma file
/// `phudxrQNlzQJafXLma4FyX` on 2026-10-13: colors by `get_variable_defs` on `180:6`; spacing, radius and
/// sizes from the labels of `180:479` (not bound variables, so `get_variable_defs` returns none for
/// them); motion from `180:581`. A value changed in `Track1Tokens` alone fails here. The local tokens, which
/// are not in the Figma file, are listed apart in `testLocalSizesAreListedApartFromTheFigmaOnes`.
final class Track1TokensTests: XCTestCase {
	private let colors: [(name: String, color: Color, hex: String)] = [
		("theme.color.text.primary", Track1Tokens.colorTextPrimary, "f6e9d8"),
		("theme.color.text.secondary", Track1Tokens.colorTextSecondary, "c8b6a3"),
		("theme.color.text.tertiary", Track1Tokens.colorTextTertiary, "8d7a6d"),
		("theme.color.text.inverse", Track1Tokens.colorTextInverse, "0b0706"),
		("theme.color.text.action", Track1Tokens.colorTextAction, "5d7fa8"),
		("theme.color.text.danger", Track1Tokens.colorTextDanger, "e56e5a"),
		("theme.color.text.disabled", Track1Tokens.colorTextDisabled, "5b4a41"),
		("theme.color.background.base", Track1Tokens.colorBackgroundBase, "120c0a"),
		("theme.color.background.elevated", Track1Tokens.colorBackgroundElevated, "1a110e"),
		("theme.color.background.subtle", Track1Tokens.colorBackgroundSubtle, "1a110e"),
		("theme.color.surface.default", Track1Tokens.colorSurfaceDefault, "241713"),
		("theme.color.surface.pressed", Track1Tokens.colorSurfacePressed, "302019"),
		("theme.color.surface.selected", Track1Tokens.colorSurfaceSelected, "3f432d"),
		("theme.color.icon.primary", Track1Tokens.colorIconPrimary, "f6e9d8"),
		("theme.color.icon.secondary", Track1Tokens.colorIconSecondary, "c8b6a3"),
		("theme.color.icon.inverse", Track1Tokens.colorIconInverse, "0b0706"),
		("theme.color.icon.action", Track1Tokens.colorIconAction, "f0642d"),
		("theme.color.icon.disabled", Track1Tokens.colorIconDisabled, "5b4a41"),
		("theme.color.border.default", Track1Tokens.colorBorderDefault, "443027"),
		("theme.color.border.strong", Track1Tokens.colorBorderStrong, "6a4938"),
		("theme.color.border.focus", Track1Tokens.colorBorderFocus, "5d7fa8"),
		("theme.color.border.contrast", Track1Tokens.colorBorderContrast, "ffffff85"),
		("theme.color.action.primary", Track1Tokens.colorActionPrimary, "f6e9d8"),
		("theme.color.action.primaryPressed", Track1Tokens.colorActionPrimaryPressed, "c8b6a3"),
		("theme.color.action.secondary", Track1Tokens.colorActionSecondary, "e6a23a"),
		("theme.color.action.secondaryPressed", Track1Tokens.colorActionSecondaryPressed, "bc7722"),
		("theme.color.action.disabled", Track1Tokens.colorActionDisabled, "241713"),
		("theme.color.action.ghost", Track1Tokens.colorActionGhost, "00000000"),
		("theme.color.action.ghostPressed", Track1Tokens.colorActionGhostPressed, "1a110e"),
		("theme.color.status.dangerBackground", Track1Tokens.colorStatusDangerBackground, "3c1e1a"),
		("theme.color.status.dangerContent", Track1Tokens.colorStatusDangerContent, "e56e5a"),
		("theme.color.status.successBackground", Track1Tokens.colorStatusSuccessBackground, "26301f"),
		("theme.color.status.successContent", Track1Tokens.colorStatusSuccessContent, "8da66b"),
		("theme.color.overlay.scrim", Track1Tokens.colorOverlayScrim, "0000008a"),
		("theme.color.glass.surface", Track1Tokens.colorGlassSurface, "090a0ead"),
		("theme.color.glass.border", Track1Tokens.colorGlassBorder, "ffffff42"),
		("theme.color.glass.selected", Track1Tokens.colorGlassSelected, "ffffff42"),
		("theme.color.node.artist", Track1Tokens.colorNodeArtist, "5d7fa8"),
		("theme.color.node.project", Track1Tokens.colorNodeProject, "e6a23a"),
		("theme.color.node.track", Track1Tokens.colorNodeTrack, "f0642d"),
		("theme.color.node.genre", Track1Tokens.colorNodeGenre, "8da66b"),
		("theme.color.node.label", Track1Tokens.colorNodeLabel, "c8b6a3"),
		("theme.color.selection.content", Track1Tokens.colorSelectionContent, "bc7722"),
		("theme.color.selection.border", Track1Tokens.colorSelectionBorder, "bc7722"),
		("theme.color.selection.surface", Track1Tokens.colorSelectionSurface, "302019"),
		("theme.color.progress.track", Track1Tokens.colorProgressTrack, "8d7a6d"),
		("theme.color.progress.indicator", Track1Tokens.colorProgressIndicator, "8d7a6d"),
	]

	func testThereAre47ColorsWithUniqueNames() {
		XCTAssertEqual(colors.count, 47)
		XCTAssertEqual(Set(colors.map(\.name)).count, 47)
	}

	func testColorsMatchFigmaToOneOver255() throws {
		for (name, color, hex) in colors {
			XCTAssertEqual(rgbaBytes(of: color, name: name), try bytes(ofHex: hex), name)
		}
	}

	func testNamedAcceptanceColors() {
		XCTAssertEqual(rgbaBytes(of: Track1Tokens.colorTextPrimary), [0xF6, 0xE9, 0xD8, 0xFF])
		XCTAssertEqual(rgbaBytes(of: Track1Tokens.colorBackgroundElevated), [0x1A, 0x11, 0x0E, 0xFF])
		XCTAssertEqual(rgbaBytes(of: Track1Tokens.colorBorderDefault), [0x44, 0x30, 0x27, 0xFF])
	}

	func testAlphaIsKept() {
		XCTAssertEqual(rgbaBytes(of: Track1Tokens.colorOverlayScrim).last, 0x8A)
		XCTAssertEqual(rgbaBytes(of: Track1Tokens.colorActionGhost).last, 0x00)
	}

	func testNodeColorsFollowTheNodeType() throws {
		let expected: [NodeType: String] = [
			.artist: "5D7FA8", .project: "E6A23A", .track: "F0642D", .genre: "8DA66B", .label: "C8B6A3",
		]
		XCTAssertEqual(Set(expected.keys), Set(NodeType.allCases))
		for (type, hex) in expected {
			XCTAssertEqual(
				rgbaBytes(of: Track1Tokens.colorNode(type)), try bytes(ofHex: hex), type.rawValue)
		}
	}

	func testSpacingMatchesFigma() {
		let expected: [(String, CGFloat, CGFloat)] = [
			("spacing/0", Track1Tokens.spacing0, 0),
			("spacing/2", Track1Tokens.spacing2, 2),
			("spacing/4", Track1Tokens.spacing4, 4),
			("spacing/6", Track1Tokens.spacing6, 6),
			("spacing/8", Track1Tokens.spacing8, 8),
			("spacing/10", Track1Tokens.spacing10, 10),
			("spacing/12", Track1Tokens.spacing12, 12),
			("spacing/16", Track1Tokens.spacing16, 16),
			("spacing/20", Track1Tokens.spacing20, 20),
			("spacing/24", Track1Tokens.spacing24, 24),
			("spacing/32", Track1Tokens.spacing32, 32),
			("spacing/40", Track1Tokens.spacing40, 40),
			("spacing/48", Track1Tokens.spacing48, 48),
			("spacing/64", Track1Tokens.spacing64, 64),
		]
		XCTAssertEqual(expected.count, 14)
		for (name, actual, value) in expected { XCTAssertEqual(actual, value, name) }
	}

	func testRadiiMatchFigma() {
		let expected: [(String, CGFloat, CGFloat)] = [
			("radius/0", Track1Tokens.radius0, 0),
			("radius/8", Track1Tokens.radius8, 8),
			("radius/12", Track1Tokens.radius12, 12),
			("radius/16", Track1Tokens.radius16, 16),
			("radius/20", Track1Tokens.radius20, 20),
			("radius/full", Track1Tokens.radiusFull, 999),
		]
		XCTAssertEqual(expected.count, 6)
		for (name, actual, value) in expected { XCTAssertEqual(actual, value, name) }
	}

	func testSizesMatchFigma() {
		let expected: [(String, CGFloat, CGFloat)] = [
			("size/control-medium", Track1Tokens.sizeControlMedium, 44),
			("size/control-large", Track1Tokens.sizeControlLarge, 52),
			("size/icon-small", Track1Tokens.sizeIconSmall, 16),
			("size/icon-medium", Track1Tokens.sizeIconMedium, 20),
			("size/icon-large", Track1Tokens.sizeIconLarge, 24),
			("size/artwork-small", Track1Tokens.sizeArtworkSmall, 48),
			("size/artwork-medium", Track1Tokens.sizeArtworkMedium, 64),
			("size/artwork-large", Track1Tokens.sizeArtworkLarge, 96),
			("size/hero-artwork", Track1Tokens.sizeHeroArtwork, 164),
			("size/release-card", Track1Tokens.sizeReleaseCard, 120),
			("size/genre-tile", Track1Tokens.sizeGenreTile, 176),
		]
		XCTAssertEqual(expected.count, 11)
		for (name, actual, value) in expected { XCTAssertEqual(actual, value, name) }
	}

	/// Not Figma variables (TRA-443, 2026-10-13): the Figma draws the Large Artwork glyph and the SearchField
	/// icon at these sizes without a token. Kept out of `testSizesMatchFigma` on purpose, so that a local token
	/// can never stand in for a Figma size that is missing.
	func testLocalSizesAreListedApartFromTheFigmaOnes() {
		let expected: [(String, CGFloat, CGFloat)] = [
			("local/size/icon-xlarge", Track1Tokens.sizeIconXLarge, 28),
			("local/size/icon-search", Track1Tokens.sizeIconSearch, 22),
		]
		for (name, actual, value) in expected { XCTAssertEqual(actual, value, accuracy: 0.001, name) }
	}

	func testMotionDurationsMatchFigma() {
		XCTAssertEqual(Track1Motion.fast.duration, 0.12)
		XCTAssertEqual(Track1Motion.standard.duration, 0.2)
		XCTAssertEqual(Track1Motion.slow.duration, 0.35)
	}

	func testReduceMotionRemovesEveryAnimation() {
		for motion in Track1Motion.allCases {
			XCTAssertNil(Track1Motion.animation(motion, reduceMotion: true), "\(motion)")
			XCTAssertNil(Track1Motion.animation(motion, emphasized: true, reduceMotion: true), "\(motion)")
		}
	}

	func testAnimationUsesTheDurationAndTheCurveOfTheToken() {
		for motion in Track1Motion.allCases {
			XCTAssertEqual(
				Track1Motion.animation(motion, reduceMotion: false),
				.timingCurve(0.2, 0, 0, 1, duration: motion.duration), "\(motion) standard curve")
			XCTAssertEqual(
				Track1Motion.animation(motion, emphasized: true, reduceMotion: false),
				.timingCurve(0.2, 0, 0, 1.2, duration: motion.duration), "\(motion) emphasized curve")
		}
	}

	/// Read from the bundle of an app class, which is the main bundle since the tests are hosted in the app.
	/// The key is a literal of the source Info.plist, identical in every scheme, so this is not one of the
	/// scheme-dependent readers that `test/ios-check.test.ts` forces into the Track1Preview list.
	func testApplicationIsForcedToTheDarkInterfaceStyle() {
		let appBundle = Bundle(for: AppContainer.self)
		XCTAssertEqual(appBundle.object(forInfoDictionaryKey: "UIUserInterfaceStyle") as? String, "Dark")
	}

	// MARK: Helpers

	private func rgbaBytes(of color: Color, name: String = "") -> [UInt8] {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
			XCTFail("\(name): the color has no RGB components")
			return []
		}
		return [red, green, blue, alpha].map { UInt8(($0 * 255).rounded()) }
	}

	/// `RRGGBB` or `RRGGBBAA`; a 6-digit value is opaque.
	private func bytes(ofHex hex: String) throws -> [UInt8] {
		let padded = hex.count == 6 ? hex + "FF" : hex
		let value = try XCTUnwrap(UInt32(padded, radix: 16), hex)
		return [24, 16, 8, 0].map { UInt8((value >> $0) & 0xFF) }
	}
}
