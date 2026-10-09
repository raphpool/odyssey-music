import Foundation
import Observation

enum NodeViewState: Sendable {
	case loading
	case loaded(NodeDetail)
	case missing(NodeIdentity)
	case failed
}

enum NodeImageState: Equatable, Sendable {
	case loading
	case available(URL)
	case unavailable
}

typealias NodeReader = @Sendable (NodeIdentity) async -> APIResult<NodeResponse>
typealias NodeImageReader = @Sendable (NodeIdentity) async -> APIResult<ImageResponse>
typealias NodeEventRecorder = @MainActor @Sendable (AnalyticsEvent) -> Void

@MainActor
@Observable
final class NodeViewModel {
	private(set) var requestedIdentity: NodeIdentity
	private(set) var state: NodeViewState = .loading
	private(set) var imageState: NodeImageState = .loading

	let context: NavigationContext
	private let readNode: NodeReader
	private let readImage: NodeImageReader
	private let recordEvent: NodeEventRecorder?
	private var trackedIdentities = Set<NodeIdentity>()

	init(
		identity: NodeIdentity,
		context: NavigationContext,
		readNode: @escaping NodeReader,
		readImage: @escaping NodeImageReader,
		recordEvent: NodeEventRecorder? = nil
	) {
		requestedIdentity = identity
		self.context = context
		self.readNode = readNode
		self.readImage = readImage
		self.recordEvent = recordEvent
	}

	var relationEventRecorder: NodeEventRecorder? { recordEvent }

	func load() async {
		let identity = requestedIdentity
		state = .loading
		imageState = .loading

		switch await readNode(identity) {
		case .success(let response, _):
			guard !Task.isCancelled else { return }
			requestedIdentity = response.node.id
			state = .loaded(response.node)
			recordViewedNode(response.node)
			await loadImage(for: response.node)
		case .failure(let error):
			guard !Task.isCancelled else { return }
			if case .http(let status, _, _, _) = error, status == 404 {
				state = .missing(identity)
			} else {
				state = .failed
			}
			imageState = .unavailable
		case .notModified:
			guard !Task.isCancelled else { return }
			state = .failed
			imageState = .unavailable
		}
	}

	private func loadImage(for node: NodeDetail) async {
		if let imageURL = node.imageURL {
			imageState = .available(imageURL)
		}

		switch await readImage(node.id) {
		case .success(let response, _):
			guard !Task.isCancelled, requestedIdentity == node.id else { return }
			if response.slug == node.id, let imageURL = response.imageURL ?? node.imageURL {
				imageState = .available(imageURL)
			} else {
				imageState = .unavailable
			}
		case .failure, .notModified:
			guard !Task.isCancelled, requestedIdentity == node.id else { return }
			if node.imageURL == nil { imageState = .unavailable }
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
