import Track1Core
import XCTest

@testable import Track1

@MainActor
final class NodeRelationsTests: XCTestCase {
	func testGroupsOmitEmptyOnesSortByKindAndTreatOneLikeMany() throws {
		let trackOne = try Self.edge("track:one")
		let trackTwo = try Self.edge("track:two")
		let solo = try Self.edge("artist:solo")
		let tripHop = try Self.edge("genre:trip-hop")
		let edges: [String: NodeEdgeValue] = [
			"tracks": .many([trackOne, trackTwo]),
			"artists": .one(solo),
			"labels": .many([]),
			"genres": .many([tripHop]),
		]

		let groups = NodeRelationGroup.groups(from: edges)

		XCTAssertEqual(groups.map(\.kind), ["artists", "genres", "tracks"])
		XCTAssertEqual(
			groups.map { $0.relations.map(\.slug.rawValue) },
			[["artist:solo"], ["genre:trip-hop"], ["track:one", "track:two"]])
		XCTAssertEqual(
			NodeRelationGroup.groups(from: edges).map(\.kind), groups.map(\.kind),
			"The order must not change between two calls.")
		XCTAssertTrue(NodeRelationGroup.groups(from: [:]).isEmpty)
	}

	func testLabelsAreTheExactFrenchOnesAndUnknownKindsFallBackToASpacedKey() throws {
		let edge = try Self.edge("artist:sample")
		let kinds = [
			"artists": "Artistes", "projects": "Projets", "tracks": "Titres", "genres": "Genres", "labels": "Labels",
			"related_artists": "related artists", "sub-genres": "sub genres", "mixed_kind-name": "mixed kind name",
		]
		var edges = [String: NodeEdgeValue]()
		for kind in kinds.keys { edges[kind] = .one(edge) }
		let groups = NodeRelationGroup.groups(from: edges)

		XCTAssertEqual(groups.count, kinds.count)
		for group in groups {
			XCTAssertEqual(group.label, kinds[group.kind], group.kind)
		}
	}

	func testRelationEventHasTheFourRequiredKeysAndAttributionOnlyWhenItExists() throws {
		let from = try XCTUnwrap(NodeIdentity(rawValue: "artist:source"))
		let edge = try Self.edge("project:target")
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let notificationID = try XCTUnwrap(UUID(uuidString: "11111111-1111-4111-8111-111111111111"))

		let bare = NodeAnalytics.relationOpened(
			from: from, relation: edge, kind: "projects", context: .independent(source: .search))
		XCTAssertEqual(bare.name, .relationOpened)
		XCTAssertEqual(bare.source, .relation)
		XCTAssertEqual(
			bare.properties,
			[
				"from_node_id": .string("artist:source"),
				"node_id": .string("project:target"),
				"node_type": .string("project"),
				"relation_kind": .string("projects"),
			])
		XCTAssertTrue(AnalyticsValidation.accepts(bare))

		let recommended = NodeAnalytics.relationOpened(
			from: from, relation: edge, kind: "projects",
			context: NavigationContext(source: .home, recommendationID: recommendationID))
		XCTAssertEqual(
			recommended.properties["recommendation_id"], .string(recommendationID.uuidString.lowercased()))
		XCTAssertNil(recommended.properties["notification_id"])
		XCTAssertTrue(AnalyticsValidation.accepts(recommended))

		let notified = NodeAnalytics.relationOpened(
			from: from, relation: edge, kind: "projects",
			context: NavigationContext(
				source: .notification, recommendationID: recommendationID, notificationID: notificationID))
		XCTAssertEqual(notified.properties["notification_id"], .string(notificationID.uuidString.lowercased()))
		XCTAssertEqual(notified.properties.count, 6)
		XCTAssertTrue(AnalyticsValidation.accepts(notified))
	}

	func testTapGuardRefusesTheSameKeyInsideThePointSevenFiveSecondsWindowOnly() {
		let start = Date(timeIntervalSince1970: 1_000)
		var quick = RelationTapGuard()
		XCTAssertTrue(quick.shouldOpen(key: "projects-project:target", at: start))
		XCTAssertFalse(quick.shouldOpen(key: "projects-project:target", at: start.addingTimeInterval(0.5)))

		var slow = RelationTapGuard()
		XCTAssertTrue(slow.shouldOpen(key: "projects-project:target", at: start))
		XCTAssertTrue(slow.shouldOpen(key: "projects-project:target", at: start.addingTimeInterval(0.8)))

		var other = RelationTapGuard()
		XCTAssertTrue(other.shouldOpen(key: "projects-project:target", at: start))
		XCTAssertTrue(other.shouldOpen(key: "tracks-track:target", at: start.addingTimeInterval(0.1)))
	}

