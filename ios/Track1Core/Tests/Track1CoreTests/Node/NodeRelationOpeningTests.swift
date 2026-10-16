import XCTest

@testable import Track1Core

@MainActor
final class NodeRelationOpeningTests: XCTestCase {
	func testOneTouchRecordsRelationOpenedOnceWithTheV1PropertiesThenNavigates() async throws {
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let context = NavigationContext(source: .home, recommendationID: recommendationID)
		let events = EventLog()
		let model = try await Self.loadedModel(context: context, log: events)
		let edge = try Self.edge("project:target", name: "Target")
		events.values.removeAll()
		var opened = [(NodeIdentity, NavigationContext)]()

		let accepted = model.openRelation(edge, kind: "discography") { opened.append(($0, $1)) }

		XCTAssertTrue(accepted)
		XCTAssertEqual(events.values.map(\.name), [.relationOpened])
		XCTAssertEqual(events.values.first?.source, .relation)
		XCTAssertEqual(
			events.values.first?.properties,
			[
				"from_node_id": .string("artist:source"),
				"node_id": .string("project:target"),
				"node_type": .string("project"),
				"relation_kind": .string("discography"),
				"recommendation_id": .string(recommendationID.uuidString.lowercased()),
			])
		XCTAssertTrue(events.values.allSatisfy(AnalyticsValidation.accepts))
		XCTAssertEqual(opened.map(\.0), [edge.slug])
		XCTAssertEqual(opened.map(\.1), [context.followingRelation()])
	}

	func testTouchingTheLandmarkAlbumOpensItsProjectPageThroughTheSameGateAsAChip() async throws {
		let events = EventLog()
		let model = try await Self.loadedModel(context: .independent(source: .home), log: events)
		let album = try Self.edge("project:landmark", name: "Landmark")
		let track = try Self.edge("track:reference", name: "Reference")
		events.values.removeAll()
		var opened = [NodeIdentity]()

		// The highlights open with their edge field as the relation kind, as `NodePageView` wires them.
		for entry in ArtistHighlights(landmarkProject: album, referenceTrack: track).entries {
			XCTAssertTrue(model.openRelation(entry.edge, kind: entry.field) { identity, _ in opened.append(identity) })
		}

		XCTAssertEqual(opened.map(\.rawValue), ["project:landmark", "track:reference"])
		XCTAssertEqual(events.values.map(\.name), [.relationOpened, .relationOpened])
		XCTAssertEqual(
			events.values.first?.properties["relation_kind"], .string("landmark_project"))
		XCTAssertEqual(events.values.first?.properties["node_type"], .string("project"))
		XCTAssertEqual(events.values.last?.properties["relation_kind"], .string("reference_track"))
		XCTAssertTrue(events.values.allSatisfy(AnalyticsValidation.accepts))
	}

	func testASimilarArtistChipOpensTheNodeLikeACollaboratorChip() async throws {
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let context = NavigationContext(source: .home, recommendationID: recommendationID)
		let events = EventLog()
		let model = try await Self.loadedModel(context: context, log: events)
		let similar = try Self.edge("artist:similar-one", name: "Similar One")
		let collaborator = try Self.edge("artist:collab-one", name: "Collab One")
		events.values.removeAll()
		var opened = [(NodeIdentity, NavigationContext)]()

		XCTAssertTrue(model.openRelation(similar, kind: "similar_artists") { opened.append(($0, $1)) })
		XCTAssertTrue(model.openRelation(collaborator, kind: "collaborators") { opened.append(($0, $1)) })

		XCTAssertEqual(events.values.map(\.name), [.relationOpened, .relationOpened])
		XCTAssertTrue(events.values.allSatisfy(AnalyticsValidation.accepts))
		let kinds = events.values.map { $0.properties["relation_kind"] }
		XCTAssertEqual(kinds, [.string("similar_artists"), .string("collaborators")])
		// Same properties but the target and the kind: the similar chip is not a special case.
		var similarProperties = try XCTUnwrap(events.values.first?.properties)
		var collaboratorProperties = try XCTUnwrap(events.values.last?.properties)
		for key in ["node_id", "relation_kind"] {
			similarProperties[key] = nil
			collaboratorProperties[key] = nil
		}
		XCTAssertEqual(similarProperties, collaboratorProperties)
		XCTAssertEqual(opened.map(\.0), [similar.slug, collaborator.slug])
		XCTAssertEqual(opened.map(\.1), [context.followingRelation(), context.followingRelation()])
	}

