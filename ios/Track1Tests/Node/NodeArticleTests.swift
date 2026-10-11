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
}
