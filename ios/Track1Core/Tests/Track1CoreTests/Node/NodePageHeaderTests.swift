import XCTest

@testable import Track1Core

final class NodePageHeaderTests: XCTestCase {
	// MARK: - Subtitle

	func testSubtitlesOfCompleteNodesOfEachType() throws {
		let cases: [(NodeType, [String: String], [String: String], String)] = [
			(
				.project, ["year": "2015", "release_type": "album"],
				["artists": Self.list(.artist, "Kendrick Lamar")], "Kendrick Lamar · Album · 2015"
			),
			(
				.track, ["year": "2015", "duration": "261"],
				[
					"artists": Self.list(.artist, "Kendrick Lamar"),
					"project": Self.object(.project, "To Pimp a Butterfly"),
				],
				"Kendrick Lamar · To Pimp a Butterfly · 4:21 · 2015"
			),
			(
				.artist, ["origin": "Compton, California", "active_years": "2003–present"], [:],
				"Compton, California · 2003–present"
			),
			(.genre, ["era": "1970s", "origin": "Bronx, New York"], [:], "1970s · Bronx, New York"),
			(.label, ["founded": "1996", "location": "Los Angeles"], [:], "Founded 1996 · Los Angeles"),
		]
		for (type, facts, edges, expected) in cases {
			let header = try Self.header(type, facts, edges)

			XCTAssertEqual(header.subtitle, expected, type.rawValue)
		}
	}

	func testPartialNodesOmitAbsentSegments() throws {
		let artists = ["artists": Self.list(.artist, "Kendrick Lamar", "SZA")]

		XCTAssertEqual(try Self.header(.project, ["year": "2015"], artists).subtitle, "Kendrick Lamar, SZA · 2015")
		XCTAssertEqual(
			try Self.header(.project, ["release_type": "ep"], artists).subtitle, "Kendrick Lamar, SZA · EP")
		XCTAssertEqual(try Self.header(.project, ["release_type": "single"], [:]).subtitle, "Single")
		XCTAssertEqual(try Self.header(.track, ["year": "2015"], [:]).subtitle, "2015")
		XCTAssertEqual(try Self.header(.artist, ["active_years": "1990–2001"], [:]).subtitle, "1990–2001")
		XCTAssertEqual(try Self.header(.genre, ["origin": "Detroit"], [:]).subtitle, "Detroit")
		XCTAssertEqual(try Self.header(.label, ["location": "London"], [:]).subtitle, "London")
		XCTAssertEqual(try Self.header(.label, ["founded": "1996"], [:]).subtitle, "Founded 1996")
	}

	func testNodesWithoutAnyFieldHaveNoSubtitleTeaserOrFact() throws {
		for type in NodeType.allCases {
			let header = try Self.header(type, [:], [:])

			XCTAssertNil(header.subtitle, type.rawValue)
			XCTAssertNil(header.teaser, type.rawValue)
			XCTAssertEqual(header.facts, [], type.rawValue)
		}
	}

	func testAMissingOrUnknownReleaseTypeIsOmitted() throws {
		let artists = ["artists": Self.list(.artist, "Kendrick Lamar")]

		XCTAssertEqual(try Self.header(.project, ["year": "2015"], artists).subtitle, "Kendrick Lamar · 2015")
		XCTAssertEqual(
			try Self.header(.project, ["release_type": "mixtape", "year": "2015"], artists).subtitle,
			"Kendrick Lamar · 2015", "Only the three values of the schema are shown.")
	}

	func testBlankFactsAreOmittedFromTheSubtitle() throws {
		let header = try Self.header(.artist, ["origin": "  ", "active_years": " 1990–2001 "], [:])

		XCTAssertEqual(header.subtitle, "1990–2001")
	}

	func testNetworkTextFitsOneLineAndCannotReorderItsNeighbours() throws {
		let header = try Self.header(
			.artist, ["origin": "Compton,\n California", "active_years": "\u{202E}2003\u{202C}–present"], [:],
			teaser: "First line\nsecond\u{2066} line")

		XCTAssertEqual(header.subtitle, "Compton, California · 2003–present")
		XCTAssertEqual(header.teaser, "First line second line")
	}

	func testATrackReadsItsAlbumFromTheProjectEdge() throws {
		let header = try Self.header(.track, [:], ["project": Self.object(.project, "Kid A")])

		XCTAssertEqual(header.subtitle, "Kid A")
	}