	// A similar artist the cache has no page for is a plain edge: the chip navigates to its identity and the
	// node screen asks for it, which is what makes the server generate the page. Nothing here is special-cased.
	func testASimilarArtistWithoutACachedPageStillNavigatesToItsIdentity() async throws {
		let model = try await Self.loadedModel(context: .independent(source: .home), log: EventLog())
		let pending = try Self.edge("artist:not-generated-yet", name: "Not Generated Yet")
		var opened = [NodeIdentity]()

		let accepted = model.openRelation(pending, kind: "similar_artists") { identity, _ in opened.append(identity)
		}

		XCTAssertTrue(accepted)
		XCTAssertEqual(opened.map(\.rawValue), ["artist:not-generated-yet"])
	}

	func testADoubleTouchInsideTheWindowNeitherRecordsNorNavigatesTwice() async throws {
		let events = EventLog()
		let model = try await Self.loadedModel(context: .independent(source: .home), log: events)
		let edge = try Self.edge("track:target", name: "Target")
		events.values.removeAll()
		let start = Date(timeIntervalSince1970: 1_000)
		var navigations = 0

		for offset in [0.0, 0.2, 0.5] {
			model.openRelation(edge, kind: "tracklist", at: start.addingTimeInterval(offset)) { _, _ in
				navigations += 1
			}
		}

		XCTAssertEqual(events.values.map(\.name), [.relationOpened])
		XCTAssertEqual(navigations, 1)
	}

	func testAnotherSectionIsNotGatedButTheSameOneIsUntilTheWindowPasses() async throws {
		let events = EventLog()
		let model = try await Self.loadedModel(context: .independent(source: .home), log: events)
		let edge = try Self.edge("genre:target", name: "Target")
		events.values.removeAll()
		let start = Date(timeIntervalSince1970: 1_000)

		model.openRelation(edge, kind: "genres", at: start) { _, _ in }
		model.openRelation(edge, kind: "related_genres", at: start.addingTimeInterval(0.1)) { _, _ in }
		model.openRelation(edge, kind: "genres", at: start.addingTimeInterval(0.8)) { _, _ in }

		XCTAssertEqual(events.values.count, 3)
	}

	// Moved from the deleted `NodeRelationsTests` (it tested the view's twin of the gate): the window itself.
	func testTheGateRefusesTheSameKeyInsideThePointSevenFiveSecondsWindowOnly() {
		let start = Date(timeIntervalSince1970: 1_000)
		var quick = RelationOpeningGate()
		XCTAssertTrue(quick.shouldOpen(key: "projects-project:target", at: start))
		XCTAssertFalse(quick.shouldOpen(key: "projects-project:target", at: start.addingTimeInterval(0.5)))

		var slow = RelationOpeningGate()
		XCTAssertTrue(slow.shouldOpen(key: "projects-project:target", at: start))
		XCTAssertTrue(slow.shouldOpen(key: "projects-project:target", at: start.addingTimeInterval(0.8)))

		var other = RelationOpeningGate()
		XCTAssertTrue(other.shouldOpen(key: "projects-project:target", at: start))
		XCTAssertTrue(other.shouldOpen(key: "tracks-track:target", at: start.addingTimeInterval(0.1)))
	}

	func testTheGateMeasuresFromTheLastAcceptedTapNotFromARefusedOne() {
		let start = Date(timeIntervalSince1970: 1_000)
		var gate = RelationOpeningGate()
		XCTAssertTrue(gate.shouldOpen(key: "genres-genre:a", at: start))
		XCTAssertFalse(gate.shouldOpen(key: "genres-genre:a", at: start.addingTimeInterval(0.5)))
		XCTAssertTrue(gate.shouldOpen(key: "genres-genre:a", at: start.addingTimeInterval(0.8)))
	}

	@MainActor
	private final class EventLog {
		var values = [AnalyticsEvent]()
	}

