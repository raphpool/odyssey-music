import XCTest

@testable import Track1Core

/// TRA-482: the artist context of a generation tapped from a search hit, and the rules of the artist text.
final class GenerationRequestBuilderTests: XCTestCase {
	// MARK: search hits

	func testAProjectHitSendsItsArtistAndNeverTheJoinedSubtitle() throws {
		let hit = try Self.hit(
			#"{"source":"catalog","type":"project","name":"Mezzanine","subtitle":"Massive Attack, Mad Professor","artist":"Massive Attack","mbid":"11111111-1111-4111-8111-111111111111"}"#
		)
		let requestID = UUID()

		let request = GenerationRequestBuilder.request(for: hit, requestID: requestID)

		XCTAssertEqual(request.artist, "Massive Attack")
		XCTAssertEqual(request.type, .project)
		XCTAssertEqual(request.name, "Mezzanine")
		XCTAssertEqual(request.requestID, requestID)
		XCTAssertEqual(request.mbid?.uuidString.lowercased(), "11111111-1111-4111-8111-111111111111")
		XCTAssertNil(request.source)
	}

	func testATrackHitWithoutArtistSendsNoArtistEvenWithASubtitle() throws {
		let hit = try Self.hit(
			#"{"source":"catalog","type":"track","name":"Teardrop","subtitle":"Massive Attack"}"#)
		XCTAssertNil(GenerationRequestBuilder.request(for: hit).artist)
	}

	func testHitsOfOtherTypesNeverSendAnArtist() throws {
		for type in ["artist", "genre", "label"] {
			let hit = try Self.hit(#"{"source":"catalog","type":"\#(type)","name":"Name","artist":"Someone"}"#)
			XCTAssertNil(GenerationRequestBuilder.request(for: hit).artist, type)
		}
	}

	func testACacheHitKeepsItsSlugAndTheArtistSlugIsNeverUsedAsAWorkSlug() throws {
		let hit = try Self.hit(
			#"{"source":"cache","type":"track","name":"Teardrop","slug":"track:teardrop--massive-attack","artist":"Massive Attack","artist_slug":"artist:massive-attack"}"#
		)

		let request = GenerationRequestBuilder.request(for: hit)

		XCTAssertEqual(request.slug?.rawValue, "track:teardrop--massive-attack")
		XCTAssertEqual(hit.artistSlug?.rawValue, "artist:massive-attack")
	}

	func testAHitWithoutTheNewFieldsStillDecodes() throws {
		let hit = try Self.hit(
			#"{"source":"cache","type":"artist","name":"Massive Attack","slug":"artist:massive-attack"}"#)
		XCTAssertNil(hit.artist)
		XCTAssertNil(hit.artistSlug)
	}

	func testAMalformedOrMistypedOptionalFieldIsReadAsAbsentWithoutFailingTheHit() throws {
		let notAnArtist = try Self.hit(
			#"{"source":"catalog","type":"project","name":"M","artist":"A","artist_slug":"genre:trip-hop"}"#)
		XCTAssertEqual(notAnArtist.artist, "A")
		XCTAssertNil(notAnArtist.artistSlug)

		let malformed = try Self.hit(
			#"{"source":"catalog","type":"project","name":"M","artist":42,"artist_slug":"Not A Slug"}"#)
		XCTAssertNil(malformed.artist)
		XCTAssertNil(malformed.artistSlug)
	}

	// MARK: artist text

	func testTheArtistIsTrimmedAndItsWhitespaceCollapsedLikeTheServerDoes() {
		XCTAssertEqual(GenerationRequestBuilder.contextArtist("  Earth,  Wind\n& Fire "), "Earth, Wind & Fire")
	}

	func testAnUnusableArtistIsNil() {
		XCTAssertNil(GenerationRequestBuilder.contextArtist(nil))
		XCTAssertNil(GenerationRequestBuilder.contextArtist(" \n\t "))
		XCTAssertNil(GenerationRequestBuilder.contextArtist("Rohff\u{0000}"))
		XCTAssertNil(GenerationRequestBuilder.contextArtist(String(repeating: "a", count: 201)))
		XCTAssertEqual(GenerationRequestBuilder.contextArtist(String(repeating: "a", count: 200))?.count, 200)
	}

	// The server refuses or ignores it by flag; dropping it here would hide that and attach the work elsewhere.
	func testAnArtistWithoutLatinLetterIsPassedOnForTheServerToJudge() {
		XCTAssertEqual(GenerationRequestBuilder.contextArtist("坂本龍一"), "坂本龍一")
	}

	private static func hit(_ json: String) throws -> SearchHit {
		try JSONDecoder().decode(SearchHit.self, from: Data(json.utf8))
	}
}
