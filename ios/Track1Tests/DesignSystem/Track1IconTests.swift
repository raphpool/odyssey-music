import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// The glyph-to-symbol table is the list of the Icon doc `170:78` (read 2026-10-13), in its order.
final class Track1IconTests: XCTestCase {
	private let symbols: [(glyph: Track1Icon.Glyph, name: String)] = [
		(.check, "checkmark"),
		(.chevronDown, "chevron.down"),
		(.chevronRight, "chevron.right"),
		(.close, "xmark"),
		(.home, "house"),
		(.more, "ellipsis"),
		(.musicNote, "music.note"),
		(.play, "play.fill"),
		(.search, "magnifyingglass"),
	]

	func testEveryGlyphIsItsSFSymbol() {
		XCTAssertEqual(symbols.count, 9)
		XCTAssertEqual(Track1Icon.Glyph.allCases, symbols.map(\.glyph))
		for (glyph, name) in symbols {
			XCTAssertEqual(glyph.systemName, name, "\(glyph)")
		}
	}

	func testEverySymbolExistsOnTheSystem() {
		for (glyph, name) in symbols {
			XCTAssertNotNil(UIImage(systemName: name), "\(glyph): \(name) is not an SF Symbol")
		}
	}

	func testEveryToneIsItsIconColor() {
		let expected: [(Track1Icon.Tone, Color)] = [
			(.primary, Track1Tokens.colorIconPrimary),
			(.secondary, Track1Tokens.colorIconSecondary),
			(.inverse, Track1Tokens.colorIconInverse),
		]
		XCTAssertEqual(Track1Icon.Tone.allCases, expected.map(\.0))
		for (tone, color) in expected {
			XCTAssertEqual(rgbaBytes(tone.color), rgbaBytes(color), "\(tone)")
		}
	}

	func testTonesAreTheFigmaHexValues() {
		XCTAssertEqual(rgbaBytes(Track1Icon.Tone.primary.color), [0xF6, 0xE9, 0xD8, 0xFF])
		XCTAssertEqual(rgbaBytes(Track1Icon.Tone.secondary.color), [0xC8, 0xB6, 0xA3, 0xFF])
		XCTAssertEqual(rgbaBytes(Track1Icon.Tone.inverse.color), [0x0B, 0x07, 0x06, 0xFF])
	}

	func testTheIconFrameIs20Points() {
		XCTAssertEqual(Track1Icon.defaultSize, 20)
	}

	func testIconButtonOffersAtLeast44By44Points() {
		for size in Track1ControlSize.allCases {
			let target = Track1IconButton.targetSize(for: size)
			XCTAssertGreaterThanOrEqual(target.width, 44, "\(size)")
			XCTAssertGreaterThanOrEqual(target.height, 44, "\(size)")
		}
		XCTAssertEqual(Track1IconButton.targetSize(for: .medium), CGSize(width: 44, height: 44))
		XCTAssertEqual(Track1IconButton.targetSize(for: .large), CGSize(width: 52, height: 52))
	}

	// MARK: Helpers

	private func rgbaBytes(_ color: Color) -> [UInt8] {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return [] }
		return [red, green, blue, alpha].map { UInt8(($0 * 255).rounded()) }
	}
}
