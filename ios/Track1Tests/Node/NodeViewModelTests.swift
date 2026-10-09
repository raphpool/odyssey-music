import XCTest

@testable import Track1

@MainActor
final class NodeViewModelTests: XCTestCase {
	func testLoadsFiveTypesWithPartialDataAndTracksEachCanonicalIdentityOnce() async throws {
		for type in NodeType.allCases {
			let identity = try XCTUnwrap(NodeIdentity(rawValue: "\(type.rawValue):sample-node"))
			let response = try Self.nodeResponse(type: type, id: identity)
			let image = try Self.imageResponse(identity: identity, imageURL: nil)
			var events = [AnalyticsEvent]()
			let model = NodeViewModel(
				identity: identity,
				context: .independent(source: .home),
				readNode: { _ in .success(response, etag: nil) },
				readImage: { _ in .success(image, etag: nil) },
				recordEvent: { events.append($0) }
			)

			await model.load()
			await model.load()

			guard case .loaded(let node) = model.state else {
				return XCTFail("Expected a loaded \(type.rawValue) node.")
			}
			XCTAssertEqual(node.type, type)
			XCTAssertEqual(node.name, "Sample")
			XCTAssertEqual(model.imageState, .unavailable)
			XCTAssertEqual(events.map(\.name), [.nodeViewed])
		}
	}

	func testAliasKeepsContextAndTracksTheCanonicalIdentity() async throws {
		let requested = try XCTUnwrap(NodeIdentity(rawValue: "artist:old-name"))
		let canonical = try XCTUnwrap(NodeIdentity(rawValue: "artist:canonical-name"))
		let notificationID = try XCTUnwrap(UUID(uuidString: "11111111-1111-4111-8111-111111111111"))
		let response = try Self.nodeResponse(type: .artist, id: canonical)
		let image = try Self.imageResponse(identity: canonical, imageURL: nil)
		var events = [AnalyticsEvent]()
		let model = NodeViewModel(
			identity: requested,
			context: NavigationContext(source: .notification, notificationID: notificationID),
			readNode: { _ in .success(response, etag: nil) },
			readImage: { _ in .success(image, etag: nil) },
			recordEvent: { events.append($0) }
		)

		await model.load()

		XCTAssertEqual(model.requestedIdentity, canonical)
		XCTAssertEqual(events.first?.source, .notification)
		XCTAssertEqual(events.first?.properties["node_id"], .string(canonical.rawValue))
		XCTAssertEqual(events.first?.properties["notification_id"], .string(notificationID.uuidString.lowercased()))
	}

