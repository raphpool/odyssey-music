import XCTest

@testable import Track1

@MainActor
final class NodeListeningTests: XCTestCase {
	// MARK: - Which actions the node gets

	func testArtistWithExactLinksIsReadyWithTwoExactActions() async throws {
		let id = try Self.identity("artist:sample-node")
		let links = try Self.links(slug: id.rawValue)
		let probe = LinksProbe(.success(links, etag: nil), hold: true)
		let model = try Self.makeModel(id, links: probe)

		let load = Task { await model.load() }
		await Self.waitUntil { await probe.requested.count == 1 }
		XCTAssertEqual(model.listening, .loading, "The section shows a spinner while `/links` is in flight.")
		await probe.release()
		await load.value

		guard case .ready(let actions) = model.listening else { return XCTFail("Expected the ready state.") }
		XCTAssertEqual(actions.map(\.provider), [.spotify, .appleMusic])
		XCTAssertEqual(actions.map(\.linkKind), [.exact, .exact])
		XCTAssertEqual(actions.map(\.url), [try XCTUnwrap(links.spotify), try XCTUnwrap(links.apple)])
		let requested = await probe.requested
		XCTAssertEqual(requested, [id])
	}

	func testFailedLinksFallBackToTwoSearchActions() async throws {
		let results: [APIResult<LinksResponse>] = [.failure(.network), .notModified(etag: "x")]
		for result in results {
			let id = try Self.identity("track:sample-node")
			let model = try Self.makeModel(id, links: LinksProbe(result))

			await model.load()

			guard case .ready(let actions) = model.listening else { return XCTFail("Expected the ready state.") }
			XCTAssertEqual(actions.map(\.linkKind), [.search, .search])
			XCTAssertEqual(actions.map(\.title), ["Rechercher sur Spotify", "Rechercher sur Apple Music"])
			// The error message names the service through `serviceName`, which must match the button titles.
			XCTAssertTrue(actions.allSatisfy { $0.title.hasSuffix(NodeListeningView.serviceName($0.provider)) })
		}
	}

	func testLinksForAnotherSlugAreIgnoredAndTheNodeFallsBackToSearch() async throws {
		let id = try Self.identity("artist:sample-node")
		let foreign = try Self.links(slug: "artist:someone-else")
		let model = try Self.makeModel(id, links: LinksProbe(.success(foreign, etag: nil)))

		await model.load()

		guard case .ready(let actions) = model.listening else { return XCTFail("Expected the ready state.") }
		XCTAssertEqual(actions.map(\.linkKind), [.search, .search])
		XCTAssertFalse(actions.contains { $0.url == foreign.spotify || $0.url == foreign.apple })
	}

	func testGenreAndLabelAreHiddenWithoutCallingLinks() async throws {
		for slug in ["genre:trip-hop", "label:sample-label"] {
			let id = try Self.identity(slug)
			let probe = LinksProbe(.success(try Self.links(slug: slug), etag: nil))
			let model = try Self.makeModel(id, links: probe)

			await model.load()

			XCTAssertEqual(model.listening, .hidden, slug)
			let requested = await probe.requested
			XCTAssertTrue(requested.isEmpty, "\(slug) must not call /links.")
		}
	}

	func testEmptyActionListHidesTheSectionWithoutCallingLinks() async throws {
		let id = try Self.identity("artist:sample-node")
		let probe = LinksProbe(.success(try Self.links(slug: id.rawValue), etag: nil))
		let model = try Self.makeModel(id, name: " \\uFEFF ", links: probe)

		await model.load()

		XCTAssertEqual(model.listening, .hidden)
		let requested = await probe.requested
		XCTAssertTrue(requested.isEmpty)
	}

	func testWithoutALinksReaderTheSectionStaysHidden() async throws {
		let model = try Self.makeModel(try Self.identity("artist:sample-node"), links: nil)

		await model.load()

		XCTAssertEqual(model.listening, .hidden)
	}

	func testALinksResponseArrivingAfterCancellationDoesNotChangeTheState() async throws {
		let id = try Self.identity("artist:sample-node")
		let probe = LinksProbe(.success(try Self.links(slug: id.rawValue), etag: nil), hold: true)
		let model = try Self.makeModel(id, links: probe)

		let load = Task { await model.load() }
		await Self.waitUntil { await probe.requested.count == 1 }
		load.cancel()
		await probe.release()
		await load.value

		XCTAssertEqual(model.listening, .loading, "A late response must not publish actions.")
	}

	// MARK: - Opening

	func testConcurrentGesturesOpenOnceAndRecordOneEvent() async throws {
		let (model, recorder) = try await Self.readyModel()
		let action = try XCTUnwrap(Self.firstAction(model))
		let os = OSOpener(hold: true)

		let first = Task { await model.openListening(action, using: { await os.open($0) }) }
		let second = Task { await model.openListening(action, using: { await os.open($0) }) }
		await Self.waitUntil { os.opened.count == 1 }
		for _ in 0..<5 { await Task.yield() }
		XCTAssertTrue(model.isOpeningListening)
		XCTAssertEqual(os.opened.count, 1, "The second gesture must not reach the OS.")

		os.release()
		await first.value
		await second.value

		XCTAssertEqual(os.opened, [action.url])
		XCTAssertEqual(recorder.events.map(\.name).filter { $0 != .nodeViewed }, [.externalListeningOpened])
		XCTAssertFalse(model.isOpeningListening)
		XCTAssertNil(model.listeningFailure)

		await model.openListening(action, using: { await os.open($0) })
		XCTAssertEqual(os.opened.count, 2, "Once the first opening is over, a new gesture is accepted again.")
	}

