import XCTest

@testable import Track1Core

final class HeroImageSourceTests: XCTestCase {
	private let cover = "https://img.example.com/cover.jpg"

	// MARK: - Candidates

	func testArtistUsesItsImageThenTheFirstRelease() throws {
		let edges = ["discography": Self.list(.project, "a", "b")]
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))
		let release = HeroCandidate.node(try Self.id("project:a"))

		XCTAssertEqual(try Self.candidates(.artist, imageURL: cover, edges: edges), [own, release])
		XCTAssertEqual(try Self.candidates(.artist, imageURL: nil, edges: edges), [release])
		XCTAssertEqual(try Self.candidates(.artist, imageURL: cover, edges: [:]), [own])
		XCTAssertEqual(try Self.candidates(.artist, imageURL: nil, edges: [:]), [])
	}

	func testProjectUsesOnlyItsOwnImage() throws {
		let edges = ["artists": Self.list(.artist, "a"), "tracks": Self.list(.track, "t")]
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))

		XCTAssertEqual(try Self.candidates(.project, imageURL: cover, edges: edges), [own])
		XCTAssertEqual(try Self.candidates(.project, imageURL: nil, edges: edges), [])
	}

	func testTrackUsesItsImageThenItsProjectEdge() throws {
		let edges = ["project": Self.object(.project, "album")]
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))
		let project = HeroCandidate.node(try Self.id("project:album"))

		XCTAssertEqual(try Self.candidates(.track, imageURL: cover, edges: edges), [own, project])
		XCTAssertEqual(try Self.candidates(.track, imageURL: nil, edges: edges), [project])
		XCTAssertEqual(try Self.candidates(.track, imageURL: nil, edges: [:]), [])
	}

	func testTrackProjectEdgeAsAListUsesItsFirstEntry() throws {
		let edges = ["project": Self.list(.project, "first", "second")]

		XCTAssertEqual(
			try Self.candidates(.track, imageURL: nil, edges: edges), [.node(try Self.id("project:first"))])
	}

	func testGenreUsesItsImageThenLandmarkProjectThenLandmarkTrack() throws {
		let both = [
			"landmark_projects": Self.list(.project, "p1", "p2"), "landmark_tracks": Self.list(.track, "t1"),
		]
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))
		let project = HeroCandidate.node(try Self.id("project:p1"))
		let track = HeroCandidate.node(try Self.id("track:t1"))

		XCTAssertEqual(try Self.candidates(.genre, imageURL: cover, edges: both), [own, project, track])
		XCTAssertEqual(try Self.candidates(.genre, imageURL: nil, edges: both), [project, track])
		XCTAssertEqual(
			try Self.candidates(.genre, imageURL: nil, edges: ["landmark_tracks": Self.list(.track, "t1")]),
			[track])
		XCTAssertEqual(try Self.candidates(.genre, imageURL: cover, edges: [:]), [own])
		XCTAssertEqual(try Self.candidates(.genre, imageURL: nil, edges: [:]), [])
	}

	func testLabelUsesItsImageThenItsFirstNotableRelease() throws {
		let edges = ["notable_releases": Self.list(.project, "r1", "r2"), "roster": Self.list(.artist, "x")]
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))
		let release = HeroCandidate.node(try Self.id("project:r1"))

		XCTAssertEqual(try Self.candidates(.label, imageURL: cover, edges: edges), [own, release])
		XCTAssertEqual(try Self.candidates(.label, imageURL: nil, edges: edges), [release])
		XCTAssertEqual(try Self.candidates(.label, imageURL: cover, edges: [:]), [own])
		XCTAssertEqual(try Self.candidates(.label, imageURL: nil, edges: [:]), [])
	}

	func testEveryNodeTypePutsItsOwnImageFirst() throws {
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))
		let edges = [
			"discography": Self.list(.project, "a"), "project": Self.object(.project, "album"),
			"landmark_projects": Self.list(.project, "p"), "landmark_tracks": Self.list(.track, "t"),
			"notable_releases": Self.list(.project, "r"),
		]
		for type in [NodeType.artist, .project, .track, .genre, .label] {
			XCTAssertEqual(try Self.candidates(type, imageURL: cover, edges: edges).first, own, "\(type)")
		}
	}

	func testAnEmptyEdgeListGivesNoCandidate() throws {
		XCTAssertEqual(try Self.candidates(.artist, imageURL: nil, edges: ["discography": "[]"]), [])
	}

	func testAnImageURLThatIsNotPublicHTTPSIsIgnoredAndTheNextCandidateIsKept() throws {
		let edges = ["discography": Self.list(.project, "a")]
		let release = HeroCandidate.node(try Self.id("project:a"))
		let unsafe = [
			"http://img.example.com/cover.jpg", "https://127.0.0.1/cover.jpg", "https://localhost/cover.jpg",
			"https://img.example.com:8443/cover.jpg", "https://10.0.0.5/cover.jpg",
		]
		for value in unsafe {
			XCTAssertEqual(try Self.candidates(.artist, imageURL: value, edges: edges), [release], value)
			XCTAssertEqual(try Self.candidates(.project, imageURL: value, edges: [:]), [], value)
			XCTAssertEqual(try Self.candidates(.genre, imageURL: value, edges: [:]), [], value)
			XCTAssertEqual(try Self.candidates(.label, imageURL: value, edges: [:]), [], value)
		}
	}

	func testCandidatesOfADecodedNodeMatchTheRawEntryPoint() throws {
		let source = """
			{"id":"artist:sample-node","type":"artist","name":"Sample","teaser":null,"article":"A","citations":[],"facts":{},"edges":{"discography":[{"slug":"project:a","type":"project","name":"A"}]},"materialized_at":"2026-10-08T00:00:00Z","image_url":"\(cover)"}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		let node = try decoder.decode(NodeDetail.self, from: Data(source.utf8))

		XCTAssertEqual(
			HeroImageSource.candidates(for: node),
			[.url(try XCTUnwrap(URL(string: cover))), .node(try Self.id("project:a"))])
	}

	// MARK: - Style (TRA-500)

	func testAnArtistOwnImageIsADerivedCoverOnlyWhenTheServerSaysSo() throws {
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))

		XCTAssertEqual(
			HeroImageSource.style(of: own, type: .artist, imageSource: "derived-cover"), .derivedCover)
		XCTAssertEqual(HeroImageSource.style(of: own, type: .artist, imageSource: "wikidata-p18"), .photo)
		XCTAssertEqual(HeroImageSource.style(of: own, type: .artist, imageSource: nil), .photo)
	}

	func testAnImageBorrowedFromAnEdgeIsADerivedCoverForArtistLabelAndGenre() throws {
		let edge = HeroCandidate.node(try Self.id("project:a"))

		for type in [NodeType.artist, .label, .genre] {
			XCTAssertEqual(HeroImageSource.style(of: edge, type: type, imageSource: nil), .derivedCover, "\(type)")
			XCTAssertEqual(
				HeroImageSource.style(of: edge, type: type, imageSource: "wikidata-p18"), .derivedCover, "\(type)")
		}
	}

	func testGenreAndLabelOwnImagesFollowTheirImageSource() throws {
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))

		for type in [NodeType.label, .genre] {
			XCTAssertEqual(
				HeroImageSource.style(of: own, type: type, imageSource: "derived-cover"), .derivedCover, "\(type)")
			XCTAssertEqual(HeroImageSource.style(of: own, type: type, imageSource: "wikidata-p154"), .photo, "\(type)")
		}
	}

	func testProjectAndTrackKeepTheFullFrameStyleWhateverTheSource() throws {
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))
		let edge = HeroCandidate.node(try Self.id("project:album"))

		for type in [NodeType.project, .track] {
			for source in [nil, "caa", "itunes", "derived-cover"] {
				XCTAssertEqual(HeroImageSource.style(of: own, type: type, imageSource: source), .photo, "\(type)")
				XCTAssertEqual(HeroImageSource.style(of: edge, type: type, imageSource: source), .photo, "\(type)")
			}
		}
	}

	func testTheNodeDecodesItsImageSourceForTheStyle() throws {
		let source = """
			{"id":"artist:sample-node","type":"artist","name":"Sample","teaser":null,"article":"A","citations":[],"facts":{},"edges":{},"materialized_at":"2026-10-08T00:00:00Z","image_url":"\(cover)","image_source":"derived-cover"}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		let node = try decoder.decode(NodeDetail.self, from: Data(source.utf8))
		let candidate = try XCTUnwrap(HeroImageSource.candidates(for: node).first)

		XCTAssertEqual(
			HeroImageSource.style(of: candidate, type: node.type, imageSource: node.imageSource), .derivedCover)
	}

	// MARK: - Fallback chain

	func testFirstMatchSaysWhichCandidateProducedTheImage() async throws {
		let backend = Backend(images: ["project:b": "https://img.example.com/b.jpg"])
		let store = backend.makeStore()
		let winner = HeroCandidate.node(try Self.id("project:b"))
		let candidates: [HeroCandidate] = [.node(try Self.id("project:a")), winner]

		let match = await HeroImageSource.firstMatch(among: candidates, store: store)

		XCTAssertEqual(match?.image, "https://img.example.com/b.jpg")
		XCTAssertEqual(match?.candidate, winner)
	}

	func testFirstCandidateWithAnImageWinsAndLaterOnesAreNotRead() async throws {
		let backend = Backend(images: ["project:a": "https://img.example.com/a.jpg"])
		let store = backend.makeStore()
		let candidates: [HeroCandidate] = [.node(try Self.id("project:a")), .node(try Self.id("project:b"))]

		let image = await HeroImageSource.firstImage(among: candidates, store: store)

		XCTAssertEqual(image, "https://img.example.com/a.jpg")
		XCTAssertEqual(backend.reads, ["project:a"])
	}

	func testChainFallsThroughACandidateWithoutImage() async throws {
		let backend = Backend(images: ["project:b": "https://img.example.com/b.jpg"])
		let store = backend.makeStore()
		let candidates: [HeroCandidate] = [
			.url(try XCTUnwrap(URL(string: "https://img.example.com/missing.jpg"))),
			.node(try Self.id("project:a")), .node(try Self.id("project:b")),
		]

		let image = await HeroImageSource.firstImage(among: candidates, store: store)

		XCTAssertEqual(image, "https://img.example.com/b.jpg")
		XCTAssertEqual(backend.reads, ["project:a", "project:b"])
	}

	func testChainGivesNilWhenNoCandidateHasAnImageOrThereIsNone() async throws {
		let store = Backend(images: [:]).makeStore()

		let none = await HeroImageSource.firstImage(among: [], store: store)
		let missing = await HeroImageSource.firstImage(among: [.node(try Self.id("project:a"))], store: store)

		XCTAssertNil(none)
		XCTAssertNil(missing)
	}

	func testChainReadsNothingWhenAlreadyCancelled() async throws {
		let backend = Backend(images: ["project:a": "https://img.example.com/a.jpg"])
		let store = backend.makeStore()
		let candidates: [HeroCandidate] = [.node(try Self.id("project:a"))]

		let task = Task { () -> String? in
			withUnsafeCurrentTask { $0?.cancel() }
			return await HeroImageSource.firstImage(among: candidates, store: store)
		}

		let image = await task.value
		XCTAssertNil(image)
		XCTAssertEqual(backend.reads, [])
	}

	// MARK: - Fixtures

	private static func id(_ value: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: value))
	}

	private static func candidates(
		_ type: NodeType, imageURL: String?, edges: [String: String]
	) throws -> [HeroCandidate] {
		let decoder = JSONDecoder()
		let values = try edges.mapValues { try decoder.decode(NodeEdgeValue.self, from: Data($0.utf8)) }
		return HeroImageSource.candidates(type: type, imageURL: imageURL.flatMap { URL(string: $0) }, edges: values)
	}

	/// Slugs are `<type>:<name>`, so `list(.project, "a")` is the edge `project:a`.
	private static func object(_ type: NodeType, _ name: String) -> String {
		#"{"slug":"\#(type.rawValue):\#(name)","type":"\#(type.rawValue)","name":"\#(name)"}"#
	}

	private static func list(_ type: NodeType, _ names: String...) -> String {
		"[" + names.map { object(type, $0) }.joined(separator: ",") + "]"
	}
}

/// Answers `/image` from a table and records which identities were read. The loader returns the URL itself,
/// so a test reads which image won straight from the result.
private final class Backend: @unchecked Sendable {
	private let lock = NSLock()
	private let images: [String: String]
	private var recorded: [String] = []

	init(images: [String: String]) {
		self.images = images
	}

	var reads: [String] { lock.withLock { recorded } }

	func makeStore() -> NodeImageStore<String> {
		NodeImageStore<String>(
			readImage: { [self] in read($0) },
			load: { url in url.absoluteString == "https://img.example.com/missing.jpg" ? nil : url.absoluteString }
		)
	}

	private func read(_ identity: NodeIdentity) -> APIResult<ImageResponse> {
		lock.withLock { recorded.append(identity.rawValue) }
		let url = images[identity.rawValue].map { "\"\($0)\"" } ?? "null"
		let body = #"{"slug":"\#(identity.rawValue)","image_url":\#(url),"source":"test"}"#
		guard let response = try? JSONDecoder().decode(ImageResponse.self, from: Data(body.utf8)) else {
			return .failure(.invalidResponse)
		}
		return .success(response, etag: nil)
	}
}