	func testMissingAndFailureStatesRemainDistinctAndNeverCreateContent() async throws {
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "genre:missing"))
		let missing = NodeViewModel(
			identity: identity,
			context: .independent(source: .search),
			readNode: { _ in .failure(.http(status: 404, code: "not_found", retryable: false, retryAfterSeconds: nil))
			},
			readImage: { _ in .failure(.network) }
		)
		await missing.load()
		guard case .missing(let received) = missing.state else { return XCTFail("Expected the missing state.") }
		XCTAssertEqual(received, identity)

		let failed = NodeViewModel(
			identity: identity,
			context: .independent(source: .search),
			readNode: { _ in .failure(.network) },
			readImage: { _ in .failure(.network) }
		)
		await failed.load()
		guard case .failed = failed.state else { return XCTFail("Expected the failed state.") }
	}

	func testCancelledRequestDoesNotPublishAResponseAfterTheViewLeaves() async throws {
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "artist:cancelled"))
		let response = try Self.nodeResponse(type: .artist, id: identity)
		let image = try Self.imageResponse(identity: identity, imageURL: nil)
		let model = NodeViewModel(
			identity: identity,
			context: .independent(source: .home),
			readNode: { _ in
				try? await Task.sleep(for: .milliseconds(50))
				return .success(response, etag: nil)
			},
			readImage: { _ in .success(image, etag: nil) }
		)

		let task = Task { await model.load() }
		await Task.yield()
		task.cancel()
		await task.value

		guard case .loading = model.state else { return XCTFail("A cancelled load must not update the view.") }
	}

	func testArticleParsingKeepsUntrustedMarkupAsTextAndSeparatesLists() {
		XCTAssertEqual(
			NodeArticleParser.blocks(from: "Introduction.\n\n- First\n2) Second\n\n<script>not executed</script>"),
			[.paragraph("Introduction."), .list(["First", "Second"]), .paragraph("<script>not executed</script>")]
		)
	}

	func testUnsafeCitationURLIsRejectedBeforeTheNativeArticleViewReceivesIt() {
		let source = """
			{"node":{"id":"artist:unsafe","type":"artist","name":"Unsafe","teaser":null,"article":"Article","citations":[{"url":"javascript:alert(1)"}],"facts":{},"edges":{},"materialized_at":"2026-10-08T00:00:00Z","image_url":null},"source":"cache"}
			"""
		XCTAssertThrowsError(try JSONDecoder.track1.decode(NodeResponse.self, from: Data(source.utf8)))
	}

	func testNavigationContextPreservesAttributionOnlyAcrossRelations() throws {
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let context = NavigationContext(source: .home, recommendationID: recommendationID)
		let relation = context.followingRelation()
		XCTAssertEqual(relation.source, .relation)
		XCTAssertEqual(relation.recommendationID, recommendationID)
		XCTAssertEqual(NavigationContext.independent(source: .search).recommendationID, nil)
	}

	func testRelationEventUsesTheRelationSourceAndPreservesAttribution() throws {
		let from = try XCTUnwrap(NodeIdentity(rawValue: "artist:source"))
		let target = try XCTUnwrap(NodeIdentity(rawValue: "project:target"))
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let edge = try Self.edge(slug: target)

		let event = NodeAnalytics.relationOpened(
			from: from,
			relation: edge,
			kind: "projects",
			context: NavigationContext(source: .home, recommendationID: recommendationID)
		)

		XCTAssertEqual(event.name, .relationOpened)
		XCTAssertEqual(event.source, .relation)
		XCTAssertEqual(event.properties["from_node_id"], .string(from.rawValue))
		XCTAssertEqual(event.properties["node_id"], .string(target.rawValue))
		XCTAssertEqual(event.properties["recommendation_id"], .string(recommendationID.uuidString.lowercased()))
		XCTAssertTrue(AnalyticsValidation.accepts(event))
	}

	private static func nodeResponse(type: NodeType, id: NodeIdentity) throws -> NodeResponse {
		let source = """
			{"node":{"id":"\(id.rawValue)","type":"\(type.rawValue)","name":"Sample","teaser":null,"article":"Article","citations":[],"facts":{},"edges":{},"materialized_at":"2026-10-08T00:00:00Z","image_url":null},"source":"cache"}
			"""
		return try JSONDecoder.track1.decode(NodeResponse.self, from: Data(source.utf8))
	}

	private static func imageResponse(identity: NodeIdentity, imageURL: String?) throws -> ImageResponse {
		let encodedURL = imageURL.map { "\"\($0)\"" } ?? "null"
		let source = "{\"slug\":\"\(identity.rawValue)\",\"image_url\":\(encodedURL),\"source\":\"cache\"}"
		return try JSONDecoder.track1.decode(ImageResponse.self, from: Data(source.utf8))
	}

	private static func edge(slug: NodeIdentity) throws -> NodeEdge {
		let source =
			"{\"slug\":\"\(slug.rawValue)\",\"type\":\"project\",\"name\":\"Target\",\"mbid\":null,\"qid\":null,\"year\":null,\"releaseType\":null}"
		return try JSONDecoder.track1.decode(NodeEdge.self, from: Data(source.utf8))
	}
}

extension JSONDecoder {
	fileprivate static var track1: JSONDecoder {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return decoder
	}
}
