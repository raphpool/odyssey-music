import XCTest

@testable import Track1Core

/// The French content of a node page (TRA-814): shown alone on a French device, ignored everywhere else.
final class NodeLocalizationTests: XCTestCase {
	private static let french = """
		{"fr":{"teaser":"Teaser français.","article":"Article français.",\
		"facts":{"origin":"Compton, Californie","founded":"1999"}}}
		"""

	/// A `fr` block with the given texts and a French `origin` fact.
	private static func block(teaser: String = "Teaser fr.", article: String = "Article fr.") -> String {
		#"{"fr":{"teaser":"\#(teaser)","article":"\#(article)","facts":{"origin":"Compton, Californie"}}}"#
	}

	/// A node as the API sends it, with an optional `l10n` member. `languages` pins the device languages;
	/// `nil` leaves the decoder as `APIClient` builds it, so `Locale.preferredLanguages` decides.
	private static func decode(l10n: String?, languages: [String]?) throws -> NodeDetail {
		let member = l10n.map { #","l10n":\#($0)"# } ?? ""
		let source = """
			{"id":"artist:sample","type":"artist","name":"Sample","teaser":"English teaser.",\
			"article":"English article.","citations":[],"facts":{"origin":"Compton, California","year":"1987"},\
			"edges":{},"materialized_at":"2026-10-08T00:00:00Z","image_url":null\(member)}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		if let languages { decoder.userInfo[.preferredLanguages] = languages }
		return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
	}

	private func assertStaysEnglish(_ l10n: String, _ message: String) throws {
		let node = try Self.decode(l10n: l10n, languages: ["fr-FR"])
		XCTAssertEqual(node.contentLanguage, .en, message)
		XCTAssertEqual(node.teaser, "English teaser.", message)
		XCTAssertEqual(node.article, "English article.", message)
		XCTAssertEqual(node.facts, ["origin": "Compton, California", "year": "1987"], message)
	}

	// MARK: - Decoding

	func testAResponseWithoutL10nDecodesAsBeforeInEnglish() throws {
		for languages in [["fr-FR"], ["en-US"], []] {
			let node = try Self.decode(l10n: nil, languages: languages)
			XCTAssertEqual(node.contentLanguage, .en)
			XCTAssertEqual(node.teaser, "English teaser.")
			XCTAssertEqual(node.article, "English article.")
			XCTAssertEqual(node.facts, ["origin": "Compton, California", "year": "1987"])
		}
	}

	func testAFrenchDeviceShowsTheCompleteFrenchBlock() throws {
		let node = try Self.decode(l10n: Self.french, languages: ["fr-FR"])

		XCTAssertEqual(node.contentLanguage, .fr)
		XCTAssertEqual(node.teaser, "Teaser français.")
		XCTAssertEqual(node.article, "Article français.")
		XCTAssertEqual(node.name, "Sample")
	}

	func testAnEnglishDeviceIgnoresTheFrenchBlockEvenWhenFrenchIsSecond() throws {
		let node = try Self.decode(l10n: Self.french, languages: ["en-GB", "fr-FR"])

		XCTAssertEqual(node.contentLanguage, .en)
		XCTAssertEqual(node.teaser, "English teaser.")
		XCTAssertEqual(node.article, "English article.")
		XCTAssertEqual(node.facts, ["origin": "Compton, California", "year": "1987"])
	}

	func testWithoutAnInjectedLanguageTheDeviceLanguagesDecide() throws {
		let device = NodeDetail.preferredContentLanguage(preferredLanguages: Locale.preferredLanguages)

		let node = try Self.decode(l10n: Self.french, languages: nil)

		XCTAssertEqual(node.contentLanguage, device)
		XCTAssertEqual(node.article, device == .fr ? "Article français." : "English article.")
	}

	func testFrenchFactsReplaceTheEnglishOnesKeyByKey() throws {
		let node = try Self.decode(l10n: Self.french, languages: ["fr-FR"])

		XCTAssertEqual(node.facts["origin"], "Compton, Californie")
		XCTAssertEqual(node.facts["year"], "1987", "A fact the block does not carry keeps its value.")
	}

	func testAFrenchFactWithoutAnEnglishKeyIsIgnored() throws {
		let node = try Self.decode(l10n: Self.french, languages: ["fr-FR"])

		XCTAssertNil(node.facts["founded"])
		XCTAssertEqual(Set(node.facts.keys), ["origin", "year"])
	}

	func testABlankFrenchFactKeepsTheEnglishValue() throws {
		let block = #"{"fr":{"teaser":"T fr.","article":"A fr.","facts":{"origin":"  "}}}"#

		let node = try Self.decode(l10n: block, languages: ["fr-FR"])

		XCTAssertEqual(node.contentLanguage, .fr)
		XCTAssertEqual(node.facts["origin"], "Compton, California")
	}

	// MARK: - Incomplete blocks

	func testAnEmptyFrenchArticleLeavesEverythingInEnglish() throws {
		try assertStaysEnglish(Self.block(article: ""), "An empty article.")
	}

	func testAFrenchArticleOfWhitespaceLeavesEverythingInEnglish() throws {
		try assertStaysEnglish(Self.block(article: " \\n\\t "), "A whitespace article.")
	}

	func testABlankFrenchTeaserLeavesEverythingInEnglish() throws {
		try assertStaysEnglish(Self.block(teaser: "  "), "A blank teaser must not pair with an English article.")
	}

	func testAFrenchBlockWithoutATeaserLeavesEverythingInEnglish() throws {
		try assertStaysEnglish(#"{"fr":{"article":"Article fr."}}"#, "No teaser.")
	}

	// MARK: - Malformed blocks

	func testANullL10nDecodesInEnglish() throws {
		try assertStaysEnglish("null", "l10n is null.")
	}

	func testAStringL10nDecodesInEnglish() throws {
		try assertStaysEnglish(#""fr""#, "l10n is a string.")
	}

	func testAnArrayL10nDecodesInEnglish() throws {
		try assertStaysEnglish("[]", "l10n is an array.")
	}

	func testAFrenchBlockOfTheWrongTypeDecodesInEnglish() throws {
		try assertStaysEnglish(#"{"fr":3}"#, "fr is a number.")
		try assertStaysEnglish(#"{"fr":null}"#, "fr is null.")
	}

	func testAFrenchBlockWithAMalformedFieldDecodesInEnglish() throws {
		let block = #"{"fr":{"teaser":"T fr.","article":"A fr.","facts":{"origin":3}}}"#
		try assertStaysEnglish(block, "A fact that is not a string makes the block malformed.")
	}

	// MARK: - Device language

	func testFrenchIsTheContentLanguageWhenTheFirstPreferredLanguageIsFrench() {
		for languages in [["fr-FR"], ["fr-CA", "en"], ["fr"], ["FR-fr"]] {
			XCTAssertEqual(NodeDetail.preferredContentLanguage(preferredLanguages: languages), .fr)
		}
	}

	func testEnglishIsTheContentLanguageInEveryOtherCase() {
		// "frr" is North Frisian, not French.
		for languages in [["en-US"], ["de-DE", "fr-FR"], ["frr-DE"], []] {
			XCTAssertEqual(NodeDetail.preferredContentLanguage(preferredLanguages: languages), .en)
		}
	}

	// MARK: - Readers

	func testTheHeaderOfAFrenchNodeShowsTheFrenchTeaserAndFacts() throws {
		let node = try Self.decode(l10n: Self.french, languages: ["fr-FR"])

		let header = NodePageHeader(node: node)

		XCTAssertEqual(header.teaser, "Teaser français.")
		XCTAssertEqual(header.subtitle, "Compton, Californie")
	}

	func testTheHeaderOfAnEnglishDeviceKeepsTheEnglishTeaser() throws {
		let node = try Self.decode(l10n: Self.french, languages: ["en-GB", "fr-FR"])

		let header = NodePageHeader(node: node)

		XCTAssertEqual(header.teaser, "English teaser.")
		XCTAssertEqual(header.subtitle, "Compton, California")
	}
}