	private static func loadedModel(
		context: NavigationContext, log: EventLog, id: String = "artist:source", name: String = "Source",
		edges: String = "{}"
	) async throws -> NodeViewModel {
		let type = id.prefix { $0 != ":" }
		let source = """
			{"node":{"id":"\(id)","type":"\(type)","name":"\(name)","teaser":null,"article":"","citations":[],"facts":{},"edges":\(edges),"materialized_at":"2026-10-08T00:00:00Z","image_url":null},"source":"cache"}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		let response = try decoder.decode(NodeResponse.self, from: Data(source.utf8))
		let model = NodeViewModel(
			identity: try XCTUnwrap(NodeIdentity(rawValue: id)),
			context: context,
			readNode: { _ in .success(response, etag: nil) },
			recordEvent: { log.values.append($0) }
		)
		await model.load()
		return model
	}

	private static func edge(
		_ slug: String, name: String, artist: String? = nil, mbid: String? = nil
	) throws -> NodeEdge {
		let type = slug.prefix { $0 != ":" }
		let artistField = artist.map { #","artist":"\#($0)""# } ?? ""
		let mbidField = mbid.map { #","mbid":"\#($0)""# } ?? ""
		let source =
			#"{"slug":"\#(slug)","type":"\#(type)","name":"\#(name)","qid":null,"year":null,"releaseType":null\#(artistField)\#(mbidField)}"#
		return try JSONDecoder().decode(NodeEdge.self, from: Data(source.utf8))
	}

	// MARK: generation context (TRA-482)

	func testAWorkChipOfAnArtistPageAsksForAGenerationCarryingTheArtistAndTheSection() async throws {
		let model = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "artist:rohff", name: "Rohff")
		let chip = try Self.edge(
			"track:fitna--rohff", name: "Fitna", artist: "Rohff", mbid: "11111111-1111-4111-8111-111111111111")
		let requestID = UUID()

		let request = try XCTUnwrap(
			model.generationRequest(for: chip, kind: "notable_tracks", requestID: requestID))

		XCTAssertEqual(
			request,
			GenerationRequest(
				requestID: requestID, type: .track, name: "Fitna", slug: chip.slug, mbid: chip.mbid, qid: nil,
				disambiguator: nil, artist: "Rohff",
				source: GenerationSource(
					slug: try XCTUnwrap(NodeIdentity(rawValue: "artist:rohff")), field: "notable_tracks")))
	}

	func testTheEdgeArtistWinsOverTheNameOfTheArtistPageItSitsOn() async throws {
		// A featured credit: the project sits on Rohff's page but is credited to someone else.
		let model = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "artist:rohff", name: "Rohff")
		let chip = try Self.edge("project:a-collab--other-artist", name: "A Collab", artist: "Other Artist")

		let request = try XCTUnwrap(model.generationRequest(for: chip, kind: "discography"))

		XCTAssertEqual(request.artist, "Other Artist")
		XCTAssertEqual(request.source?.field, "discography")
	}

	func testAWorkChipWithoutEdgeArtistFallsBackToTheNameOfTheArtistPage() async throws {
		let model = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "artist:rohff", name: "Rohff")
		let missing = try Self.edge("project:old-node", name: "Old Node")
		let blank = try Self.edge("project:blank", name: "Blank", artist: "  ")

		XCTAssertEqual(model.generationRequest(for: missing, kind: "discography")?.artist, "Rohff")
		XCTAssertEqual(model.generationRequest(for: blank, kind: "discography")?.artist, "Rohff")
	}

	// TRA-482 review: a tracklist chip cached before TRA-477 has no `artist`, and the slug is not scoped; the
	// server then refuses the work ("needs an artist, an mbid or a scoped slug") once scoped slugs are on.
	func testATracklistChipWithoutEdgeArtistSendsTheFirstCreditOfTheProjectNotItsName() async throws {
		let model = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "project:mezzanine--massive-attack",
			name: "Mezzanine",
			edges: #"{"artists":[{"slug":"artist:massive-attack","type":"artist","name":"Massive Attack"}]}"#)
		let chip = try Self.edge("track:teardrop", name: "Teardrop")

		let request = try XCTUnwrap(model.generationRequest(for: chip, kind: "tracklist"))

		XCTAssertEqual(request.artist, "Massive Attack")
		XCTAssertEqual(request.source?.slug.rawValue, "project:mezzanine--massive-attack")
		XCTAssertEqual(request.source?.field, "tracklist")
	}

	func testAProjectWithASingleOrBlankFirstCreditStillGivesItsArtist() async throws {
		let single = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "project:mezzanine--massive-attack",
			name: "Mezzanine",
			edges: #"{"artists":{"slug":"artist:massive-attack","type":"artist","name":"Massive Attack"}}"#)
		let blankFirst = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "project:mezzanine--massive-attack",
			name: "Mezzanine",
			edges: #"{"artists":[{"slug":"artist:blank","type":"artist","name":" "},{"slug":"artist:mad-professor","type":"artist","name":"Mad Professor"}]}"#
		)
		let chip = try Self.edge("track:teardrop", name: "Teardrop")

		XCTAssertEqual(single.generationRequest(for: chip, kind: "tracklist")?.artist, "Massive Attack")
		XCTAssertEqual(blankFirst.generationRequest(for: chip, kind: "tracklist")?.artist, "Mad Professor")
	}

	func testAProjectWithoutCreditFallsBackToTheScopeOfItsSlugLikeTheServer() async throws {
		let model = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "project:mezzanine--massive-attack",
			name: "Mezzanine")
		let chip = try Self.edge("track:teardrop", name: "Teardrop")

		XCTAssertEqual(model.generationRequest(for: chip, kind: "tracklist")?.artist, "massive attack")
	}

	func testAProjectWithNeitherCreditNorScopeSendsNoArtistRatherThanTheProjectName() async throws {
		let model = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "project:mezzanine", name: "Mezzanine")
		let chip = try Self.edge("track:teardrop", name: "Teardrop")

		XCTAssertNil(model.generationRequest(for: chip, kind: "tracklist")?.artist)
	}

	// `related_projects` lists works of other artists: the project's artist would attach them to the wrong one.
	func testOtherSectionsOfAProjectPageAndTrackPagesGetNoPageArtist() async throws {
		let project = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "project:mezzanine--massive-attack",
			name: "Mezzanine",
			edges: #"{"artists":[{"slug":"artist:massive-attack","type":"artist","name":"Massive Attack"}]}"#)
		let track = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "track:teardrop--massive-attack",
			name: "Teardrop",
			edges: #"{"artists":[{"slug":"artist:massive-attack","type":"artist","name":"Massive Attack"}]}"#)

		let related = try Self.edge("project:other", name: "Other")
		XCTAssertNil(project.generationRequest(for: related, kind: "related_projects")?.artist)
		let sampled = try Self.edge("track:sampled", name: "Sampled")
		XCTAssertNil(track.generationRequest(for: sampled, kind: "samples")?.artist)
	}

	func testTheEdgeArtistStillWinsOverTheProjectCredit() async throws {
		let model = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "project:mezzanine--massive-attack",
			name: "Mezzanine",
			edges: #"{"artists":[{"slug":"artist:massive-attack","type":"artist","name":"Massive Attack"}]}"#)
		let chip = try Self.edge("track:guest--someone", name: "Guest", artist: "Someone")

		XCTAssertEqual(model.generationRequest(for: chip, kind: "tracklist")?.artist, "Someone")
	}

	func testGenreLabelAndArtistChipsCarryTheSourceButNoArtist() async throws {
		let model = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "artist:rohff", name: "Rohff")

		for (slug, kind) in [
			("genre:rap", "genres"), ("label:def-jam", "labels"), ("artist:similar-one", "similar_artists"),
		] {
			let request = try XCTUnwrap(
				model.generationRequest(for: try Self.edge(slug, name: "Name", artist: "Ignored"), kind: kind))
			XCTAssertNil(request.artist, slug)
			XCTAssertEqual(
				request.source, GenerationSource(slug: try XCTUnwrap(NodeIdentity(rawValue: "artist:rohff")), field: kind)
			)
		}
	}

	func testASectionThatIsNotAnEdgeFieldOfTheNodeTypeIsNotSentAsSource() async throws {
		let model = try await Self.loadedModel(
			context: .independent(source: .home), log: EventLog(), id: "artist:rohff", name: "Rohff")
		let chip = try Self.edge("project:x--rohff", name: "X", artist: "Rohff")

		// The server refuses an unknown field with invalid_request; the artist alone is enough to scope the work.
		let request = try XCTUnwrap(model.generationRequest(for: chip, kind: "highlights"))

		XCTAssertNil(request.source)
		XCTAssertEqual(request.artist, "Rohff")
		// The landmark album and the reference track are real edge fields of an artist.
		XCTAssertEqual(
			model.generationRequest(for: chip, kind: "landmark_project")?.source?.field, "landmark_project")
	}

	func testNoGenerationIsBuiltBeforeTheNodeIsLoaded() throws {
		let model = NodeViewModel(
			identity: try XCTUnwrap(NodeIdentity(rawValue: "artist:rohff")), context: .independent(source: .home),
			readNode: { _ in .failure(.invalidResponse) })
		XCTAssertNil(
			model.generationRequest(for: try Self.edge("track:x--rohff", name: "X"), kind: "notable_tracks"))
	}
}
