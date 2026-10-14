import Foundation
import Observation

public enum NodeViewState: Sendable {
	case loading
	case loaded(NodeDetail)
	case missing(NodeIdentity)
	case failed
}

public typealias NodeReader = @Sendable (NodeIdentity) async -> APIResult<NodeResponse>
public typealias NodeEventRecorder = @MainActor @Sendable (AnalyticsEvent) -> Void
public typealias LinksReader = @Sendable (NodeIdentity) async -> APIResult<LinksResponse>

public enum ListeningState: Equatable, Sendable {
	case hidden
	case loading
	case ready([ListeningAction])
}

@MainActor
@Observable
public final class NodeViewModel {
	private(set) var requestedIdentity: NodeIdentity
	public private(set) var state: NodeViewState = .loading
	public private(set) var listening: ListeningState = .hidden
	/// True from the first accepted gesture until the OS answers, so the view can disable its buttons.
	public private(set) var isOpeningListening = false
	/// Provider whose last opening failed; cleared by the next gesture.
	public private(set) var listeningFailure: ListeningProvider?

	public let context: NavigationContext
	private let readNode: NodeReader
	private let readLinks: LinksReader?
	private let recordEvent: NodeEventRecorder?
	private var trackedIdentities = Set<NodeIdentity>()
	private var relationGate = RelationOpeningGate()

	public init(
		identity: NodeIdentity,
		context: NavigationContext,
		readNode: @escaping NodeReader,
		readLinks: LinksReader? = nil,
		recordEvent: NodeEventRecorder? = nil
	) {
		requestedIdentity = identity
		self.context = context
		self.readNode = readNode
		self.readLinks = readLinks
		self.recordEvent = recordEvent
	}

	/// One gesture on a related node: records `relation_opened`, then hands the target and its attribution to
	/// `navigate`. Does neither (returns false) for a repeat inside `RelationOpeningGate.window`. `kind` is the
	/// section of the relation (`discography`, `tracklist`, ...).
	@discardableResult
	public func openRelation(
		_ relation: NodeEdge,
		kind: String,
		at date: Date = .now,
		navigate: (NodeIdentity, NavigationContext) -> Void
	) -> Bool {
		guard case .loaded(let node) = state,
			relationGate.shouldOpen(key: "\(kind)-\(relation.slug.rawValue)", at: date)
		else { return false }
		recordEvent?(NodeAnalytics.relationOpened(from: node.id, relation: relation, kind: kind, context: context))
		navigate(relation.slug, context.followingRelation())
		return true
	}

	/// Loads the node. Idempotent once `.loaded`: SwiftUI restarts the view's `.task` each time the view
	/// reappears, and 2026-10-12 popping back from a related node swapped the `ScrollView` for a
	/// `ProgressView` (scroll position lost, `.failed` when offline). Only `.loading`, `.missing` and `.failed`
	/// (the "Réessayer" button) fetch again.
	public func load() async {
		if case .loaded(let node) = state {
			// A load cancelled while `/links` was in flight left the section at `.loading`; resolve only
			// that part. A `.ready` or `.hidden` section is final and stays as it is.
			if listening == .loading { await loadListening(for: node) }
			return
		}
		let identity = requestedIdentity
		state = .loading
		listening = .hidden
		listeningFailure = nil

		switch await readNode(identity) {
		case .success(let response, _):
			guard !Task.isCancelled else { return }
			requestedIdentity = response.node.id
			state = .loaded(response.node)
			recordViewedNode(response.node)
			await loadListening(for: response.node)
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

	/// Hands the action to the OS and records the outcome. A second gesture while one is in flight is
	/// dropped here: `ListeningActions.open` records one event per call, so only this guard keeps a double
	/// tap from opening the service twice.
	public func openListening(_ action: ListeningAction, using open: @MainActor (URL) async -> Bool) async {
		guard !isOpeningListening, case .loaded(let node) = state else { return }
		isOpeningListening = true
		listeningFailure = nil
		defer { isOpeningListening = false }
		let outcome = await ListeningActions.open(
			action, node: node.id, context: context, openURL: open, recordEvent: recordEvent)
		listeningFailure = outcome == .opened ? nil : action.provider
	}

	private func loadListening(for node: NodeDetail) async {
		// Search actions need no network: when even those are empty (genre, label, blank name) there is
		// nothing to resolve, so `/links` is never called.
		guard let readLinks,
			!ListeningActions.actions(for: node.type, name: node.name, links: nil).isEmpty
		else { return }

		listening = .loading
		var links: LinksResponse?
		if case .success(let response, _) = await readLinks(node.id) {
			// A response for another slug must not lend its exact links to this node; fall back to search.
			links = response.slug == node.id ? response : nil
		}
		// Dropped when the load was cancelled or superseded while `/links` was in flight. A cancelled load leaves
		// `.loading` untouched: its owner is gone, or the next `load()` resumes the section.
		guard !Task.isCancelled, case .loaded(let current) = state, current.id == node.id else { return }
		let actions = ListeningActions.actions(for: node.type, name: node.name, links: links)
		listening = actions.isEmpty ? .hidden : .ready(actions)
	}

	private func recordViewedNode(_ node: NodeDetail) {
		guard trackedIdentities.insert(node.id).inserted else { return }
		recordEvent?(NodeAnalytics.nodeViewed(node, context: context))
	}
}

public enum NodeAnalytics {
	static func nodeViewed(_ node: NodeDetail, context: NavigationContext) -> AnalyticsEvent {
		var properties: [String: AnalyticsValue] = [
			"node_id": .string(node.id.rawValue),
			"node_type": .string(node.type.rawValue),
		]
		for (key, value) in context.attributionProperties { properties[key] = value }
		return AnalyticsEvent(name: .nodeViewed, properties: properties, source: context.source)
	}

	public static func relationOpened(
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

/// Refuses a second opening of the same relation shortly after the first. A refused tap does not restart the
/// window: it is measured from the last accepted one.
struct RelationOpeningGate {
	static let window: TimeInterval = 0.75

	private var last: (key: String, date: Date)?

	mutating func shouldOpen(key: String, at date: Date) -> Bool {
		if let last, last.key == key, date.timeIntervalSince(last.date) < Self.window { return false }
		last = (key, date)
		return true
	}
}
