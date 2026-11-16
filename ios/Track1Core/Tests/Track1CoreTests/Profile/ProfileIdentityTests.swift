import XCTest

@testable import Track1Core

final class ProfileIdentityTests: XCTestCase {
	/// One grapheme made of seven scalars (four emoji joined by zero width joiners).
	private let family = "\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"

	// MARK: - PseudoRules

	func testEdgeWhitespaceIsTrimmed() {
		XCTAssertEqual(PseudoRules.normalized("  Raph  "), "Raph")
	}

	func testAnEmptyOrBlankStringHasNoPseudo() {
		XCTAssertNil(PseudoRules.normalized(""))
		XCTAssertNil(PseudoRules.normalized("     "))
		XCTAssertNil(PseudoRules.normalized("\u{00A0}\u{2003} \u{3000}"))
	}

	func testARunOfSpacesCollapsesToOne() {
		XCTAssertEqual(PseudoRules.normalized("Raph   Doe"), "Raph Doe")
		XCTAssertEqual(PseudoRules.normalized("Raph \u{00A0}\u{2003} Doe"), "Raph Doe")
	}

	func testTwentyGraphemesAreKeptAndTwentyFiveAreTruncated() {
		let twenty = String(repeating: "a", count: PseudoRules.maxLength)
		XCTAssertEqual(PseudoRules.maxLength, 20)
		XCTAssertEqual(PseudoRules.normalized(twenty), twenty)
		XCTAssertEqual(PseudoRules.normalized(String(repeating: "a", count: 25)), twenty)
	}

	func testAComposedEmojiCountsForOneGrapheme() {
		XCTAssertEqual(family.count, 1)
		let twenty = String(repeating: family, count: 20)
		XCTAssertEqual(PseudoRules.normalized(twenty), twenty)
		XCTAssertEqual(PseudoRules.normalized(String(repeating: family, count: 21)), twenty)
	}

	func testTruncationCountsGraphemesNotScalars() {
		let accented = String(repeating: "e\u{0301}", count: 25)
		let result = PseudoRules.normalized(accented)
		XCTAssertEqual(result?.count, 20)
		XCTAssertEqual(result?.unicodeScalars.count, 40)
	}

	func testTruncationNeverLeavesATrailingSpace() {
		let raw = String(repeating: "a", count: 19) + " b"
		XCTAssertEqual(PseudoRules.normalized(raw), String(repeating: "a", count: 19))
	}

	func testControlCharactersAreRemoved() {
		XCTAssertEqual(PseudoRules.normalized("Ra\u{0000}ph\u{0007}"), "Raph")
		XCTAssertEqual(PseudoRules.normalized("Ra\nph\r\n"), "Raph")
		XCTAssertEqual(PseudoRules.normalized("Ra\u{007F}ph\u{0085}"), "Raph")
		XCTAssertNil(PseudoRules.normalized("\u{0000}\u{0007}\n"))
	}

	func testBidirectionalControlsAreRemoved() {
		let controls = ["\u{061C}", "\u{200E}", "\u{200F}", "\u{202A}", "\u{202E}", "\u{2066}", "\u{2069}"]
		for control in controls {
			let raw = "\(control)Raph\(control)"
			XCTAssertEqual(PseudoRules.normalized(raw), "Raph", "\(control.unicodeScalars.map(\.value))")
		}
		XCTAssertNil(PseudoRules.normalized(controls.joined()))
	}

	func testJoinersSurviveBecauseComposedEmojiNeedThem() {
		XCTAssertEqual(PseudoRules.normalized(family), family)
		XCTAssertEqual(PseudoRules.normalized("a\u{200C}b"), "a\u{200C}b")
	}

	func testNormalizationIsIdempotent() throws {
		let raws = [
			"  Raph  ", "Raph   Doe", String(repeating: "a", count: 19) + " b", "\u{202E}Ra\nph\u{202C}",
			String(repeating: family, count: 25), "e\u{0301}  e\u{0301}",
		]
		for raw in raws {
			let once = try XCTUnwrap(PseudoRules.normalized(raw))
			XCTAssertEqual(PseudoRules.normalized(once), once)
		}
	}

	// MARK: - ProfileDisc

	func testTheDiscsFollowTheFigmaGridOrder() {
		XCTAssertEqual(
			ProfileDisc.allCases.map(\.rawValue), ["iridescent", "blue", "mint", "coral", "violet", "teal"])
	}

	func testADiscRoundTripsAsItsName() throws {
		struct Box: Codable, Equatable { let disc: ProfileDisc }
		for disc in ProfileDisc.allCases {
			let data = try JSONEncoder().encode(Box(disc: disc))
			XCTAssertEqual(String(decoding: data, as: UTF8.self), "{\"disc\":\"\(disc.rawValue)\"}")
			XCTAssertEqual(try JSONDecoder().decode(Box.self, from: data), Box(disc: disc))
		}
	}

	func testAnUnknownDiscNameFailsToDecode() {
		struct Box: Codable { let disc: ProfileDisc }
		XCTAssertThrowsError(try JSONDecoder().decode(Box.self, from: Data(#"{"disc":"pink"}"#.utf8)))
	}
}
