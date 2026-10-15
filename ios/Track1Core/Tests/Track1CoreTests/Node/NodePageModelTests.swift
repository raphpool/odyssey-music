import XCTest

@testable import Track1Core

final class NodePageModelTests: XCTestCase {
	/// Every edge field of every type with the type it points to, listed in the order of `EDGE_FIELDS_BY_TYPE`.
	/// The order matters only to a human: JSON objects have no order, so the model cannot read it from the payload.
	private static let schema: [NodeType: [(field: String, target: NodeType)]] = [
		.genre: [
			("parent_genres", .genre), ("subgenres", .genre), ("related_genres", .genre),
			("key_artists", .artist), ("key_labels", .label), ("landmark_projects", .project),
			("landmark_tracks", .track),
		],
		.label: [("genres", .genre), ("roster", .artist), ("notable_releases", .project)],
		.artist: [
			("genres", .genre), ("labels", .label), ("discography", .project), ("notable_tracks", .track),
			("landmark_project", .project), ("reference_track", .track),
			("influences", .artist), ("influenced", .artist), ("collaborators", .artist), ("aliases", .artist),
			("members", .artist), ("similar_artists", .artist),
		],
		.project: [
			("artists", .artist), ("label", .label), ("genres", .genre), ("tracklist", .track),
			("producers", .artist), ("personnel", .artist), ("related_projects", .project),
		],
		.track: [
			("artists", .artist), ("project", .project), ("label", .label), ("genres", .genre),
			("producers", .artist), ("personnel", .artist), ("samples", .track), ("sampled_by", .track),
			("remix_of", .track), ("remixed_by", .track),
		],
	]

	private static let singleFields: [NodeType: Set<String>] = [
		.artist: ["landmark_project", "reference_track"], .project: ["label"],
		.track: ["project", "label", "remix_of"],
	]

	func testSectionsFollowTheSchemaOrderForACompleteNodeOfEachType() throws {
		for type in NodeType.allCases {
			let fields = try XCTUnwrap(Self.schema[type])
			let node = try Self.node(type: type, edges: Self.edges(for: type, count: 2))

			let sections = NodePageModel.sections(for: node)

			XCTAssertEqual(sections.map(\.field), fields.map(\.field), "\(type.rawValue)")
			XCTAssertEqual(sections.map(\.field), NodePageSpec.sectionOrder[type], "\(type.rawValue)")
		}
	}

	func testAnArtistShowsInfluencesBeforeCollaboratorsWhateverTheScreenDraws() throws {
		let node = try Self.node(type: .artist, edges: Self.edges(for: .artist, count: 1))

		let fields = NodePageModel.sections(for: node).map(\.field)

		let influences = try XCTUnwrap(fields.firstIndex(of: "influences"))
		XCTAssertLessThan(influences, try XCTUnwrap(fields.firstIndex(of: "collaborators")))
	}

	func testAnEmptyOrAbsentEdgeProducesNoSection() throws {
		let artist = try Self.node(
			type: .artist,
			edges: [
				"genres": Self.json(.genre, count: 0),
				"aliases": Self.json(.artist, count: 1),
				"members": Self.json(.artist, count: 0),
			]
		)
		let track = try Self.node(
			type: .track,
			edges: ["remix_of": "[]", "label": Self.json(.label, count: 1)]
		)

		XCTAssertEqual(NodePageModel.sections(for: artist).map(\.field), ["aliases"])
		XCTAssertEqual(NodePageModel.sections(for: track).map(\.field), ["label"])
		XCTAssertEqual(NodePageModel.sections(for: try Self.node(type: .genre, edges: [:])), [])
	}

	func testAFieldOutsideTheSchemaProducesNoSection() throws {
		let node = try Self.node(
			type: .artist,
			edges: ["genres": Self.json(.genre, count: 1), "label": Self.json(.label, count: 1)]
		)

		XCTAssertEqual(NodePageModel.sections(for: node).map(\.field), ["genres"])
	}

