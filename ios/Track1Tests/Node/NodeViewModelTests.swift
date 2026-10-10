import XCTest

@testable import Track1

@MainActor
final class NodeViewModelTests: XCTestCase {
	func testLoadsFiveTypesWithPartialDataAndTracksEachCanonicalIdentityOnce() async throws {
		for type in NodeType.allCases {
			let identity = try XCTUnwrap(NodeIdentity(rawValue: "\(type.rawValue):sample-node"))
			let response = try Self.nodeResponse(type: type, id: identity)
			var events = [AnalyticsEvent]()
			let model = NodeViewModel(
				identity: identity,
				context: .independent(source: .home),
				readNode: { _ in .success(response, etag: nil) },
				recordEvent: { events.append($0) }
			)

			await model.load()
			await model.load()

			guard case .loaded(let node) = model.state else {
				return XCTFail("Expected a loaded \(type.rawValue) node.")
			}
			XCTAssertEqual(node.type, type)
			XCTAssertEqual(node.name, "Sample")
			XCTAssertEqual(events.map(\.name), [.nodeViewed])
			XCTAssertEqual(events.first?.properties["node_id"], .string(identity.rawValue))
			XCTAssertEqual(events.first?.properties["node_type"], .string(type.rawValue))
			XCTAssertTrue(events.allSatisfy(AnalyticsValidation.accepts))
		}
	}

	func testAliasKeepsContextAndTracksTheCanonicalIdentity() async throws {
		let requested = try XCTUnwrap(NodeIdentity(rawValue: "artist:old-name"))
		let canonical = try XCTUnwrap(NodeIdentity(rawValue: "artist:canonical-name"))
		let notificationID = try XCTUnwrap(UUID(uuidString: "11111111-1111-4111-8111-111111111111"))
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let response = try Self.nodeResponse(type: .artist, id: canonical)
		var events = [AnalyticsEvent]()
		let model = NodeViewModel(
			identity: requested,
			context: NavigationContext(
				source: .notification,
				recommendationID: recommendationID,
				notificationID: notificationID
			),
			readNode: { _ in .success(response, etag: nil) },
			recordEvent: { events.append($0) }
		)

		await model.load()

		XCTAssertEqual(model.requestedIdentity, canonical)
		XCTAssertEqual(events.count, 1)
		XCTAssertEqual(events.first?.source, .notification)
		XCTAssertEqual(events.first?.properties["node_id"], .string(canonical.rawValue))
		XCTAssertEqual(events.first?.properties["notification_id"], .string(notificationID.uuidString.lowercased()))
		XCTAssertEqual(
			events.first?.properties["recommendation_id"],
			.string(recommendationID.uuidString.lowercased())
		)
		XCTAssertTrue(events.allSatisfy(AnalyticsValidation.accepts))
	}

	func testNotFoundIsMissingAndKeepsTheRequestedIdentity() async throws {
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "genre:missing"))
		var events = [AnalyticsEvent]()
		let model = NodeViewModel(
			identity: identity,
			context: .independent(source: .search),
			readNode: { _ in
				.failure(.http(status: 404, code: "not_found", retryable: false, retryAfterSeconds: nil))
			},
			recordEvent: { events.append($0) }
		)

		await model.load()

		guard case .missing(let received) = model.state else { return XCTFail("Expected the missing state.") }
		XCTAssertEqual(received, identity)
		XCTAssertTrue(events.isEmpty)
	}

	func testEveryOtherFailureIsFailedAndNeverRecordsAnEvent() async throws {
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "genre:unavailable"))
		let results: [APIResult<NodeResponse>] = [
			.failure(.network),
			.failure(.http(status: 503, code: nil, retryable: true, retryAfterSeconds: nil)),
			.notModified(etag: "etag"),
			.failure(.invalidResponse),
		]

		for result in results {
			var events = [AnalyticsEvent]()
			let model = NodeViewModel(
				identity: identity,
				context: .independent(source: .search),
				readNode: { _ in result },
				recordEvent: { events.append($0) }
			)

			await model.load()

			guard case .failed = model.state else { return XCTFail("Expected the failed state for \(result).") }
			XCTAssertEqual(model.requestedIdentity, identity)
			XCTAssertTrue(events.isEmpty)
		}
	}

	func testCancelledRequestDoesNotPublishAResponseOrAnEventAfterTheViewLeaves() async throws {
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "artist:cancelled"))
		let response = try Self.nodeResponse(type: .artist, id: identity)
		var events = [AnalyticsEvent]()
		let model = NodeViewModel(
			identity: identity,
			context: .independent(source: .home),
			readNode: { _ in
				try? await Task.sleep(for: .milliseconds(50))
				return .success(response, etag: nil)
			},
			recordEvent: { events.append($0) }
		)

		let task = Task { await model.load() }
		await Task.yield()
		task.cancel()
		await task.value

		guard case .loading = model.state else { return XCTFail("A cancelled load must not update the view.") }
		XCTAssertTrue(events.isEmpty)
	}

	func testFollowingARelationKeepsBothIdentifiersAndOnlyChangesTheSource() throws {
		let recommendationID = try XCTUnwrap(UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
		let notificationID = try XCTUnwrap(UUID(uuidString: "33333333-3333-4333-8333-333333333333"))
		let context = NavigationContext(
			source: .home,
			recommendationID: recommendationID,
			notificationID: notificationID
		)

		let relation = context.followingRelation()

		XCTAssertEqual(relation.source, .relation)
		XCTAssertEqual(relation.recommendationID, recommendationID)
		XCTAssertEqual(relation.notificationID, notificationID)
	}

	func testIndependentContextCarriesNoAttribution() {
		let context = NavigationContext.independent(source: .search)

		XCTAssertEqual(context.source, .search)
		XCTAssertNil(context.recommendationID)
		XCTAssertNil(context.notificationID)
		XCTAssertTrue(context.attributionProperties.isEmpty)
	}

	func testAttributionPropertiesOnlyEmitPresentKeysWithLowercaseUUIDs() throws {
		let recommendationID = try XCTUnwrap(UUID(uuidString: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"))
		let notificationID = try XCTUnwrap(UUID(uuidString: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"))

		XCTAssertEqual(
			NavigationContext(source: .home, recommendationID: recommendationID).attributionProperties,
			["recommendation_id": .string("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")]
		)
		XCTAssertEqual(
			NavigationContext(source: .notification, notificationID: notificationID).attributionProperties,
			["notification_id": .string("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")]
		)
		XCTAssertEqual(
			NavigationContext(
				source: .notification,
				recommendationID: recommendationID,
				notificationID: notificationID
			).attributionProperties,
			[
				"recommendation_id": .string("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
				"notification_id": .string("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
			]
		)
	}

	private static func nodeResponse(type: NodeType, id: NodeIdentity) throws -> NodeResponse {
		let source = """
			{"node":{"id":"\(id.rawValue)","type":"\(type.rawValue)","name":"Sample","teaser":null,"article":"Article","citations":[],"facts":{},"edges":{},"materialized_at":"2026-10-08T00:00:00Z","image_url":null},"source":"cache"}
			"""
		return try JSONDecoder.track1.decode(NodeResponse.self, from: Data(source.utf8))
	}
}

extension JSONDecoder {
	fileprivate static var track1: JSONDecoder {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return decoder
	}
}
