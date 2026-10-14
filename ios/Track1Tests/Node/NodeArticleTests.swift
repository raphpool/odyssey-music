import Track1Core
import XCTest

@testable import Track1

final class NodeArticleTests: XCTestCase {
	func testMarkupFromTheAPIStaysOneParagraphWithIdenticalText() {
		for markup in ["<script>alert(1)</script>", "[lien](https://evil.example)"] {
			XCTAssertEqual(NodeArticleParser.blocks(from: markup), [.paragraph(markup)])
		}
	}

	func testListPrefixesProduceListBlocks() {
		for line in ["- Item", "* Item", "• Item", "1. Item", "2) Item", "12. Item"] {
			XCTAssertEqual(NodeArticleParser.blocks(from: line), [.list(["Item"])], line)
		}
	}

	func testBlankLineSeparatesBlocks() {
		XCTAssertEqual(
			NodeArticleParser.blocks(from: "Introduction.\n\n- First\n2) Second\n\nConclusion."),
			[.paragraph("Introduction."), .list(["First", "Second"]), .paragraph("Conclusion.")]
		)
	}

	func testListEndsWhenAParagraphLineFollowsWithoutBlankLine() {
		XCTAssertEqual(
			NodeArticleParser.blocks(from: "- First\nTail"),
			[.list(["First"]), .paragraph("Tail")]
		)
	}

	func testWindowsAndClassicMacLineEndingsAreNormalized() {
		let expected: [NodeArticleBlock] = [.paragraph("One"), .list(["A", "B"])]
		XCTAssertEqual(NodeArticleParser.blocks(from: "One\r\n\r\n- A\r\n- B"), expected)
		XCTAssertEqual(NodeArticleParser.blocks(from: "One\r\r- A\r- B"), expected)
	}

	func testConsecutiveParagraphLinesAreJoinedWithASpace() {
		XCTAssertEqual(
			NodeArticleParser.blocks(from: "First line\nsecond line"),
			[.paragraph("First line second line")]
		)
	}

	func testLinesThatOnlyLookLikeListMarkersStayParagraphs() {
		let lines = [
			"*emphasis*", "-dash", "1.5 million", ". item", ") item", "²) item", "1.", "-",
			"1999. Their last album",
		]
		for line in lines {
			XCTAssertEqual(NodeArticleParser.blocks(from: line), [.paragraph(line)], line)
		}
	}

	func testEmptyOrBlankArticleHasNoBlocks() {
		XCTAssertEqual(NodeArticleParser.blocks(from: ""), [])
		XCTAssertEqual(NodeArticleParser.blocks(from: " \r\n\t\n"), [])
	}

	func testSafeCitationURLRejectsUnsafeURLs() throws {
		for value in [
			"http://example.com",
			"https://u:p@example.com",
			"https://example.com:8443",
			"https://127.0.0.1/",
			"https://localhost/",
		] {
			let url = try XCTUnwrap(URL(string: value))
			XCTAssertNil(NodeArticleView.safeCitationURL(url), value)
		}
	}

	func testSafeCitationURLAcceptsPublicHTTPS() throws {
		let url = try XCTUnwrap(URL(string: "https://example.com/a"))
		XCTAssertEqual(NodeArticleView.safeCitationURL(url), url)
	}

	// MARK: - Sources