	func testSingleEdgesHaveOneEdgeAndNoCount() throws {
		for (type, fields) in Self.singleFields {
			let node = try Self.node(type: type, edges: Self.edges(for: type, count: 3))
			let sections = NodePageModel.sections(for: node)

			for field in fields {
				let section = try XCTUnwrap(sections.first { $0.field == field }, "\(type.rawValue).\(field)")
				XCTAssertEqual(section.presentation, .single)
				XCTAssertFalse(section.showsCount)
				XCTAssertEqual(section.edges.count, 1)
				XCTAssertEqual(section.totalCount, 1)
			}
			for section in sections where !fields.contains(section.field) {
				XCTAssertNotEqual(section.presentation, .single, "\(type.rawValue).\(section.field)")
				XCTAssertTrue(section.showsCount, "\(type.rawValue).\(section.field)")
			}
		}
	}

	func testASingleEdgeKeepsTheFirstEdgeIfTheServerSendsAList() throws {
		let node = try Self.node(
			type: .project,
			edges: ["label": Self.json(.label, count: 3), "genres": Self.object(.genre, 1)]
		)

		let sections = NodePageModel.sections(for: node)

		XCTAssertEqual(sections.first?.edges.map(\.name), ["Label 1"])
		XCTAssertEqual(sections.last?.field, "genres")
		XCTAssertEqual(sections.last?.edges.count, 1, "A lone object under a list field is a list of one.")
	}

	func testAGenreWithTenSubgenresKeepsAllTenAndTheirTotal() throws {
		let node = try Self.node(type: .genre, edges: ["subgenres": Self.json(.genre, count: 10)])

		let section = try XCTUnwrap(NodePageModel.sections(for: node).first)

		XCTAssertEqual(section.field, "subgenres")
		XCTAssertEqual(section.presentation, .chips)
		XCTAssertEqual(section.totalCount, 10)
		XCTAssertEqual(section.edges.count, 10)
		XCTAssertGreaterThan(section.totalCount, NodePageSpec.chipLimit, "The view applies the limit.")
		XCTAssertTrue(section.showsCount)
	}

	func testCarouselFieldsAreTheProjectEntryPointsOfFourTypes() throws {
		let expected: [NodeType: String] = [
			.artist: "discography", .label: "notable_releases", .genre: "landmark_projects",
			.project: "related_projects",
		]
		for type in NodeType.allCases {
			let node = try Self.node(type: type, edges: Self.edges(for: type, count: 2))
			let carousels = NodePageModel.sections(for: node).filter { $0.presentation == .carousel }

			XCTAssertEqual(carousels.map(\.field), expected[type].map { [$0] } ?? [], "\(type.rawValue)")
		}
	}

	func testTheTracklistKeepsEveryTrackInArrayOrder() throws {
		let node = try Self.node(type: .project, edges: ["tracklist": Self.json(.track, count: 14)])

		let section = try XCTUnwrap(NodePageModel.sections(for: node).first)

		XCTAssertEqual(section.presentation, .trackList)
		XCTAssertEqual(section.edges.map(\.name), (1...14).map { "Track \($0)" })
		XCTAssertEqual(section.totalCount, 14)
		XCTAssertTrue(section.showsCount)
	}

	func testLabelsFollowTheDataContractTables() throws {
		let expected: [NodeType: [String]] = [
			.genre: [
				"parent genres", "subgenres", "related genres", "key artists", "key labels", "landmark albums",
				"landmark tracks",
			],
			.label: ["genres", "roster", "notable releases"],
			.artist: [
				"genres", "labels", "discography", "notable tracks", "landmark album", "reference track",
				"influences", "influenced", "collaborators", "aliases", "members", "similar artists",
			],
			.project: [
				"artist(s)", "label", "genres", "tracks", "producers", "performers", "related albums",
			],
			.track: [
				"artist(s)", "album / ep", "label", "genres", "producers", "performers", "samples", "sampled by",
				"remix of", "remixed by",
			],
		]
		for type in NodeType.allCases {
			let node = try Self.node(type: type, edges: Self.edges(for: type, count: 1))

			XCTAssertEqual(NodePageModel.sections(for: node).map(\.label), expected[type], "\(type.rawValue)")
		}
	}

	func testALabelFallsBackToTheFieldNameWithSpaces() {
		XCTAssertEqual(NodePageSpec.label(field: "some_new_field", type: .artist), "some new field")
		XCTAssertEqual(NodePageSpec.label(field: "project", type: .project), "project")
		XCTAssertEqual(NodePageSpec.label(field: "project", type: .track), "album / ep")
	}

	// MARK: - Artist highlights (TRA-471)

