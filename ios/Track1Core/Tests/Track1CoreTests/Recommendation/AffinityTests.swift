import Foundation
import XCTest

@testable import Track1Core

final class AffinityTests: XCTestCase {
	private struct Node {
		let identity: String
		let name: String
		var teaser: String?

		init(_ identity: String, _ name: String, teaser: String? = nil) {
			self.identity = identity
			self.name = name
			self.teaser = teaser
		}

		var type: String { String(identity.prefix { $0 != ":" }) }
	}

	private struct Edge {
		let source: String
		let target: String
		let type: String

		init(_ source: String, _ target: String, _ type: String) {
			self.source = source
			self.target = target
			self.type = type
		}
	}

	private let revision = "sha256:" + String(repeating: "0123456789abcdef", count: 4)

	private func catalog(_ nodes: [Node], _ edges: [Edge]) throws -> Catalog {
		let nodesJSON = nodes.map { node -> [String: Any] in
			[
				"identity": node.identity, "type": node.type, "name": node.name,
				"teaser": node.teaser ?? NSNull(),
			]
		}
		let edgesJSON = edges.map { ["source": $0.source, "target": $0.target, "type": $0.type] }
		let payload: [String: Any] = [
			"version": "v1", "revision": revision, "taxonomy": ["mode": "degraded", "available": true],
			"nodes": nodesJSON, "edges": edgesJSON,
		]
		let data = try JSONSerialization.data(withJSONObject: payload)
		return try JSONDecoder().decode(Catalog.self, from: data)
	}

