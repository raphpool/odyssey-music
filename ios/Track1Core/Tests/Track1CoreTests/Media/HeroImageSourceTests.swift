import XCTest

@testable import Track1Core

final class HeroImageSourceTests: XCTestCase {
	private let cover = "https://img.example.com/cover.jpg"

	// MARK: - Candidates

	func testArtistLabelAndGenreUseTheirImageElseTheirOwnImageEndpoint() throws {
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))

		for type in [NodeType.artist, .label, .genre] {
			XCTAssertEqual(try Self.candidates(type, imageURL: cover, edges: [:]), [own], "\(type)")
			XCTAssertEqual(
				try Self.candidates(type, imageURL: nil, edges: [:]), [.node(try Self.id("\(type.rawValue):roni-size"))],
				"\(type)")
		}
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

	// MARK: - Reciprocity (TRA-593)

	/// Mille Plateaux / Electric Ladyland: a label page that lists a Reprise release. A page edge says nothing
	/// about the label of a work, so the only node the hero may ask is the label itself, whose `/image` the
	/// server answers from a release that declares it.
	func testALabelNeverBorrowsAListedRelease() throws {
		let edges = [
			"notable_releases": Self.list(.project, "electric-ladyland--the-jimi-hendrix-experience"),
			"roster": Self.list(.artist, "x"),
		]

		XCTAssertEqual(
			try Self.candidates(.label, slug: "mille-plateaux", imageURL: nil, edges: edges),
			[.node(try Self.id("label:mille-plateaux"))])
	}

	func testNoArtistLabelOrGenreHeroEverAsksForAnotherNodesImage() throws {
		let edges = [
			"discography": Self.list(.project, "a"), "notable_tracks": Self.list(.track, "t"),
			"notable_releases": Self.list(.project, "r"), "landmark_project": Self.object(.project, "lp"),
			"landmark_projects": Self.list(.project, "p"), "landmark_tracks": Self.list(.track, "lt"),
		]

		for type in [NodeType.artist, .label, .genre] {
			let identity = try Self.id("\(type.rawValue):subject")
			XCTAssertEqual(
				try Self.candidates(type, slug: "subject", imageURL: nil, edges: edges), [.node(identity)], "\(type)")
			XCTAssertEqual(
				try Self.candidates(type, slug: "subject", imageURL: cover, edges: edges),
				[.url(try XCTUnwrap(URL(string: cover)))], "\(type)")
		}
	}

	func testEveryNodeTypePutsItsOwnImageFirst() throws {
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))
		let edges = ["discography": Self.list(.project, "a"), "project": Self.object(.project, "album")]
		for type in [NodeType.artist, .project, .track, .genre, .label] {
			XCTAssertEqual(try Self.candidates(type, imageURL: cover, edges: edges).first, own, "\(type)")
		}
	}

	func testAnImageURLThatIsNotPublicHTTPSIsIgnoredAndTheNextCandidateIsKept() throws {
		let own = try Self.id("artist:roni-size")
		let unsafe = [
			"http://img.example.com/cover.jpg", "https://127.0.0.1/cover.jpg", "https://localhost/cover.jpg",
			"https://img.example.com:8443/cover.jpg", "https://10.0.0.5/cover.jpg",
		]
		for value in unsafe {
			XCTAssertEqual(try Self.candidates(.artist, imageURL: value, edges: [:]), [.node(own)], value)
			XCTAssertEqual(try Self.candidates(.project, imageURL: value, edges: [:]), [], value)
			XCTAssertEqual(
				try Self.candidates(.genre, imageURL: value, edges: [:]), [.node(try Self.id("genre:roni-size"))], value)
			XCTAssertEqual(
				try Self.candidates(.label, imageURL: value, edges: [:]), [.node(try Self.id("label:roni-size"))], value)
		}
	}

	func testCandidatesOfADecodedNodeMatchTheRawEntryPoint() throws {
		let edges = #""edges":{"discography":[{"slug":"project:a","type":"project","name":"A"}]}"#
		func decode(_ image: String) throws -> NodeDetail {
			let source = """
				{"id":"artist:sample-node","type":"artist","name":"Sample","teaser":null,"article":"A","citations":[],"facts":{},\(edges),"materialized_at":"2026-10-08T00:00:00Z"\(image)}
				"""
			let decoder = JSONDecoder()
			decoder.dateDecodingStrategy = .iso8601
			return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
		}

		XCTAssertEqual(
			HeroImageSource.candidates(for: try decode(#","image_url":"\#(cover)""#)),
			[.url(try XCTUnwrap(URL(string: cover)))])
		XCTAssertEqual(
			HeroImageSource.candidates(for: try decode("")), [.node(try Self.id("artist:sample-node"))])
	}

	// MARK: - Style (TRA-500)

	func testAnArtistOwnImageIsADerivedCoverOnlyWhenTheServerSaysSo() throws {
		let own = HeroCandidate.url(try XCTUnwrap(URL(string: cover)))

		XCTAssertEqual(
			HeroImageSource.style(of: own, type: .artist, imageSource: "derived-cover"), .derivedCover)
		XCTAssertEqual(HeroImageSource.style(of: own, type: .artist, imageSource: "wikidata-p18"), .photo)
		XCTAssertEqual(HeroImageSource.style(of: own, type: .artist, imageSource: nil), .photo)
	}

	func testAnImageReadFromANodeEndpointIsADerivedCoverForArtistLabelAndGenre() throws {
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

	func testAPendingCandidateIsSkippedWithoutWaitingAndTheNextOneIsRendered() async throws {
		let backend = Backend(
			images: ["project:b": "https://img.example.com/b.jpg"], pending: ["project:a"])
		let store = backend.makeStore()
		let candidates: [HeroCandidate] = [.node(try Self.id("project:a")), .node(try Self.id("project:b"))]

		let image = await HeroImageSource.firstImage(among: candidates, store: store)

		XCTAssertEqual(image, "https://img.example.com/b.jpg")
		XCTAssertEqual(backend.reads, ["project:a", "project:b"])
		XCTAssertEqual(backend.sleepCount, 0, "A hero never waits for a pending candidate.")
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

	/// `slug` defaults to `roni-size`: the node whose page the edge fixtures below describe.
	private static func candidates(
		_ type: NodeType, slug: String = "roni-size", imageURL: String?, edges: [String: String]
	) throws -> [HeroCandidate] {
		let decoder = JSONDecoder()
		let values = try edges.mapValues { try decoder.decode(NodeEdgeValue.self, from: Data($0.utf8)) }
		return HeroImageSource.candidates(
			type: type, id: try id("\(type.rawValue):\(slug)"), imageURL: imageURL.flatMap { URL(string: $0) },
			edges: values)
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
	private let pending: Set<String>
	private var recorded: [String] = []
	private var sleeps = 0

	init(images: [String: String], pending: Set<String> = []) {
		self.images = images
		self.pending = pending
	}

	var reads: [String] { lock.withLock { recorded } }
	var sleepCount: Int { lock.withLock { sleeps } }

	func makeStore() -> NodeImageStore<String> {
		NodeImageStore<String>(
			readImage: { [self] in read($0) },
			load: { url in url.absoluteString == "https://img.example.com/missing.jpg" ? nil : url.absoluteString },
			sleep: { [self] _ in lock.withLock { sleeps += 1 } }
		)
	}

	private func read(_ identity: NodeIdentity) -> APIResult<ImageResponse> {
		lock.withLock { recorded.append(identity.rawValue) }
		let url = images[identity.rawValue].map { "\"\($0)\"" } ?? "null"
		let state = pending.contains(identity.rawValue) ? #","state":"pending","retry_after_seconds":5"# : ""
		let body = #"{"slug":"\#(identity.rawValue)","image_url":\#(url),"source":"test"\#(state)}"#
		guard let response = try? JSONDecoder().decode(ImageResponse.self, from: Data(body.utf8)) else {
			return .failure(.invalidResponse)
		}
		return .success(response, etag: nil)
	}
}