	func testAnArtistWithBothPicksHasHighlightsWithTheLabelsAndIdentifiersOfTheContract() throws {
		let node = try Self.node(
			type: .artist,
			edges: [
				"landmark_project": Self.object(.project, 1), "reference_track": Self.object(.track, 1),
				"discography": Self.json(.project, count: 3),
			]
		)

		let highlights = try XCTUnwrap(NodePageModel.highlights(for: node))

		XCTAssertEqual(highlights.landmarkProject?.slug.rawValue, "project:project-1")
		XCTAssertEqual(highlights.referenceTrack?.slug.rawValue, "track:track-1")
		XCTAssertEqual(highlights.entries.map(\.identifier), ["landmark-album", "reference-track"])
		XCTAssertEqual(highlights.entries.map(\.label), ["landmark album", "reference track"])
		XCTAssertEqual(highlights.entries.map(\.field), ["landmark_project", "reference_track"])
		XCTAssertEqual(highlights.entries.map(\.kind), [.landmarkAlbum, .referenceTrack])
	}

	func testAnArtistWithoutThePicksHasNoHighlights() throws {
		let bare = try Self.node(type: .artist, edges: [:])
		let emptyList = try Self.node(
			type: .artist, edges: ["landmark_project": "[]", "reference_track": "[]"])
		let other = try Self.node(type: .artist, edges: ["discography": Self.json(.project, count: 2)])

		XCTAssertNil(NodePageModel.highlights(for: bare))
		XCTAssertNil(NodePageModel.highlights(for: emptyList))
		XCTAssertNil(NodePageModel.highlights(for: other))
	}

	func testOnePickAloneIsEnoughAndTheOtherStaysNil() throws {
		let album = try XCTUnwrap(
			NodePageModel.highlights(
				for: try Self.node(type: .artist, edges: ["landmark_project": Self.object(.project, 1)])))
		let track = try XCTUnwrap(
			NodePageModel.highlights(
				for: try Self.node(type: .artist, edges: ["reference_track": Self.object(.track, 1)])))

		XCTAssertNotNil(album.landmarkProject)
		XCTAssertNil(album.referenceTrack)
		XCTAssertEqual(album.entries.map(\.identifier), ["landmark-album"])
		XCTAssertNil(track.landmarkProject)
		XCTAssertNotNil(track.referenceTrack)
		XCTAssertEqual(track.entries.map(\.identifier), ["reference-track"])
	}

	func testOnlyAnArtistHasHighlightsWhateverTheEdgesDictionaryCarries() throws {
		// The edges dictionary comes from the network: a genre carrying the artist fields still has none.
		for type in [NodeType.genre, .label, .project, .track] {
			let node = try Self.node(
				type: type,
				edges: ["landmark_project": Self.object(.project, 1), "reference_track": Self.object(.track, 1)])

			XCTAssertNil(NodePageModel.highlights(for: node), type.rawValue)
		}
	}

	func testAHighlightKeepsTheFirstEdgeIfTheServerSendsAList() throws {
		let node = try Self.node(
			type: .artist, edges: ["landmark_project": Self.json(.project, count: 3)])

		let highlights = try XCTUnwrap(NodePageModel.highlights(for: node))

		XCTAssertEqual(highlights.landmarkProject?.name, "Project 1")
	}

	// MARK: - Fixtures

	/// A full set of edges for `type`: `count` targets under every list field, one object under single fields.
	private static func edges(for type: NodeType, count: Int) -> [String: String] {
		var edges = [String: String]()
		for (field, target) in schema[type] ?? [] {
			edges[field] = singleFields[type]?.contains(field) == true ? object(target, 1) : json(target, count: count)
		}
		return edges
	}

	private static func object(_ type: NodeType, _ index: Int) -> String {
		let kind = type.rawValue
		return #"{"slug":"\#(kind):\#(kind)-\#(index)","type":"\#(kind)","name":"\#(kind.capitalized) \#(index)"}"#
	}

	private static func json(_ type: NodeType, count: Int) -> String {
		"[" + (0..<count).map { object(type, $0 + 1) }.joined(separator: ",") + "]"
	}

	private static func node(type: NodeType, edges: [String: String]) throws -> NodeDetail {
		let body = edges.map { #""\#($0.key)":\#($0.value)"# }.joined(separator: ",")
		let source = """
			{"id":"\(type.rawValue):sample-node","type":"\(type.rawValue)","name":"Sample","teaser":null,"article":"Article","citations":[],"facts":{},"edges":{\(body)},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
	}
}