	func testAnEdgeSentAsAnObjectOrAListGivesTheSameNames() throws {
		let object = try Self.header(.project, [:], ["artists": Self.object(.artist, "Radiohead")])
		let list = try Self.header(.project, [:], ["artists": Self.list(.artist, "Radiohead")])

		XCTAssertEqual(object.subtitle, "Radiohead")
		XCTAssertEqual(object, list)
	}

	// MARK: - Duration

	func testDurationIsShownAsMinutesAndSeconds() throws {
		let cases = [
			"261": "4:21", "4:21": "4:21", "0": "0:00", "59": "0:59", "60": "1:00", "3600": "60:00",
			"1:02:03": "1:02:03", " 261 ": "4:21",
			"9999999999999": "166666666666:39",
		]
		for (duration, expected) in cases {
			let header = try Self.header(.track, ["duration": duration], [:])

			XCTAssertEqual(header.subtitle, expected, duration)
		}
	}

	func testAnUnreadableDurationIsOmitted() throws {
		for duration in ["abc", "4:75", "-5", "+5", "4:", ":21", "4.5", "99999999999999999999", "4:21 min"] {
			let header = try Self.header(.track, ["duration": duration, "year": "2015"], [:])

			XCTAssertEqual(header.subtitle, "2015", duration)
		}
		XCTAssertNil(try Self.header(.track, ["duration": "abc"], [:]).subtitle)
	}

	func testDurationIsOnlyASubtitleSegmentOfATrack() throws {
		XCTAssertNil(try Self.header(.project, ["duration": "261"], [:]).subtitle)
		XCTAssertEqual(try Self.header(.track, ["duration": "261"], [:]).facts, [], "Subtitle only, never a fact.")
	}

	// MARK: - Teaser

	func testTeaserDropsInlineMarkdown() throws {
		let cases = [
			"*Cosmogramma* is": "Cosmogramma is",
			"**Bold** move": "Bold move",
			"An _italic_ word": "An italic word",
			"A `code` span": "A code span",
			"A [link](https://example.com/page) here": "A link here",
			"__Strong__ too": "Strong too",
			"[*Cosmogramma*](https://example.com) is": "Cosmogramma is",
			"**Bold and *nested* text**": "Bold and nested text",
			"Plain text stays": "Plain text stays",
			"See [Nirvana](https://en.wikipedia.org/wiki/Nirvana_(band)) now": "See Nirvana now",
			"![cover](https://example.com/a.jpg) text": "cover text",
		]
		for (source, expected) in cases {
			let header = try Self.header(.project, [:], [:], teaser: source)

			XCTAssertEqual(header.teaser, expected, source)
		}
	}

	func testTeaserKeepsCharactersThatAreNotMarkdown() throws {
		let cases = [
			"2 * 3 * 4": "2 * 3 * 4",
			"snake_case_name stays": "snake_case_name stays",
			"Rock & Roll (1955) [live]": "Rock & Roll (1955) [live]",
			"Trailing *": "Trailing *",
			"5*3 and 4*2": "5*3 and 4*2",
		]
		for (source, expected) in cases {
			XCTAssertEqual(try Self.header(.genre, [:], [:], teaser: source).teaser, expected, source)
		}
	}

	func testALinkLabelIsKeptAndItsTargetNeverAppears() throws {
		let header = try Self.header(.artist, [:], [:], teaser: "See [the site](https://evil.example/x?a=1) now")

		XCTAssertEqual(header.teaser, "See the site now")
	}

	func testAnEmptyOrBlankTeaserIsNil() throws {
		for teaser in ["", "   ", "\n", "[](https://example.com)"] {
			XCTAssertNil(try Self.header(.project, [:], [:], teaser: teaser).teaser, teaser)
		}
		XCTAssertNil(try Self.header(.project, [:], [:], teaser: nil).teaser)
	}

	// MARK: - Facts

	func testAnArtistHasNoFacts() throws {
		let facts = ["origin": "Compton", "active_years": "2003–present", "bpm": "96", "sonic_markers": "x"]

		XCTAssertEqual(try Self.header(.artist, facts, [:]).facts, [])
	}

