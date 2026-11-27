import XCTest

@testable import Track1Core

final class PlayerSourceTests: XCTestCase {
	private func urls(_ values: [String]) throws -> [URL] {
		try values.map { try XCTUnwrap(URL(string: $0), $0) }
	}

	private func first(_ values: [String]) throws -> PlayerSource? {
		PlayerSource.first(urls: try urls(values))
	}

	func testTheLabelKeepsTheColonOnTheLineWithANoBreakSpace() {
		XCTAssertEqual(PlayerSource.label, "Source\u{00A0}:")
	}

	func testTheLineIsTheLabelThenASpaceThenTheDomain() throws {
		let url = try XCTUnwrap(URL(string: "https://pitchfork.com/"))

		XCTAssertEqual(PlayerSource(domain: "pitchfork.com", url: url).line, "Source\u{00A0}: pitchfork.com")
	}

	func testTheDomainLosesItsWWWAndTheUrlStaysAsWritten() throws {
		let source = try XCTUnwrap(first(["https://www.pitchfork.com/reviews/x"]))

		XCTAssertEqual(source.domain, "pitchfork.com")
		XCTAssertEqual(source.url.absoluteString, "https://www.pitchfork.com/reviews/x")
	}

	func testAnotherSubdomainIsKept() throws {
		XCTAssertEqual(try first(["https://en.wikipedia.org/wiki/X"])?.domain, "en.wikipedia.org")
	}

	func testTheHostIsLowercased() throws {
		let source = try XCTUnwrap(first(["https://WWW.Example.COM/a"]))

		XCTAssertEqual(source.domain, "example.com")
		XCTAssertEqual(source.url.absoluteString, "https://WWW.Example.COM/a", "The target is not rewritten.")
	}

	func testWWWIsKeptWhenNoDotRemainsAfterIt() throws {
		XCTAssertEqual(try first(["https://www.com/"])?.domain, "www.com")
	}

	func testPunycodeIsKeptAsIs() throws {
		XCTAssertEqual(try first(["https://xn--mnchen-3ya.de/"])?.domain, "xn--mnchen-3ya.de")
	}

	func testTheFirstPublicHTTPSURLWins() throws {
		let source = try XCTUnwrap(first(["http://a.example/", "https://b.example/"]))

		XCTAssertEqual(source.domain, "b.example")
	}

	func testPrivateHostsCredentialsAndPortsAreRefused() throws {
		XCTAssertNil(try first(["https://127.0.0.1/", "https://user:pw@c.example/", "https://d.example:8443/"]))
	}

	func testNoUrlGivesNoSource() throws {
		XCTAssertNil(try first([]))
	}

	func testFirstInCitationsTakesTheFirstDecodedCitation() throws {
		let json = """
			[{"url":"https://www.first.example/a","title":"First"},{"url":"https://second.example/b","title":"Second"}]
			"""
		let citations = try JSONDecoder().decode([Citation].self, from: Data(json.utf8))

		let source = PlayerSource.first(in: citations)

		XCTAssertEqual(citations.count, 2)
		XCTAssertEqual(source?.domain, "first.example")
		XCTAssertEqual(source?.url, citations.first?.url)
		XCTAssertNil(PlayerSource.first(in: []))
	}

	func testDomainOfAUrlWithoutAHostIsNil() throws {
		XCTAssertNil(PlayerSource.domain(of: try XCTUnwrap(URL(string: "mailto:someone@example.com"))))
	}

	func testDomainOfStripsOneWWWOnly() throws {
		let url = try XCTUnwrap(URL(string: "https://www.www.example.com/"))

		XCTAssertEqual(PlayerSource.domain(of: url), "www.example.com")
	}
}
