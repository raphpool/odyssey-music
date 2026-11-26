import XCTest

@testable import Track1Core

/// The catalog models became `Encodable` for the genre snapshot (TRA-827, plan D1). A misnamed key would not
/// fail the decoding: `CatalogTaxonomy` would degrade silently, so every round trip also checks that the
/// taxonomy is still `.editorial`.
final class CatalogEncodingTests: XCTestCase {
	// Same payload as `catalogJSON` in `APIClientTests.swift`, which is private to that file.
	private let servedCatalogJSON = """
		{"version":"v1","revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taxonomy":{"mode":"degraded","available":true},"nodes":[{"identity":"artist:massive-attack","type":"artist","name":"Massive Attack","teaser":null}],"edges":[]}
		"""

	/// A family with a `slug` and one without, a genre with two slugs, a node with a teaser and one without,
	/// and a non-empty legacy table.
	private let editorialCatalogJSON = """
		{
			"version":"v1",
			"revision":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"taxonomy":{
				"mode":"editorial",
				"version":2,
				"families":[
					{"key":"electronic","label":"Electronic","order":1,"slug":"genre:electronic"},
					{"key":"rock","label":"Rock","order":2}
				],
				"genres":[
					{"id":"house","name":"House","family":"electronic","slugs":["genre:house"]},
					{"id":"techno","name":"Techno","family":"electronic","slugs":["genre:techno","genre:detroit-techno"]},
					{"id":"punk","name":"Punk","family":"rock","slugs":["genre:punk-rock"]}
				],
				"legacySelectionBySlug":{
					"genre:house":["Q10413"],
					"genre:techno":["Q11399","local:detroit"]
				}
			},
			"nodes":[
				{"identity":"genre:house","type":"genre","name":"House","teaser":"Four on the floor."},
				{"identity":"genre:techno","type":"genre","name":"Techno","teaser":null},
				{"identity":"artist:massive-attack","type":"artist","name":"Massive Attack","teaser":null}
			],
			"edges":[{"source":"artist:massive-attack","target":"genre:house","type":"genre"}]
		}
		"""

	func testServedCatalogSurvivesARoundTrip() throws {
		let original = try decode(servedCatalogJSON)

		XCTAssertEqual(try roundTrip(original), original)
	}

	func testEditorialCatalogSurvivesARoundTripAndStaysEditorial() throws {
		let original = try decode(editorialCatalogJSON)
		guard case .editorial(let expected) = original.taxonomy else {
			return XCTFail("The fixture must decode as an editorial taxonomy, or the test proves nothing.")
		}

		let decoded = try roundTrip(original)

		XCTAssertEqual(decoded, original)
		XCTAssertEqual(decoded.taxonomy, .editorial(expected), "A misnamed key degrades the taxonomy silently.")
	}

	func testDegradedTaxonomySurvivesARoundTrip() throws {
		let original = try decode(servedCatalogJSON)
		XCTAssertEqual(original.taxonomy, .degraded(available: true))

		XCTAssertEqual(try roundTrip(original).taxonomy, .degraded(available: true))
	}

	func testEncodedJSONHasTheServedShape() throws {
		let data = try JSONEncoder().encode(try decode(editorialCatalogJSON))
		let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])

		let taxonomy = try XCTUnwrap(root["taxonomy"] as? [String: Any])
		XCTAssertEqual(taxonomy["mode"] as? String, "editorial", "`mode` sits beside `families`, not above it.")
		XCTAssertEqual(taxonomy["version"] as? Int, 2)
		let families = try XCTUnwrap(taxonomy["families"] as? [[String: Any]])
		XCTAssertEqual(families.count, 2)
		XCTAssertEqual(families[0]["slug"] as? String, "genre:electronic")
		XCTAssertFalse(families[1].keys.contains("slug"), "A family without a slug has no `slug` key.")
		let legacy = try XCTUnwrap(taxonomy["legacySelectionBySlug"] as? [String: [String]])
		XCTAssertEqual(legacy, ["genre:house": ["Q10413"], "genre:techno": ["Q11399", "local:detroit"]])

		let nodes = try XCTUnwrap(root["nodes"] as? [[String: Any]])
		let house = try XCTUnwrap(nodes.first { $0["identity"] as? String == "genre:house" })
		XCTAssertEqual(house["teaser"] as? String, "Four on the floor.")
		let techno = try XCTUnwrap(nodes.first { $0["identity"] as? String == "genre:techno" })
		XCTAssertTrue(techno.keys.contains("teaser"), "The decoder requires the key, so it is always written.")
		XCTAssertTrue(techno["teaser"] is NSNull)
	}

	private func decode(_ json: String) throws -> Catalog {
		try JSONDecoder().decode(Catalog.self, from: Data(json.utf8))
	}

	private func roundTrip(_ catalog: Catalog) throws -> Catalog {
		try JSONDecoder().decode(Catalog.self, from: JSONEncoder().encode(catalog))
	}
}
