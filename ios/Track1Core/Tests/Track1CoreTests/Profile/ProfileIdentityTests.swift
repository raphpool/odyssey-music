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
		XCTAssertEqual(PseudoRules.normalized("Ra\u{0000}ph\u{0007}\u{007F}\u{001F}\u{0090}"), "Raph")
		XCTAssertNil(PseudoRules.normalized("\u{0000}\u{0007}\u{001F}"))
	}

	func testTabsAndLineBreaksSeparateWordsLikeASpace() {
		for separator in ["\t", "\n", "\r\n", "\u{0085}", "\u{2028}", "\u{2029}"] {
			let raw = "Raph\(separator)Doe"
			XCTAssertEqual(PseudoRules.normalized(raw), "Raph Doe", "\(separator.unicodeScalars.map(\.value))")
		}
		XCTAssertEqual(PseudoRules.normalized("a \n b"), "a b")
		XCTAssertEqual(PseudoRules.normalized("\n Raph \t"), "Raph")
		XCTAssertNil(PseudoRules.normalized("\n\n\t"))
	}

	func testEveryBidirectionalControlIsRemoved() {
		let values = [0x061C, 0x200E, 0x200F] + Array(0x202A...0x202E) + Array(0x2066...0x2069)
		let controls = values.compactMap { Unicode.Scalar($0) }.map { String(Character($0)) }
		XCTAssertEqual(controls.count, values.count)
		for control in controls {
			let raw = "\(control)Raph\(control)"
			XCTAssertEqual(PseudoRules.normalized(raw), "Raph", "\(control.unicodeScalars.map(\.value))")
		}
		XCTAssertNil(PseudoRules.normalized(controls.joined()))
	}

	func testAPseudoWithNothingVisibleIsRefused() {
		let invisibles = [
			"\u{200B}", "\u{200C}", "\u{200D}", "\u{2060}", "\u{FEFF}", "\u{00AD}", "\u{3164}", "\u{E0020}",
			"\u{200B} \u{200D}", " \u{200B}\n\u{FEFF} ",
		]
		for raw in invisibles {
			XCTAssertNil(PseudoRules.normalized(raw), "\(raw.unicodeScalars.map(\.value))")
		}
	}

	func testACombiningMarkAfterASpaceIsNotLost() {
		let raw = "Raph \u{0301}Doe"
		XCTAssertEqual(PseudoRules.normalized(raw)?.unicodeScalars.map(\.value), raw.unicodeScalars.map(\.value))
	}

	func testJoinersSurviveBecauseComposedEmojiNeedThem() {
		XCTAssertEqual(PseudoRules.normalized(family), family)
		XCTAssertEqual(PseudoRules.normalized("a\u{200C}b"), "a\u{200C}b")
	}

	func testNormalizationIsIdempotent() throws {
		let raws = [
			"  Raph  ", "Raph   Doe", String(repeating: "a", count: 19) + " b", "\u{202E}Ra\nph\u{202C}",
			String(repeating: family, count: 25), "e\u{0301}  e\u{0301}", "a \n b", "\u{200B}Raph", "Raph \u{0301}Doe",
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