	func testFailedOpeningNamesTheProviderAndTheNextSuccessClearsIt() async throws {
		let (model, recorder) = try await Self.readyModel()
		let action = try XCTUnwrap(Self.firstAction(model))

		await model.openListening(action, using: { _ in false })

		XCTAssertEqual(model.listeningFailure, action.provider)
		XCTAssertFalse(model.isOpeningListening)
		let failed = try XCTUnwrap(recorder.events.last)
		XCTAssertEqual(failed.name, .externalListeningFailed)
		XCTAssertEqual(failed.properties["error_code"], .string("open_failed"))

		await model.openListening(action, using: { _ in true })

		XCTAssertNil(model.listeningFailure)
		XCTAssertEqual(recorder.events.last?.name, .externalListeningOpened)
		XCTAssertEqual(NodeListeningView.serviceName(.appleMusic), "Apple Music")
	}

	func testOpeningIsIgnoredWhileTheNodeIsNotLoaded() async throws {
		let id = try Self.identity("artist:sample-node")
		let model = try Self.makeModel(id, links: nil)
		let action = try XCTUnwrap(
			ListeningActions.actions(for: .artist, name: "Sample", links: nil).first)
		let os = OSOpener(hold: false)

		await model.openListening(action, using: { await os.open($0) })

		XCTAssertTrue(os.opened.isEmpty)
	}

	// MARK: - Helpers

	@MainActor
	private final class Recorder {
		private(set) var events = [AnalyticsEvent]()
		var record: NodeEventRecorder { { [self] event in events.append(event) } }
	}

	/// The OS boundary: records what it is asked to open, optionally until the test releases it.
	@MainActor
	private final class OSOpener {
		private(set) var opened = [URL]()
		private let hold: Bool
		private var gate: CheckedContinuation<Void, Never>?

		init(hold: Bool) { self.hold = hold }

		func open(_ url: URL) async -> Bool {
			opened.append(url)
			if hold { await withCheckedContinuation { gate = $0 } }
			return true
		}

		func release() {
			gate?.resume()
			gate = nil
		}
	}

	private actor LinksProbe {
		private(set) var requested = [NodeIdentity]()
		private let response: APIResult<LinksResponse>
		private let hold: Bool
		private var gate: CheckedContinuation<Void, Never>?

		init(_ response: APIResult<LinksResponse>, hold: Bool = false) {
			self.response = response
			self.hold = hold
		}

		func read(_ identity: NodeIdentity) async -> APIResult<LinksResponse> {
			requested.append(identity)
			if hold { await withCheckedContinuation { gate = $0 } }
			return response
		}

		func release() {
			gate?.resume()
			gate = nil
		}
	}

	private static func readyModel() async throws -> (NodeViewModel, Recorder) {
		let id = try identity("artist:sample-node")
		let recorder = Recorder()
		let probe = LinksProbe(.success(try links(slug: id.rawValue), etag: nil))
		let model = try makeModel(id, links: probe, recorder: recorder)
		await model.load()
		return (model, recorder)
	}

	private static func firstAction(_ model: NodeViewModel) -> ListeningAction? {
		guard case .ready(let actions) = model.listening else { return nil }
		return actions.first
	}

	private static func makeModel(
		_ id: NodeIdentity, name: String = "Sample", links probe: LinksProbe?, recorder: Recorder = Recorder()
	) throws -> NodeViewModel {
		let response = try nodeResponse(id: id, name: name)
		var readLinks: LinksReader?
		if let probe { readLinks = { await probe.read($0) } }
		return NodeViewModel(
			identity: id,
			context: .independent(source: .search),
			readNode: { _ in .success(response, etag: nil) },
			readLinks: readLinks,
			recordEvent: recorder.record
		)
	}

	/// Polls instead of yielding: the `/links` reader runs off the main actor.
	private static func waitUntil(
		_ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line
	) async {
		for _ in 0..<400 {
			if await condition() { return }
			try? await Task.sleep(nanoseconds: 5_000_000)
		}
		XCTFail("The awaited condition never became true.", file: file, line: line)
	}

	private static func identity(_ value: String) throws -> NodeIdentity {
		try XCTUnwrap(NodeIdentity(rawValue: value))
	}

	private static func nodeResponse(id: NodeIdentity, name: String) throws -> NodeResponse {
		let source = """
			{"node":{"id":"\(id.rawValue)","type":"\(id.type.rawValue)","name":"\(name)","teaser":null,"article":"Article","citations":[],"facts":{},"edges":{},"materialized_at":"2026-10-08T00:00:00Z","image_url":null},"source":"cache"}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeResponse.self, from: Data(source.utf8))
	}

	private static func links(slug: String) throws -> LinksResponse {
		let json = """
			{"slug":"\(slug)","spotify":"https://open.spotify.com/artist/abc123",
			"apple":"https://music.apple.com/fr/artist/sample/123","sources":{},"resolvedAt":"2026-10-01T00:00:00Z"}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(LinksResponse.self, from: Data(json.utf8))
	}
}
