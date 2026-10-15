import XCTest

@testable import Track1Core

final class CatalogTaxonomyTests: XCTestCase {
	private let editorialBody = """
		"version":2,
		"families":[
			{"key":"electronic","label":"Electronic","order":1,"slug":"genre:electronic"},
			{"key":"rock","label":"Rock","order":2}
		],
		"genres":[
			{"id":"house","name":"House","family":"electronic","slugs":["genre:house"],"qid":"Q10413"},
			{"id":"techno","name":"Techno","family":"electronic","slugs":["genre:techno","genre:detroit-techno"]},
			{"id":"punk","name":"Punk","family":"rock","slugs":["genre:punk-rock"]}
		],
		"legacySelectionBySlug":{
			"genre:house":["Q10413"],
			"genre:techno":["Q11399","local:detroit"],
			"genre:punk-rock":[]
		}
		"""

	private func decode(_ json: String) throws -> CatalogTaxonomy {
		try JSONDecoder().decode(CatalogTaxonomy.self, from: Data(json.utf8))
	}

	private func editorial(replacing target: String, with replacement: String) throws -> CatalogTaxonomy {
		try editorial(mutations: [(target, replacement)])
	}

	private func editorial(mutations: [(String, String)]) throws -> CatalogTaxonomy {
		var body = editorialBody
		for (target, replacement) in mutations {
			XCTAssertTrue(body.contains(target), "the mutation must change the payload: \(target)")
			body = body.replacingOccurrences(of: target, with: replacement)
		}
		return try decode(#"{"mode":"editorial",\#(body)}"#)
	}

	private func identity(_ raw: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: raw))
	}

	func testDegradedModeDecodesAvailability() throws {
		XCTAssertEqual(try decode(#"{"mode":"degraded","available":true}"#), .degraded(available: true))
		XCTAssertEqual(try decode(#"{"mode":"degraded","available":false}"#), .degraded(available: false))
	}

	func testDegradedModeRequiresAvailable() {
		XCTAssertThrowsError(try decode(#"{"mode":"degraded"}"#))
	}

	func testEditorialPayloadDecodesWithServedValuesAndOrder() throws {
		let taxonomy = try decode(#"{"mode":"editorial",\#(editorialBody)}"#)
		guard case .editorial(let value) = taxonomy else { return XCTFail("expected editorial, got \(taxonomy)") }
		XCTAssertEqual(value.families.map(\.key), ["electronic", "rock"])
		XCTAssertEqual(value.families.map(\.label), ["Electronic", "Rock"])
		XCTAssertEqual(value.families.map(\.order), [1, 2])
		XCTAssertEqual(value.families.map(\.slug), [try identity("genre:electronic"), nil])
		XCTAssertEqual(value.genres.map(\.id), ["house", "techno", "punk"])
		XCTAssertEqual(value.genres.map(\.name), ["House", "Techno", "Punk"])
		XCTAssertEqual(value.genres.map(\.family), ["electronic", "electronic", "rock"])
		XCTAssertEqual(
			value.genres[1].slugs, [try identity("genre:techno"), try identity("genre:detroit-techno")])
		XCTAssertEqual(
			value.legacySelectionBySlug,
			[
				try identity("genre:house"): ["Q10413"],
				try identity("genre:techno"): ["Q11399", "local:detroit"],
				try identity("genre:punk-rock"): [],
			])
	}

	func testUnknownModeDegradesInsteadOfFailing() throws {
		XCTAssertEqual(try decode(#"{"mode":"v3","available":true}"#), .degraded(available: false))
		XCTAssertEqual(try decode(#"{"mode":"v3"}"#), .degraded(available: false))
	}

	func testEditorialWithUnsupportedVersionDegrades() throws {
		XCTAssertEqual(
			try editorial(replacing: #""version":2"#, with: #""version":3"#), .degraded(available: false))
	}

	func testEditorialWithNonGenreSlugDegrades() throws {
		XCTAssertEqual(
			try editorial(replacing: #""genre:house"]"#, with: #""artist:massive-attack"]"#),
			.degraded(available: false))
		XCTAssertEqual(
			try editorial(replacing: #""slug":"genre:electronic""#, with: #""slug":"artist:aphex-twin""#),
			.degraded(available: false))
		XCTAssertEqual(
			try editorial(replacing: #""genre:punk-rock":[]"#, with: #""label:warp":[]"#),
			.degraded(available: false))
	}

	func testEditorialWithUnknownFamilyDegrades() throws {
		XCTAssertEqual(
			try editorial(replacing: #""family":"rock""#, with: #""family":"jazz""#), .degraded(available: false))
	}

	func testEditorialWithDuplicateKeysOrIdsDegrades() throws {
		// Every genre also moves to the surviving family, so only the duplicate-key rule can fire.
		XCTAssertEqual(
			try editorial(mutations: [
				(#""key":"rock""#, #""key":"electronic""#), (#""family":"rock""#, #""family":"electronic""#),
			]),
			.degraded(available: false))
		XCTAssertEqual(
			try editorial(replacing: #""id":"punk""#, with: #""id":"house""#), .degraded(available: false))
	}

	func testEditorialWithMalformedFieldsDegrades() throws {
		XCTAssertEqual(
			try editorial(replacing: #""label":"Rock""#, with: #""label":"""#), .degraded(available: false))
		XCTAssertEqual(try editorial(replacing: #""order":2"#, with: #""order":2.5"#), .degraded(available: false))
		XCTAssertEqual(
			try editorial(replacing: #""families":["#, with: #""families":{"a":1},"unused":["#),
			.degraded(available: false))
	}

	func testMissingModeIsAContractError() {
		XCTAssertThrowsError(try decode(#"{"available":true}"#))
	}

	func testCatalogWithoutTaxonomyIsAContractError() {
		let json = """
			{"version":"v1","revision":"sha256:\(String(repeating: "a", count: 64))","nodes":[],"edges":[]}
			"""
		XCTAssertThrowsError(try JSONDecoder().decode(Catalog.self, from: Data(json.utf8)))
	}

	func testCatalogCarriesEditorialTaxonomy() throws {
		let json = """
			{"version":"v1","revision":"sha256:\(String(repeating: "a", count: 64))",
			"taxonomy":{"mode":"editorial",\(editorialBody)},"nodes":[],"edges":[]}
			"""
		let catalog = try JSONDecoder().decode(Catalog.self, from: Data(json.utf8))
		guard case .editorial(let value) = catalog.taxonomy else { return XCTFail("expected editorial") }
		XCTAssertEqual(value.genres.count, 3)
	}
}