	private func identity(_ rawValue: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: rawValue))
	}

	private func rank(_ catalog: Catalog, _ genres: [String]) throws -> [AffinityCandidate] {
		Affinity.rank(catalog: catalog, genreIDs: try genres.map(identity))
	}

	// A `key_artists` edge toward a project does not occur in real data: it only pins that the weights and
	// the reasons of the candidates that remain are unchanged by TRA-713.
	func testScoresDirectNearbyAndCuratedContributionsOnceAndExcludesGenresAndLabels() throws {
		let catalog = try catalog(
			[
				Node("genre:electronic", "Électronique"),
				Node("genre:ambient", "Ambient"),
				Node("project:one", "One", teaser: "Un teaser"),
				Node("project:two", "Two"),
				Node("label:three", "Three"),
			],
			[
				Edge("genre:electronic", "genre:ambient", "related_genres"),
				Edge("project:one", "genre:electronic", "genres"),
				Edge("project:one", "genre:electronic", "genres"),
				Edge("project:one", "genre:ambient", "genres"),
				Edge("genre:electronic", "project:one", "key_artists"),
				Edge("genre:electronic", "project:one", "key_artists"),
				Edge("genre:electronic", "project:two", "landmark_projects"),
				Edge("genre:electronic", "label:three", "landmark_projects"),
			])

		let result = try rank(catalog, ["genre:electronic"])

		XCTAssertEqual(
			result,
			[
				AffinityCandidate(
					identity: try identity("project:one"), type: .project, name: "One",
					teaser: "Un teaser", score: 7,
					reasons: ["Artiste clé d’Électronique", "Lié à Électronique", "Proche de Électronique"]),
				AffinityCandidate(
					identity: try identity("project:two"), type: .project, name: "Two", teaser: nil, score: 4,
					reasons: ["Projet repère d’Électronique"]),
			])
	}

	// TRA-713: the best-scoring node is an artist, yet it must not appear in the ranking.
	func testNeverRanksAnArtistEvenWhenItHasTheBestScore() throws {
		let catalog = try catalog(
			[
				Node("genre:ambient", "Ambient"),
				Node("artist:star", "Star"),
				Node("project:work", "Work"),
				Node("track:song", "Song"),
			],
			[
				Edge("genre:ambient", "artist:star", "key_artists"),
				Edge("artist:star", "genre:ambient", "genres"),
				Edge("genre:ambient", "project:work", "landmark_projects"),
				Edge("track:song", "genre:ambient", "genres"),
			])

		let result = try rank(catalog, ["genre:ambient"])

		// The artist would have scored 6, ahead of the project (4) and the track (3).
		XCTAssertEqual(result.map(\.score), [4, 3])
		XCTAssertEqual(result.map(\.type), [.project, .track])
		XCTAssertEqual(result.map(\.identity.rawValue), ["project:work", "track:song"])
		XCTAssertFalse(result.contains { $0.type == .artist })
	}

	func testGenresLinkedOnlyToArtistsRankNothing() throws {
		let catalog = try catalog(
			[Node("genre:ambient", "Ambient"), Node("artist:one", "One"), Node("artist:two", "Two")],
			[
				Edge("artist:one", "genre:ambient", "genres"),
				Edge("genre:ambient", "artist:two", "key_artists"),
			])

		XCTAssertEqual(try rank(catalog, ["genre:ambient"]), [])
	}

	func testLandmarkTracksWeighFourAndDuplicateSelectionsCountOnce() throws {
		let catalog = try catalog(
			[Node("genre:ambient", "Ambient"), Node("track:drift", "Drift")],
			[Edge("genre:ambient", "track:drift", "landmark_tracks")])

		let result = try rank(catalog, ["genre:ambient", "genre:ambient"])

		XCTAssertEqual(result.map(\.score), [4])
		XCTAssertEqual(result.first?.type, .track)
		XCTAssertEqual(result.first?.reasons, ["Morceau repère d’Ambient"])
	}

	func testNearbyCountsOncePerSelectedRelationAndTargetTriplet() throws {
		let catalog = try catalog(
			[
				Node("genre:electronic", "Électronique"),
				Node("genre:funk", "Funk"),
				Node("genre:house", "House"),
				Node("project:one", "One"),
			],
			[
				Edge("genre:electronic", "genre:house", "related_genres"),
				Edge("genre:electronic", "genre:house", "related_genres"),
				Edge("genre:electronic", "genre:house", "subgenres"),
				Edge("genre:funk", "genre:house", "related_genres"),
				Edge("project:one", "genre:house", "genres"),
			])

		let result = try rank(catalog, ["genre:electronic", "genre:funk"])

		XCTAssertEqual(result.map(\.score), [3])
		// "Électronique" collates before "Funk" in French although its code point is higher.
		XCTAssertEqual(result.first?.reasons, ["Proche de Électronique", "Proche de Funk"])
	}

	func testNearbyOnlyFollowsEdgesLeavingASelectedGenre() throws {
		let catalog = try catalog(
			[
				Node("genre:ambient", "Ambient"),
				Node("genre:drone", "Drone"),
				Node("genre:house", "House"),
				Node("project:one", "One"),
				Node("project:two", "Two"),
			],
			[
				Edge("genre:house", "genre:ambient", "related_genres"),
				Edge("genre:ambient", "genre:drone", "genres"),
				Edge("project:one", "genre:ambient", "related_genres"),
				Edge("project:two", "genre:house", "genres"),
			])

		XCTAssertEqual(try rank(catalog, ["genre:ambient"]), [])
	}

	func testIgnoresUnknownNonGenreAndNonRecommendableIdentities() throws {
		let catalog = try catalog(
			[
				Node("genre:ambient", "Ambient"),
				Node("genre:drone", "Drone"),
				Node("project:one", "One"),
				Node("project:other", "Other"),
				Node("label:ghostly", "Ghostly"),
			],
			[
				Edge("project:ghost", "genre:ambient", "genres"),
				Edge("genre:ambient", "project:ghost", "key_artists"),
				Edge("genre:ambient", "genre:drone", "landmark_projects"),
				Edge("genre:ambient", "genre:unknown", "related_genres"),
				Edge("genre:ambient", "project:other", "subgenres"),
				Edge("project:one", "project:other", "genres"),
				Edge("project:one", "genre:missing", "genres"),
				Edge("label:ghostly", "genre:ambient", "genres"),
				Edge("genre:ambient", "label:ghostly", "key_artists"),
				Edge("genre:ambient", "project:one", "unrelated_edge"),
			])

		// Unknown and non-genre selections are dropped, so only "genre:ambient" contributes.
		let result = try rank(catalog, ["genre:unknown", "project:one", "label:ghostly", "genre:ambient"])

		XCTAssertEqual(result, [])
	}

	func testEmptySelectionReturnsNoCandidate() throws {
		let catalog = try catalog(
			[Node("genre:ambient", "Ambient"), Node("project:one", "One")],
			[Edge("project:one", "genre:ambient", "genres")])

		XCTAssertEqual(try rank(catalog, []), [])
		XCTAssertEqual(try rank(catalog, ["project:one", "genre:unknown"]), [])
	}

	func testOrdersTiesByIdentityAndKeepsTheTopSixty() throws {
		let works = (0..<61).map { index in
			Node("project:\(String(format: "%02d", 61 - index))", "A \(index)")
		}
		let catalog = try catalog(
			[Node("genre:ambient", "Ambient")] + works,
			works.map { Edge($0.identity, "genre:ambient", "genres") })

		let ranked = try rank(catalog, ["genre:ambient"])

		XCTAssertEqual(ranked.count, 60)
		XCTAssertEqual(ranked.first?.identity.rawValue, "project:01")
		XCTAssertEqual(ranked.last?.identity.rawValue, "project:60")
	}

	func testHigherScoresPrecedeIdentityOrderBeforeTruncation() throws {
		let works = (1...60).map { Node("project:a\(String(format: "%02d", $0))", "A \($0)") }
		let strong = Node("project:z-strong", "Strong")
		let catalog = try catalog(
			[Node("genre:ambient", "Ambient"), strong] + works,
			(works + [strong]).map { Edge($0.identity, "genre:ambient", "genres") }
				+ [Edge("genre:ambient", strong.identity, "key_artists")])

		let ranked = try rank(catalog, ["genre:ambient"])

		XCTAssertEqual(ranked.count, 60)
		XCTAssertEqual(ranked.first?.identity.rawValue, "project:z-strong")
		XCTAssertEqual(ranked.first?.score, 6)
		XCTAssertEqual(ranked.last?.identity.rawValue, "project:a59")
	}
}
