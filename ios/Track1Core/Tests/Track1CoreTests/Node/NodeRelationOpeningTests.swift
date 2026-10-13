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

	@MainActor
	private final class EventLog {
		var values = [AnalyticsEvent]()
	}

	private static func loadedModel(context: NavigationContext, log: EventLog) async throws -> NodeViewModel {
		let source = """
			{"node":{"id":"artist:source","type":"artist","name":"Source","teaser":null,"article":"","citations":[],"facts":{},"edges":{},"materialized_at":"2026-10-08T00:00:00Z","image_url":null},"source":"cache"}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		let response = try decoder.decode(NodeResponse.self, from: Data(source.utf8))
		let model = NodeViewModel(
			identity: try XCTUnwrap(NodeIdentity(rawValue: "artist:source")),
			context: context,
			readNode: { _ in .success(response, etag: nil) },
			recordEvent: { log.values.append($0) }
		)
		await model.load()
		return model
	}

	private static func edge(_ slug: String, name: String) throws -> NodeEdge {
		let type = slug.prefix { $0 != ":" }
		let source =
			#"{"slug":"\#(slug)","type":"\#(type)","name":"\#(name)","mbid":null,"qid":null,"year":null,"releaseType":null}"#
		return try JSONDecoder().decode(NodeEdge.self, from: Data(source.utf8))
	}
}