	func testTapGuardMeasuresFromTheLastAcceptedTapNotFromARefusedOne() {
		let start = Date(timeIntervalSince1970: 1_000)
		var tapGuard = RelationTapGuard()
		XCTAssertTrue(tapGuard.shouldOpen(key: "genres-genre:a", at: start))
		XCTAssertFalse(tapGuard.shouldOpen(key: "genres-genre:a", at: start.addingTimeInterval(0.5)))
		XCTAssertTrue(tapGuard.shouldOpen(key: "genres-genre:a", at: start.addingTimeInterval(0.8)))
	}

	func testOneGestureRecordsTheEventThenOpensTheRelationWithItsAttribution() throws {
		let from = try XCTUnwrap(NodeIdentity(rawValue: "artist:source"))
		let edge = try Self.edge("project:target")
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let context = NavigationContext(source: .home, recommendationID: recommendationID)
		let router = AppRouter()
		let steps = StepLog()
		var tapGuard = RelationTapGuard()
		let now = Date(timeIntervalSince1970: 1_000)

		for offset in [0.0, 0.2] {
			NodeRelationsView.open(
				edge, kind: "projects", from: from, context: context, tapGuard: &tapGuard,
				at: now.addingTimeInterval(offset),
				recordEvent: { steps.values.append($0.name.rawValue) },
				openDestination: { identity, relationContext in
					steps.values.append("open")
					router.openNode(identity, context: relationContext, in: .today)
				})
		}

		XCTAssertEqual(steps.values, ["relation_opened", "open"], "The repeated tap must do nothing.")
		XCTAssertEqual(
			router.path(for: .today),
			[
				.node(
					identity: edge.slug, context: NavigationContext(source: .relation, recommendationID: recommendationID))
			]
		)
	}

	func testRelationToAnAbsentNodeIsMissingWithASingleRequest() async throws {
		let from = try XCTUnwrap(NodeIdentity(rawValue: "artist:source"))
		let edge = try Self.edge("project:absent")
		let router = AppRouter()
		var tapGuard = RelationTapGuard()
		NodeRelationsView.open(
			edge, kind: "projects", from: from, context: .independent(source: .home), tapGuard: &tapGuard,
			at: .now, recordEvent: nil,
			openDestination: { identity, context in router.openNode(identity, context: context, in: .today) })

		guard case .node(let identity, let context)? = router.path(for: .today).last else {
			return XCTFail("Expected the relation to be pushed.")
		}
		let requests = RequestLog()
		var events = [AnalyticsEvent]()
		let model = NodeViewModel(
			identity: identity,
			context: context,
			readNode: { requested in
				await requests.record(requested)
				return .failure(.http(status: 404, code: "not_found", retryable: false, retryAfterSeconds: nil))
			},
			recordEvent: { events.append($0) }
		)

		await model.load()

		guard case .missing(let missing) = model.state else { return XCTFail("Expected the missing state.") }
		XCTAssertEqual(missing, edge.slug)
		let received = await requests.identities
		XCTAssertEqual(received, [edge.slug])
		XCTAssertTrue(events.isEmpty)
	}

	func testSubtitleJoinsYearAndReleaseTypeAndIsAbsentWhenBothAre() throws {
		XCTAssertNil(NodeRelationsView.subtitle(try Self.edge("project:a")))
		XCTAssertEqual(NodeRelationsView.subtitle(try Self.edge("project:a", year: "1994")), "1994")
		XCTAssertEqual(
			NodeRelationsView.subtitle(try Self.edge("project:a", year: "1994", releaseType: "album")), "1994 · album")
	}

	@MainActor
	private final class StepLog {
		var values = [String]()
	}

	private actor RequestLog {
		private(set) var identities = [NodeIdentity]()
		func record(_ identity: NodeIdentity) { identities.append(identity) }
	}

	private static func edge(_ slug: String, year: String? = nil, releaseType: String? = nil) throws -> NodeEdge
	{
		let type = slug.prefix { $0 != ":" }
		let source = """
			{"slug":"\(slug)","type":"\(type)","name":"Target","mbid":null,"qid":null,\
			"year":\(year.map { "\"\($0)\"" } ?? "null"),"releaseType":\(releaseType.map { "\"\($0)\"" } ?? "null")}
			"""
		return try JSONDecoder().decode(NodeEdge.self, from: Data(source.utf8))
	}
}