	func testATitledCitationGivesItsTitleAndItsHost() throws {
		let citations = try Self.citations(
			#"[{"url":"https://www.example.com/a?b=1","title":"Interview with the band"}]"#)
		XCTAssertEqual(
			NodeArticleView.sourceRows(citations),
			[
				NodeSourceRow(
					title: "Interview with the band", subtitle: "www.example.com",
					url: try Self.url("https://www.example.com/a?b=1"))
			])
	}

	func testAnUntitledCitationGivesItsHostAndNoSubtitle() throws {
		let citations = try Self.citations(#"[{"url":"https://example.com/a"}]"#)
		XCTAssertEqual(
			NodeArticleView.sourceRows(citations),
			[NodeSourceRow(title: "example.com", subtitle: nil, url: try Self.url("https://example.com/a"))])
	}

	func testATitleEqualToTheHostRepeatsNothing() throws {
		let citations = try Self.citations(#"[{"url":"https://example.com/a","title":"example.com"}]"#)
		XCTAssertEqual(NodeArticleView.sourceRows(citations).map(\.subtitle), [nil])
	}

	func testATitleEqualToTheHostInAnyCaseRepeatsNothing() throws {
		let rows = NodeArticleView.sourceRows(entries: [
			(title: "example.com", url: try Self.url("https://Example.COM/a"))
		])
		XCTAssertEqual(rows.map(\.subtitle), [nil])
	}

	func testABlankTitleFallsBackToTheHost() throws {
		let citations = try Self.citations(#"[{"url":"https://example.com/a","title":"  \t "}]"#)
		let rows = NodeArticleView.sourceRows(citations)
		XCTAssertEqual(rows.map(\.title), ["example.com"])
		XCTAssertEqual(rows.map(\.subtitle), [nil])
	}

	func testThirdPartyMarkupInATitleStaysLiteral() throws {
		let citations = try Self.citations(
			#"[{"url":"https://example.com/a","title":"[click](https://evil.example)"}]"#)
		XCTAssertEqual(NodeArticleView.sourceRows(citations).map(\.title), ["[click](https://evil.example)"])
	}

	func testHTTPPrivateAndExplicitPortURLsGiveNoRow() throws {
		for value in [
			"http://example.com/a",
			"https://example.com:8443/a",
			"https://u:p@example.com/a",
			"https://127.0.0.1/a",
			"https://localhost/a",
			"https://192.168.0.10/a",
		] {
			let rows = NodeArticleView.sourceRows(entries: [(title: "Source", url: try Self.url(value))])
			XCTAssertEqual(rows, [], value)
		}
	}

	func testInvalidURLsAreDroppedAndTheValidRowsKeepTheirOrder() throws {
		let rows = NodeArticleView.sourceRows(entries: [
			(title: "First", url: try Self.url("https://first.example/a")),
			(title: "Insecure", url: try Self.url("http://insecure.example/a")),
			(title: nil, url: try Self.url("https://third.example/a")),
		])
		XCTAssertEqual(rows.map(\.title), ["First", "third.example"])
	}

	// MARK: - Sections

	func testAnEmptyOrBlankArticleGivesNoArticleSection() throws {
		let citations = try Self.citations(#"[{"url":"https://example.com/a"}]"#)
		for article in ["", " \r\n\t\n"] {
			let sections = NodeArticleView.sections(article: article, citations: citations)
			XCTAssertEqual(sections.map(\.kind), [.sources], article)
		}
	}

	func testZeroValidSourcesGiveNoSourcesSection() throws {
		XCTAssertEqual(NodeArticleView.sections(article: "Text", citations: []).map(\.kind), [.article])
		let rows = NodeArticleView.sourceRows(entries: [
			(title: "Source", url: try Self.url("http://example.com/a"))
		])
		XCTAssertEqual(NodeArticleView.sections(article: "Text", sources: rows).map(\.kind), [.article])
	}

	func testNothingToShowGivesNoSectionAtAll() {
		XCTAssertEqual(NodeArticleView.sections(article: "", citations: []), [])
		XCTAssertFalse(NodeArticleView(article: "", citations: [], onOpenSource: { _ in }).hasContent)
	}

	func testArticleComesBeforeSourcesAndKeepsItsBlocks() throws {
		let citations = try Self.citations(#"[{"url":"https://example.com/a","title":"A"}]"#)
		let sections = NodeArticleView.sections(article: "Intro.\n\n- One\n- Two", citations: citations)
		XCTAssertEqual(sections.count, 2)
		XCTAssertEqual(sections.first, .article([.paragraph("Intro."), .list(["One", "Two"])]))
		XCTAssertEqual(sections.map(\.kind), [.article, .sources])
	}

	// MARK: - Contract

	func testSectionHeadersAndIdentifiersFollowTheContract() {
		XCTAssertEqual(NodePageSpec.articleLabel, "article")
		XCTAssertEqual(NodePageSpec.sourcesLabel, "sources")
		XCTAssertEqual(NodeArticleView.articleIdentifier, "section-article")
		XCTAssertEqual(NodeArticleView.sourcesIdentifier, "section-sources")
		XCTAssertEqual(NodeArticleView.sourceRowIdentifier(index: 0), "source-row-0")
		XCTAssertEqual(NodeArticleView.sourceRowIdentifier(index: 12), "source-row-12")
	}

	// MARK: - Helpers

	private static func url(_ value: String) throws -> URL {
		try XCTUnwrap(URL(string: value), value)
	}

	private static func citations(_ json: String) throws -> [Citation] {
		try JSONDecoder().decode([Citation].self, from: Data(json.utf8))
	}
}

extension NodeArticleSection {
	fileprivate enum Kind { case article, sources }

	fileprivate var kind: Kind {
		switch self {
		case .article: .article
		case .sources: .sources
		}
	}
}
