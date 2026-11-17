import XCTest

@testable import Track1Core

final class TodayHomeTests: XCTestCase {
	// MARK: - Date

	func testLateEveningUTCIsTheNextDayInParis() throws {
		let date = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-31T23:30:00Z"))
		let paris = try XCTUnwrap(TimeZone(identifier: "Europe/Paris"))

		let home = TodayHome(node: try Self.node(), date: date, timeZone: paris)

		XCTAssertEqual(home.day, "1")
		XCTAssertEqual(home.month, "NOV")
	}

	func testTheSameInstantKeepsItsDayInUTC() throws {
		let date = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-31T23:30:00Z"))

		let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
		let home = TodayHome(node: try Self.node(), date: date, timeZone: utc)

		XCTAssertEqual(home.day, "31")
		XCTAssertEqual(home.month, "OCT")
	}

	func testTheDayHasNoLeadingZero() throws {
		let date = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-03-03T12:00:00Z"))

		let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
		let home = TodayHome(node: try Self.node(), date: date, timeZone: utc)

		XCTAssertEqual(home.day, "3")
	}

	func testTwelveMonthsRenderTheFixedFrenchAbbreviations() throws {
		let expected = ["JAN", "FÉV", "MAR", "AVR", "MAI", "JUN", "JUL", "AOÛ", "SEP", "OCT", "NOV", "DÉC"]
		let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
		let node = try Self.node()

		for (index, abbreviation) in expected.enumerated() {
			let month = String(format: "%02d", index + 1)
			let date = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-\(month)-15T12:00:00Z"))

			XCTAssertEqual(TodayHome(node: node, date: date, timeZone: utc).month, abbreviation, month)
		}
	}

	// MARK: - Genres

	func testMoreThanThreeGenresAreCutToThreeInOrder() throws {
		let node = try Self.node(edges: ["genres": Self.list(.genre, "Jazz", "Hip hop", "IDM", "Ambient", "Funk")])

		XCTAssertEqual(Self.home(node).genres, ["Jazz", "Hip hop", "IDM"])
	}

	/// `NodeEdge` already refuses a literally empty name, so "empty" here is what is left once cleaned.
	func testEmptyAndDuplicateGenreNamesAreDropped() throws {
		let node = try Self.node(
			edges: ["genres": Self.list(.genre, "Jazz", " ", "  \n ", "Jazz", "IDM", "Ambient", "Funk")]
		)

		XCTAssertEqual(Self.home(node).genres, ["Jazz", "IDM", "Ambient"])
	}

	func testGenresThatBecomeEqualOnceCleanedAreDeduplicated() throws {
		let node = try Self.node(edges: ["genres": Self.list(.genre, "Hip\u{202E} hop", "Hip\nhop", "Funk")])

		XCTAssertEqual(Self.home(node).genres, ["Hip hop", "Funk"])
	}

	func testNoGenreEdgeGivesNoGenres() throws {
		XCTAssertEqual(Self.home(try Self.node()).genres, [])
		XCTAssertEqual(Self.home(try Self.node(edges: ["genres": "[]"])).genres, [])
	}

	func testASingleGenreObjectIsRead() throws {
		let node = try Self.node(edges: ["genres": Self.object(.genre, "Jazz")])

		XCTAssertEqual(Self.home(node).genres, ["Jazz"])
	}

	// MARK: - Subtitle

	func testSubtitleHasArtistsThenYear() throws {
		let node = try Self.node(facts: ["year": "2010"], edges: ["artists": Self.list(.artist, "Flying Lotus")])

		XCTAssertEqual(Self.home(node).subtitle, "Flying Lotus · 2010")
	}

	func testSubtitleWithoutYearIsTheArtistsOnly() throws {
		let node = try Self.node(edges: ["artists": Self.list(.artist, "Flying Lotus")])

		XCTAssertEqual(Self.home(node).subtitle, "Flying Lotus")
	}

	func testSubtitleJoinsSeveralArtistsWithACommaAndKeepsTheirOrder() throws {
		let artists = Self.list(.artist, "Kendrick Lamar", "SZA")
		let node = try Self.node(facts: ["year": "2015"], edges: ["artists": artists])

		XCTAssertEqual(Self.home(node).subtitle, "Kendrick Lamar, SZA · 2015")
	}

	func testSubtitleWithoutArtistIsTheYearOnly() throws {
		XCTAssertEqual(Self.home(try Self.node(facts: ["year": "2010"])).subtitle, "2010")
	}

	func testSubtitleIsNilWithoutArtistAndYear() throws {
		XCTAssertNil(Self.home(try Self.node()).subtitle)
		let blank = try Self.node(facts: ["year": " \n "], edges: ["artists": Self.list(.artist, " ")])

		XCTAssertNil(Self.home(blank).subtitle)
	}

	// MARK: - Type and title

	func testTheTypeIsTheNodeType() throws {
		XCTAssertEqual(Self.home(try Self.node(type: .project)).type, .project)
		XCTAssertEqual(Self.home(try Self.node(type: .track)).type, .track)
	}

	func testTheTitleIsTheNodeName() throws {
		XCTAssertEqual(Self.home(try Self.node(name: "Cosmogramma")).title, "Cosmogramma")
	}

	// MARK: - Cleaning

	func testNetworkStringsAreCleanedLikeTheNodePageHeader() throws {
		let dirty = "Flying\u{202E}\n\tLotus"
		let node = try Self.node(
			type: .track, name: dirty, facts: ["year": "20\u{202E}10"],
			edges: ["artists": Self.list(.artist, dirty), "genres": Self.list(.genre, dirty)]
		)

		let home = Self.home(node)

		XCTAssertEqual(home.title, "Flying Lotus")
		XCTAssertEqual(home.genres, ["Flying Lotus"])
		XCTAssertEqual(home.subtitle, "Flying Lotus · 2010")
	}

	// MARK: - Fixtures

	private static func home(_ node: NodeDetail) -> TodayHome {
		let utc = TimeZone(identifier: "UTC") ?? .current
		return TodayHome(node: node, date: Date(timeIntervalSince1970: 0), timeZone: utc)
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
		type: NodeType = .project, name: String = "Sample", facts: [String: String] = [:],
		edges: [String: String] = [:]
	) throws -> NodeDetail {
		let factsJSON = String(decoding: try JSONEncoder().encode(facts), as: UTF8.self)
		let edgesJSON = edges.map { #""\#($0.key)":\#($0.value)"# }.joined(separator: ",")
		let source = """
			{"id":"\(type.rawValue):sample-node","type":"\(type.rawValue)","name":\(quoted(name)),"teaser":null,"article":"Article","citations":[],"facts":\(factsJSON),"edges":{\(edgesJSON)},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
	}
}
