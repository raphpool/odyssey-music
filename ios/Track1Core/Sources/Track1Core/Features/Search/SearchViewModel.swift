import Foundation
import Observation

public enum SearchFilter: String, CaseIterable, Sendable {
	case all, artist, project, track, genre, label

	/// `nil` for `.all`: the server treats an absent `type` as "every type".
	public var nodeType: NodeType? {
		switch self {
		case .all: nil
		case .artist: .artist
		case .project: .project
		case .track: .track
		case .genre: .genre
		case .label: .label
		}
	}
}

public enum SearchPhase: Equatable, Sendable {
	case idle, tooShort, tooLong, loading, results, empty, failed
}

public enum SearchOpening: Equatable, Sendable {
	case node(NodeIdentity, NavigationContext)
	case missing(name: String, type: NodeType)
}

public typealias SearchReader = @Sendable (String, NodeType?) async -> APIResult<SearchResponse>

@MainActor
@Observable
public final class SearchViewModel {
	static let debounce = Duration.milliseconds(300)
	static let minimumLength = 2
	static let maximumLength = 120

	public var query = "" {
		didSet { if query != oldValue { reschedule() } }
	}
	public var filter = SearchFilter.all {
		didSet { if filter != oldValue { reschedule() } }
	}
	public private(set) var phase = SearchPhase.idle
	/// Kept while the next request is loading, so the list does not flash empty on every keystroke.
	public private(set) var hits: [SearchHit] = []

	@ObservationIgnored private let search: SearchReader
	@ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
	@ObservationIgnored private let recordEvent: NodeEventRecorder?
	@ObservationIgnored private var pending: Task<Void, Never>?
	/// Bumped by every change of input and by `retry`. A response is applied only if it still carries the
	/// latest number, whatever the transport does with cancellation.
	@ObservationIgnored private var requestNumber = 0
	@ObservationIgnored private var isWaiting = false
	@ObservationIgnored private var lastValidRequest: (text: String, filter: SearchFilter)?

	public init(
		search: @escaping SearchReader,
		sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
		recordEvent: NodeEventRecorder? = nil
	) {
		self.search = search
		self.sleep = sleep
		self.recordEvent = recordEvent
	}

	/// Re-runs the last valid request at once. A no-op while a newer input is still waiting for its
	/// delay: that request supersedes the failed one and is about to run anyway.
	public func retry() {
		guard !isWaiting, let request = lastValidRequest else { return }
		pending?.cancel()
		requestNumber += 1
		let number = requestNumber
		pending = Task { await run(request.text, request.filter, number: number) }
	}

	/// Never touches the network: a catalog hit has no card yet, and creating one is not this screen's job.
	public func open(_ hit: SearchHit) -> SearchOpening {
		var properties: [String: AnalyticsValue] = [
			"node_type": .string(hit.type.rawValue),
			"results_count": .integer(hits.count),
		]
		let opening: SearchOpening
		if hit.source == "cache", let slug = hit.slug {
			properties["availability"] = .string("cached")
			properties["node_id"] = .string(slug.rawValue)
			opening = .node(slug, .independent(source: .search))
		} else {
			properties["availability"] = .string("missing")
			opening = .missing(name: hit.name, type: hit.type)
		}
		recordEvent?(AnalyticsEvent(name: .searchResultOpened, properties: properties, source: .search))
		return opening
	}

	private func reschedule() {
		pending?.cancel()
		requestNumber += 1
		isWaiting = true
		let number = requestNumber
		let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
		let filter = filter
		let sleep = sleep
		pending = Task { [weak self] in
			do { try await sleep(Self.debounce) } catch { return }
			await self?.run(text, filter, number: number)
		}
	}

	private func run(_ text: String, _ filter: SearchFilter, number: Int) async {
		guard number == requestNumber else { return }
		isWaiting = false

		switch text.utf16.count {
		case 0: return settle(.idle)
		case 1..<Self.minimumLength: return settle(.tooShort)
		case (Self.maximumLength + 1)...: return settle(.tooLong)
		default: break
		}

		lastValidRequest = (text, filter)
		phase = .loading
		recordEvent?(
			AnalyticsEvent(
				name: .searchSubmitted, properties: ["filter": .string(filter.rawValue)], source: .search))

		let result = await search(text, filter.nodeType)
		guard number == requestNumber else { return }
		switch result {
		case .success(let response, _) where !response.hits.isEmpty:
			hits = response.hits
			phase = .results
		case .success:
			settle(.empty)
		case .notModified, .failure:
			settle(.failed)
		}
	}

	/// Ends in a phase that shows no hits. Only an invalid input forgets the last valid request: after an
	/// empty or failed answer, `retry` must still be able to replay it.
	private func settle(_ phase: SearchPhase) {
		self.phase = phase
		hits = []
		if phase == .idle || phase == .tooShort || phase == .tooLong { lastValidRequest = nil }
	}
}
