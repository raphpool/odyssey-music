import Foundation
import Observation

enum NodeViewState: Sendable {
	case loading
	case loaded(NodeDetail)
	case missing(NodeIdentity)
	case failed
}

typealias NodeReader = @Sendable (NodeIdentity) async -> APIResult<NodeResponse>
typealias NodeEventRecorder = @MainActor @Sendable (AnalyticsEvent) -> Void

@MainActor
@Observable
final class NodeViewModel {
	private(set) var requestedIdentity: NodeIdentity
	private(set) var state: NodeViewState = .loading

	let context: NavigationContext
	private let readNode: NodeReader
	private let recordEvent: NodeEventRecorder?
	private var trackedIdentities = Set<NodeIdentity>()

	init(
		identity: NodeIdentity,
		context: NavigationContext,
		readNode: @escaping NodeReader,
		recordEvent: NodeEventRecorder? = nil
	) {
		requestedIdentity = identity
		self.context = context
		self.readNode = readNode
		self.recordEvent = recordEvent
	}

	/// Handed to the relations section so it records `relation_opened` through the same recorder as
	/// `node_viewed`.
	var relationEventRecorder: NodeEventRecorder? { recordEvent }

	func load() async {
		let identity = requestedIdentity
		state = .loading

		switch await readNode(identity) {
		case .success(let response, _):
			guard !Task.isCancelled else { return }
			requestedIdentity = response.node.id
			state = .loaded(response.node)
			recordViewedNode(response.node)
		case .failure(let error):
			guard !Task.isCancelled else { return }
			if case .http(let status, _, _, _) = error, status == 404 {
				state = .missing(identity)
			} else {
				state = .failed
			}
		case .notModified:
			guard !Task.isCancelled else { return }
			state = .failed
		}
	}

	private func recordViewedNode(_ node: NodeDetail) {
		guard trackedIdentities.insert(node.id).inserted else { return }
		recordEvent?(NodeAnalytics.nodeViewed(node, context: context))
	}
}

enum NodeAnalytics {
	static func nodeViewed(_ node: NodeDetail, context: NavigationContext) -> AnalyticsEvent {
		var properties: [String: AnalyticsValue] = [
			"node_id": .string(node.id.rawValue),
			"node_type": .string(node.type.rawValue),
		]
		for (key, value) in context.attributionProperties { properties[key] = value }
		return AnalyticsEvent(name: .nodeViewed, properties: properties, source: context.source)
	}

	static func relationOpened(
		from fromNodeID: NodeIdentity,
		relation: NodeEdge,
		kind: String,
		context: NavigationContext
	) -> AnalyticsEvent {
		var properties: [String: AnalyticsValue] = [
			"from_node_id": .string(fromNodeID.rawValue),
			"node_id": .string(relation.slug.rawValue),
			"node_type": .string(relation.type.rawValue),
			"relation_kind": .string(kind),
		]
		for (key, value) in context.attributionProperties { properties[key] = value }
		return AnalyticsEvent(name: .relationOpened, properties: properties, source: .relation)
	}
}
