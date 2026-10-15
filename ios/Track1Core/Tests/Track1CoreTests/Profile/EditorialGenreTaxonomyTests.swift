import XCTest

@testable import Track1Core

final class EditorialGenreTaxonomyTests: XCTestCase {
	private func identity(_ raw: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: raw))
	}

	/// Two families served out of alphabetical order, with three genres in the first (served: Techno, Drum &
	/// Bass, House) so that neither a label sort nor a name sort can pass by accident.
	private func standardCatalog(
		teasers: [String: String] = [:],
		extraNodes: [(String, String)] = []
	) throws -> Catalog {
		try EditorialFixture.catalog(
			nodes: [
				("genre:techno", "Techno"), ("genre:drum-and-bass", "Drum and bass"), ("genre:house", "House"),
				("genre:punk-rock", "Punk rock"),
			] + extraNodes,
			edges: [],
			teasers: teasers,
			families: [
				(key: "rock", label: "Rock", order: 2),
				(key: "electronic", label: "Electronic", order: 1),
			],
			genres: [
				(id: "Q11399", name: "Techno", family: "electronic", slugs: ["genre:techno"]),
				(id: "Q1003", name: "Drum & Bass", family: "electronic", slugs: ["genre:drum-and-bass"]),
				(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house"]),
				(id: "Q3071", name: "Punk", family: "rock", slugs: ["genre:punk-rock"]),
			],
			legacy: [:]
		)
	}

	func testDegradedCatalogYieldsNoTaxonomy() throws {
		let json = """
			{"version": "v1", "revision": "sha256:\(String(repeating: "0123456789abcdef", count: 4))",
			"taxonomy": {"mode": "degraded", "available": true},
			"nodes": [{"identity": "genre:jazz", "type": "genre", "name": "Jazz", "teaser": null}], "edges": []}
			"""
		let catalog = try JSONDecoder().decode(Catalog.self, from: Data(json.utf8))
		XCTAssertNil(EditorialGenreTaxonomy(catalog: catalog))
	}

	func testEditorialCatalogWithoutAnyPresentSlugYieldsNoTaxonomy() throws {
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:jazz", "Jazz")],
			edges: [],
			families: [(key: "electronic", label: "Electronic", order: 1)],
			genres: [(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house"])]
		)
		XCTAssertNil(EditorialGenreTaxonomy(catalog: catalog))
	}

	func testFamiliesFollowServedOrderAndNotTheirLabel() throws {
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: try standardCatalog()))
		// "Rock" is served first in the payload but has the higher `order`.
		XCTAssertEqual(taxonomy.families.map(\.id), ["electronic", "rock"])

		// Here the label order (Alpha, Zulu) is the opposite of `order`, so a label sort would fail.
		let flipped = try EditorialFixture.catalog(
			nodes: [("genre:house", "House"), ("genre:punk-rock", "Punk rock")],
			edges: [],
			families: [
				(key: "a-late", label: "Alpha", order: 9),
				(key: "z-early", label: "Zulu", order: 1),
			],
			genres: [
				(id: "Q10413", name: "House", family: "a-late", slugs: ["genre:house"]),
				(id: "Q3071", name: "Punk", family: "z-early", slugs: ["genre:punk-rock"]),
			]
		)
		let byOrder = try XCTUnwrap(EditorialGenreTaxonomy(catalog: flipped))
		XCTAssertEqual(byOrder.families.map(\.name), ["Zulu", "Alpha"])
	}

	func testFamiliesWithTheSameOrderFallBackToTheirKey() throws {
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:house", "House"), ("genre:punk-rock", "Punk rock")],
			edges: [],
			families: [
				(key: "rock", label: "Rock", order: 1),
				(key: "electronic", label: "Electronic", order: 1),
			],
			genres: [
				(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house"]),
				(id: "Q3071", name: "Punk", family: "rock", slugs: ["genre:punk-rock"]),
			]
		)
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
		XCTAssertEqual(taxonomy.families.map(\.id), ["electronic", "rock"])
	}

	func testFamilyWithoutAVisibleGenreIsHidden() throws {
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:house", "House")],
			edges: [],
			families: [
				(key: "electronic", label: "Electronic", order: 1),
				(key: "jazz", label: "Jazz", order: 2),
				(key: "empty", label: "Empty", order: 3),
			],
			genres: [
				(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house"]),
				(id: "Q8341", name: "Bebop", family: "jazz", slugs: ["genre:bebop"]),
			]
		)
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
		XCTAssertEqual(taxonomy.families, [FamilyChoice(id: "electronic", name: "Electronic")])
		XCTAssertNil(taxonomy.family("jazz"))
		XCTAssertNil(taxonomy.family("empty"))
		XCTAssertEqual(taxonomy.genres(of: "jazz"), [])
		XCTAssertEqual(taxonomy.family("electronic"), FamilyChoice(id: "electronic", name: "Electronic"))
	}

	func testGenreKeepsOnlyTheSlugsPresentInTheCatalog() throws {
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:detroit-techno", "Detroit techno")],
			edges: [],
			families: [(key: "electronic", label: "Electronic", order: 1)],
			genres: [
				(
					id: "Q11399", name: "Techno", family: "electronic",
					slugs: ["genre:techno", "genre:detroit-techno"]
				)
			]
		)
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
		XCTAssertEqual(taxonomy.genre("Q11399")?.slugs, [try identity("genre:detroit-techno")])
	}

	func testGenreWithoutAnyPresentSlugIsAbsent() throws {
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:house", "House")],
			edges: [],
			families: [(key: "electronic", label: "Electronic", order: 1)],
			genres: [
				(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house"]),
				(id: "Q11399", name: "Techno", family: "electronic", slugs: ["genre:techno"]),
			]
		)
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
		XCTAssertEqual(taxonomy.genres(of: "electronic").map(\.id), ["Q10413"])
		XCTAssertNil(taxonomy.genre("Q11399"))
	}

	func testRowUsesTheEditorialNameAndTheNodeTeaser() throws {
		let teaser = "Fast breakbeat music with heavy sub-bass."
		let taxonomy = try XCTUnwrap(
			EditorialGenreTaxonomy(catalog: try standardCatalog(teasers: ["genre:drum-and-bass": teaser])))
		let row = try XCTUnwrap(taxonomy.genre("Q1003"))
		XCTAssertEqual(row.name, "Drum & Bass")
		XCTAssertEqual(row.definition, teaser)
		XCTAssertEqual(row.family, "electronic")
		XCTAssertEqual(row.slugs, [try identity("genre:drum-and-bass")])
	}

	func testBlankOrMissingTeaserYieldsNoDefinition() throws {
		let taxonomy = try XCTUnwrap(
			EditorialGenreTaxonomy(
				catalog: try standardCatalog(teasers: ["genre:drum-and-bass": "", "genre:techno": " \n\t "])))
		XCTAssertNil(taxonomy.genre("Q1003")?.definition, "empty teaser")
		XCTAssertNil(taxonomy.genre("Q11399")?.definition, "whitespace-only teaser")
		XCTAssertNil(taxonomy.genre("Q10413")?.definition, "null teaser")
	}

	func testDefinitionComesFromTheFirstPresentSlug() throws {
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:detroit-techno", "Detroit techno"), ("genre:minimal-techno", "Minimal techno")],
			edges: [],
			teasers: ["genre:detroit-techno": "From Detroit.", "genre:minimal-techno": "Stripped back."],
			families: [(key: "electronic", label: "Electronic", order: 1)],
			genres: [
				(
					id: "Q11399", name: "Techno", family: "electronic",
					slugs: ["genre:techno", "genre:detroit-techno", "genre:minimal-techno"]
				)
			]
		)
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
		XCTAssertEqual(taxonomy.genre("Q11399")?.definition, "From Detroit.")
		XCTAssertEqual(
			taxonomy.genre("Q11399")?.slugs,
			[try identity("genre:detroit-techno"), try identity("genre:minimal-techno")])
	}

	func testGenresKeepTheServedOrderRatherThanAnAlphabeticalOne() throws {
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: try standardCatalog()))
		let served = taxonomy.genres(of: "electronic").map(\.name)
		XCTAssertEqual(served, ["Techno", "Drum & Bass", "House"])
		XCTAssertNotEqual(served, served.sorted(), "the fixture must make an alphabetical sort observable")
	}

	func testLegacyGenreIDsDropInvisibleGenresAndUnknownSlugs() throws {
		let catalog = try EditorialFixture.catalog(
			nodes: [("genre:house", "House"), ("genre:punk-rock", "Punk rock"), ("genre:ambient", "Ambient")],
			edges: [],
			families: [(key: "electronic", label: "Electronic", order: 1)],
			genres: [
				(id: "Q10413", name: "House", family: "electronic", slugs: ["genre:house"]),
				(id: "Q11399", name: "Techno", family: "electronic", slugs: ["genre:techno"]),
			],
			legacy: [
				"genre:house": ["Q10413"],
				"genre:punk-rock": ["Q11399", "Q10413", "local:ghost"],
				"genre:techno": ["Q11399"],
			]
		)
		let taxonomy = try XCTUnwrap(EditorialGenreTaxonomy(catalog: catalog))
		XCTAssertEqual(taxonomy.legacyGenreIDs(for: try identity("genre:house")), ["Q10413"])
		// Q11399 has no present slug and "local:ghost" is not a taxonomy genre: only Q10413 survives.
		XCTAssertEqual(taxonomy.legacyGenreIDs(for: try identity("genre:punk-rock")), ["Q10413"])
		XCTAssertEqual(taxonomy.legacyGenreIDs(for: try identity("genre:techno")), [])
		// In the catalog but not in the legacy table, then in neither.
		XCTAssertEqual(taxonomy.legacyGenreIDs(for: try identity("genre:ambient")), [])
		XCTAssertEqual(taxonomy.legacyGenreIDs(for: try identity("genre:never-heard-of")), [])
	}
}