	func testProjectAndTrackFactsFollowTheContractOrder() throws {
		let facts = [
			"inspirations": "Funk", "samples_notes": "Flying Lotus", "vocals": "Female", "musical_key": "A minor",
			"bpm": "96", "year": "2015", "release_type": "album", "duration": "261",
		]
		let expected = [
			NodeFact(label: "BPM", value: "96"), NodeFact(label: "KEY", value: "A minor"),
			NodeFact(label: "VOCALS", value: "Female"), NodeFact(label: "SAMPLES", value: "Flying Lotus"),
			NodeFact(label: "INSPIRATIONS", value: "Funk"),
		]

		XCTAssertEqual(try Self.header(.project, facts, [:]).facts, expected)
		XCTAssertEqual(try Self.header(.track, facts, [:]).facts, expected)
	}

	func testAProjectWithoutOptionalFieldsHasNoFacts() throws {
		let header = try Self.header(
			.project, ["year": "2015", "release_type": "album", "cover_url": "https://x.test/c.jpg"], [:])

		XCTAssertEqual(header.facts, [])
	}

	func testOnlyPresentFieldsBecomeFacts() throws {
		let header = try Self.header(.project, ["bpm": "96", "vocals": "  ", "inspirations": "Funk"], [:])

		XCTAssertEqual(
			header.facts, [NodeFact(label: "BPM", value: "96"), NodeFact(label: "INSPIRATIONS", value: "Funk")])
	}

	func testGenreAndLabelFacts() throws {
		let genre = try Self.header(.genre, ["sonic_markers": "Breakbeats, sampling", "era": "1970s"], [:])
		let label = try Self.header(
			.label, ["active_years": "1996–present", "founders": "Dr. Dre", "location": "LA", "founded": "1996"], [:])

		XCTAssertEqual(genre.facts, [NodeFact(label: "SONIC MARKERS", value: "Breakbeats, sampling")])
		XCTAssertEqual(
			label.facts,
			[NodeFact(label: "FOUNDERS", value: "Dr. Dre"), NodeFact(label: "ACTIVE", value: "1996–present")])
	}

	// MARK: - Title and untouched fields

	func testTheTitleIsTheNodeName() throws {
		XCTAssertEqual(try Self.header(.artist, [:], [:]).title, "Sample")
	}

	func testTheHeaderDoesNotDependOnTheArticleOrTheMaterializationDate() throws {
		let facts = ["year": "2015"]
		let first = try Self.node(.project, facts: facts, edges: [:], article: "One", date: "2026-10-08T00:00:00Z")
		let second = try Self.node(.project, facts: facts, edges: [:], article: "Two", date: "2025-01-01T00:00:00Z")

		XCTAssertEqual(NodePageHeader(node: first), NodePageHeader(node: second))
	}

	// MARK: - Fixtures

	private static func header(
		_ type: NodeType, _ facts: [String: String], _ edges: [String: String], teaser: String? = nil
	) throws -> NodePageHeader {
		NodePageHeader(node: try node(type, facts: facts, edges: edges, teaser: teaser))
	}

	private static func object(_ type: NodeType, _ name: String) -> String {
		let kind = type.rawValue
		return #"{"slug":"\#(kind):sample-\#(kind)","type":"\#(kind)","name":\#(quoted(name))}"#
	}

	private static func list(_ type: NodeType, _ names: String...) -> String {
		let kind = type.rawValue
		let items = names.enumerated().map {
			#"{"slug":"\#(kind):sample-\#(kind)-\#($0.offset)","type":"\#(kind)","name":\#(quoted($0.element))}"#
		}
		return "[" + items.joined(separator: ",") + "]"
	}

	private static func quoted(_ text: String) -> String {
		String(decoding: (try? JSONEncoder().encode(text)) ?? Data(), as: UTF8.self)
	}

	/// A `NodeDetail` decoded from the JSON the API sends, so fixtures cannot drift from the real shape.
	private static func node(
		_ type: NodeType, facts: [String: String], edges: [String: String], teaser: String? = nil,
		article: String = "Article", date: String = "2026-10-08T00:00:00Z"
	) throws -> NodeDetail {
		let factsJSON = String(decoding: try JSONEncoder().encode(facts), as: UTF8.self)
		let edgesJSON = edges.map { #""\#($0.key)":\#($0.value)"# }.joined(separator: ",")
		let source = """
			{"id":"\(type.rawValue):sample-node","type":"\(type.rawValue)","name":"Sample","teaser":\(teaser.map(quoted) ?? "null"),"article":\(quoted(article)),"citations":[],"facts":\(factsJSON),"edges":{\(edgesJSON)},"materialized_at":"\(date)","image_url":null}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
	}
}
