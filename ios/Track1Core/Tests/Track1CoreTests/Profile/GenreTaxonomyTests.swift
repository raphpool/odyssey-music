import XCTest

@testable import Track1Core

final class GenreTaxonomyTests: XCTestCase {
	func testParentsAreGenresWithSubgenresAndNoParent() throws {
		let taxonomy = GenreTaxonomy(catalog: try OnboardingFixture.catalog())

		XCTAssertEqual(taxonomy.parents.map(\.name), ["Hip-Hop", "Jazz"])
		XCTAssertEqual(
			taxonomy.parents.map(\.identity.rawValue),
			["genre:hip-hop", "genre:jazz"]
		)
	}

	func testACycleBetweenTwoGenresIsExcludedAndTerminates() throws {
		let taxonomy = GenreTaxonomy(catalog: try OnboardingFixture.catalog())
		let a = try OnboardingFixture.identity("genre:cycle-a")
		let b = try OnboardingFixture.identity("genre:cycle-b")

		XCTAssertFalse(taxonomy.parents.contains { $0.identity == a || $0.identity == b })
		// Each side of the cycle still lists the other as a subgenre; only the tile is dropped.
		XCTAssertEqual(taxonomy.subgenres(of: a).map(\.identity), [b])
		XCTAssertEqual(taxonomy.subgenres(of: b).map(\.identity), [a])
	}

	func testAGenreWithoutSubgenresIsNotAParent() throws {
		let taxonomy = GenreTaxonomy(catalog: try OnboardingFixture.catalog())
		let ambient = try OnboardingFixture.identity("genre:ambient")

		XCTAssertFalse(taxonomy.parents.contains { $0.identity == ambient })
		XCTAssertEqual(taxonomy.subgenres(of: ambient), [])
	}

	func testSubgenresAreSortedAndCarryTheTeaserAsDefinition() throws {
		let taxonomy = GenreTaxonomy(catalog: try OnboardingFixture.catalog())
		let hipHop = try OnboardingFixture.identity("genre:hip-hop")

		XCTAssertEqual(taxonomy.subgenres(of: hipHop).map(\.name), ["Boom bap", "Drill", "Trap"])
		XCTAssertEqual(taxonomy.subgenres(of: hipHop).first?.definition, "Rap sampled from soul and jazz records.")
		XCTAssertNil(taxonomy.subgenres(of: hipHop).last?.definition)
	}

	func testSubgenresReadBothEdgeDirectionsWithoutDuplicatesOrTheParentItself() throws {
		let taxonomy = GenreTaxonomy(catalog: try OnboardingFixture.catalog())
		let jazz = try OnboardingFixture.identity("genre:jazz")

		// Bebop: `subgenres` edge from Jazz, repeated. Cool jazz: `parent_genres` edge from the child.
		// Jazz -> Jazz (self), Jazz -> an artist and Jazz -> a genre missing from the catalog are ignored.
		XCTAssertEqual(taxonomy.subgenres(of: jazz).map(\.name), ["Bebop", "Cool jazz"])
	}

	func testParentsAreSortedWithTheFrenchCollation() throws {
		let catalog = try OnboardingFixture.catalog(
			nodes: [
				("genre:zouk", "Zouk"), ("genre:electronique", "Électronique"), ("genre:funk", "Funk"),
				("genre:a", "A"), ("genre:b", "B"), ("genre:c", "C"),
			],
			edges: [
				("genre:zouk", "genre:a", "subgenres"),
				("genre:electronique", "genre:b", "subgenres"),
				("genre:funk", "genre:c", "subgenres"),
			]
		)

		// "Électronique" has a higher code point than "Funk" and "Zouk" but collates first in French.
		XCTAssertEqual(GenreTaxonomy(catalog: catalog).parents.map(\.name), ["Électronique", "Funk", "Zouk"])
	}

	func testASubgenreSharedByTwoParentsIsListedUnderBoth() throws {
		let catalog = try OnboardingFixture.catalog(
			nodes: [("genre:soul", "Soul"), ("genre:rnb", "R&B"), ("genre:neo-soul", "Neo soul")],
			edges: [("genre:soul", "genre:neo-soul", "subgenres"), ("genre:rnb", "genre:neo-soul", "subgenres")]
		)
		let taxonomy = GenreTaxonomy(catalog: catalog)

		XCTAssertEqual(taxonomy.parents.map(\.name), ["R&B", "Soul"])
		XCTAssertEqual(taxonomy.subgenres(of: try OnboardingFixture.identity("genre:soul")).count, 1)
		XCTAssertEqual(taxonomy.subgenres(of: try OnboardingFixture.identity("genre:rnb")).count, 1)
	}