/// Builds a catalog whose taxonomy is `editorial`. Every input is explicit (no default family or genre) so
/// the onboarding model tests can describe exactly the taxonomy they need.
enum EditorialFixture {
	static func catalog(
		nodes: [(String, String)],
		edges: [(String, String, String)],
		teasers: [String: String] = [:],
		families: [(key: String, label: String, order: Int)],
		genres: [(id: String, name: String, family: String, slugs: [String])],
		legacy: [String: [String]] = [:]
	) throws -> Catalog {
		let payload: [String: Any] = [
			"version": "v1", "revision": "sha256:" + String(repeating: "0123456789abcdef", count: 4),
			"taxonomy": [
				"mode": "editorial", "version": 2,
				"families": families.map { ["key": $0.key, "label": $0.label, "order": $0.order] as [String: Any] },
				"genres": genres.map {
					["id": $0.id, "name": $0.name, "family": $0.family, "slugs": $0.slugs] as [String: Any]
				},
				"legacySelectionBySlug": legacy,
			] as [String: Any],
			"nodes": nodes.map { identity, name -> [String: Any] in
				[
					"identity": identity, "type": String(identity.prefix(while: { $0 != ":" })), "name": name,
					"teaser": teasers[identity] ?? NSNull(),
				]
			},
			"edges": edges.map { ["source": $0.0, "target": $0.1, "type": $0.2] },
		]
		return try JSONDecoder().decode(Catalog.self, from: JSONSerialization.data(withJSONObject: payload))
	}
}