	func testAnEmptyCatalogHasNoParents() throws {
		let taxonomy = GenreTaxonomy(catalog: try OnboardingFixture.catalog(nodes: [], edges: []))

		XCTAssertEqual(taxonomy.parents, [])
	}
}

/// Catalog fixtures shared by the onboarding tests. The catalog is only decodable, so it is built from JSON.
extension GenreTaxonomyTests {
	func testParentOfSubgenreResolvesTheFirstParentInTileOrderAndIgnoresNonSubgenres() throws {
		let taxonomy = GenreTaxonomy(catalog: try OnboardingFixture.catalog())
		let hipHop = try OnboardingFixture.identity("genre:hip-hop")
		let jazz = try OnboardingFixture.identity("genre:jazz")

		XCTAssertEqual(taxonomy.parent(ofSubgenre: try OnboardingFixture.identity("genre:drill")), hipHop)
		XCTAssertEqual(taxonomy.parent(ofSubgenre: try OnboardingFixture.identity("genre:cool-jazz")), jazz)
		XCTAssertNil(taxonomy.parent(ofSubgenre: hipHop))
		XCTAssertNil(taxonomy.parent(ofSubgenre: try OnboardingFixture.identity("genre:ambient")))
	}

	func testAncestorsOfLevelThreeFollowAChainFromAParentOnly() throws {
		let taxonomy = GenreTaxonomy(
			catalog: try OnboardingFixture.catalog(
				nodes: [("genre:rock", "Rock"), ("genre:alt-rock", "Alt rock"), ("genre:grunge", "Grunge")],
				edges: [("genre:rock", "genre:alt-rock", "subgenres"), ("genre:alt-rock", "genre:grunge", "subgenres")]
			))
		let rock = try OnboardingFixture.identity("genre:rock")
		let altRock = try OnboardingFixture.identity("genre:alt-rock")
		let grunge = try OnboardingFixture.identity("genre:grunge")

		let ancestors = taxonomy.ancestors(ofLevelThree: grunge)
		XCTAssertEqual(ancestors?.parent, rock)
		XCTAssertEqual(ancestors?.subgenre, altRock)
		XCTAssertNil(taxonomy.ancestors(ofLevelThree: altRock))
		XCTAssertNil(taxonomy.ancestors(ofLevelThree: rock))
	}
}

enum OnboardingFixture {
	static func identity(_ rawValue: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: rawValue))
	}

	static func catalog(
		nodes: [(String, String)],
		edges: [(String, String, String)],
		teasers: [String: String] = [:]
	) throws -> Catalog {
		let payload: [String: Any] = [
			"version": "v1", "revision": "sha256:" + String(repeating: "0123456789abcdef", count: 4),
			"taxonomy": ["mode": "degraded", "available": true],
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

	/// Hip-Hop (3 subgenres), Jazz (2, one through each edge direction), Ambient (none) and an A <-> B cycle.
	static func catalog() throws -> Catalog {
		try catalog(
			nodes: [
				("genre:jazz", "Jazz"), ("genre:hip-hop", "Hip-Hop"), ("genre:ambient", "Ambient"),
				("genre:trap", "Trap"), ("genre:boom-bap", "Boom bap"), ("genre:drill", "Drill"),
				("genre:bebop", "Bebop"), ("genre:cool-jazz", "Cool jazz"),
				("genre:cycle-a", "Cycle A"), ("genre:cycle-b", "Cycle B"),
				("artist:miles-davis", "Miles Davis"),
			],
			edges: [
				("genre:hip-hop", "genre:trap", "subgenres"),
				("genre:hip-hop", "genre:boom-bap", "subgenres"),
				("genre:hip-hop", "genre:drill", "subgenres"),
				("genre:jazz", "genre:bebop", "subgenres"),
				("genre:jazz", "genre:bebop", "subgenres"),
				("genre:cool-jazz", "genre:jazz", "parent_genres"),
				("genre:jazz", "genre:jazz", "subgenres"),
				("genre:jazz", "artist:miles-davis", "subgenres"),
				("genre:jazz", "genre:missing", "subgenres"),
				("genre:cycle-a", "genre:cycle-b", "subgenres"),
				("genre:cycle-b", "genre:cycle-a", "subgenres"),
				("genre:cycle-a", "genre:cycle-b", "parent_genres"),
				("genre:ambient", "genre:hip-hop", "related_genres"),
			],
			teasers: ["genre:boom-bap": "Rap sampled from soul and jazz records."]
		)
	}
}
