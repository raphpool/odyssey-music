import Foundation
@preconcurrency import Segment

// Segment invokes enrichments from its delivery queue, outside the UI actor.
private func removeForbiddenSegmentContext(_ rawEvent: RawEvent?) -> RawEvent? {
	guard var event = rawEvent as? TrackEvent else { return rawEvent }
	event.context = nil
	event.userId = nil
	return event
}

protocol AnalyticsHTTPSession: HTTPSession {
	func enable()
	func disable()
}

@MainActor
final class SegmentAdapter: AnalyticsTransport {
	private let delivery: SegmentDelivery

	init?(configuration: AnalyticsConfiguration, session: (any AnalyticsHTTPSession)? = nil) {
		guard let writeKey = configuration.writeKey else { return nil }
		Telemetry.shared.enable = false
		let transportSession = session ?? SegmentHTTPSession()
		let segmentConfiguration = Configuration(writeKey: writeKey)
			.setTrackedApplicationLifecycleEvents(.none)
			.storageMode(.memory(100))
			.flushAt(1)
			.operatingMode(.synchronous)
			.httpSession(transportSession)
		let analytics = Analytics(configuration: segmentConfiguration)
		analytics.add(enrichment: removeForbiddenSegmentContext)
		delivery = SegmentDelivery(analytics: analytics, session: transportSession, writeKey: writeKey)
	}

	func send(_ envelope: AnalyticsEnvelope) {
		guard let properties = try? JSON(Self.properties(for: envelope)) else { return }
		var event = TrackEvent(event: envelope.eventName.rawValue, properties: properties)
		event.messageId = envelope.eventID.uuidString.lowercased()
		event.anonymousId = envelope.anonymousID.uuidString.lowercased()
		event.timestamp = Self.timestampFormatter.string(from: envelope.occurredAt)
		event.userId = nil
		delivery.send(event)
	}

	func enable() { delivery.enable() }
	func disable() { delivery.disable() }
	func purge() { delivery.purge() }

	private static let timestampFormatter: ISO8601DateFormatter = {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return formatter
	}()

	private static func properties(for envelope: AnalyticsEnvelope) -> [String: Any] {
		var properties: [String: Any] = envelope.properties.mapValues { value in
			switch value {
			case .string(let value): return value
			case .integer(let value): return value
			}
		}
		properties["schema_version"] = envelope.schemaVersion
		properties["platform"] = envelope.platform
		properties["app_version"] = envelope.appVersion
		properties["build_number"] = envelope.buildNumber
		properties["environment"] = envelope.environment.rawValue
		properties["source"] = envelope.source.rawValue
		return properties
	}

}

private final class SegmentDelivery: @unchecked Sendable {
	private let queue = DispatchQueue(label: "com.odyssey.track1.segment-delivery")
	private let lock = NSLock()
	private let analytics: Analytics
	private let session: any AnalyticsHTTPSession
	private let writeKey: String
	private var enabled = false
	private var generation = 0
	private var ready = false
	private var pendingEvents: [(generation: Int, event: TrackEvent)] = []

	init(analytics: Analytics, session: any AnalyticsHTTPSession, writeKey: String) {
		self.analytics = analytics
		self.session = session
		self.writeKey = writeKey
		// AnalyticsClient constructs an adapter only after it has persisted granted consent. Segment
		// starts its CDN settings fetch during construction, so cancelling the injected session here
		// would strand that startup request before the matching enable call can deliver events.
		// Events remain disabled until AnalyticsClient explicitly activates this delivery.
		analytics.enabled = false
		queue.async { [weak self] in self?.waitForStartup() }
	}

	func send(_ event: TrackEvent) {
		let token = lock.withLock { generation }
		queue.async { [weak self] in self?.deliver(event, generation: token) }
	}

	func enable() {
		lock.withLock { enabled = true }
		session.enable()
		queue.async { [weak self] in self?.analytics.enabled = true }
	}

	func disable() {
		lock.withLock {
			enabled = false
			generation += 1
		}
		session.disable()
		analytics.enabled = false
	}

	func purge() {
		lock.withLock { pendingEvents.removeAll() }
		analytics.purgeStorage()
		analytics.reset()
		Self.clearPersistentSegmentState(writeKey: writeKey)
	}

	private func waitForStartup() {
		analytics.waitUntilStarted()
		let queued = lock.withLock { () -> [(generation: Int, event: TrackEvent)] in
			ready = true
			let queued = pendingEvents
			pendingEvents.removeAll()
			return queued
		}
		for item in queued { deliver(item.event, generation: item.generation) }
	}

	private func deliver(_ event: TrackEvent, generation eventGeneration: Int) {
		let canDeliver = lock.withLock { enabled && generation == eventGeneration }
		guard canDeliver else { return }
		let shouldQueue = lock.withLock { !ready }
		if shouldQueue {
			lock.withLock { pendingEvents.append((generation: eventGeneration, event: event)) }
			return
		}
		analytics.process(event: event)
		analytics.flush()
	}

	private static func clearPersistentSegmentState(writeKey: String) {
		guard let defaults = UserDefaults(suiteName: "com.segment.storage.\(writeKey)") else { return }
		for key in [
			"segment.userId", "segment.traits", "segment.anonymousId", "segment.settings", "segment.retryState",
		] {
			defaults.removeObject(forKey: key)
		}
		defaults.synchronize()
	}
}

protocol SegmentCancellableTask: AnyObject {
	func cancel()
}

extension URLSessionTask: SegmentCancellableTask {}

final class SegmentTaskRegistry: @unchecked Sendable {
	private let lock = NSLock()
	private var enabled = true
	private var tasks: [any SegmentCancellableTask] = []

	func enable() { lock.withLock { enabled = true } }

	func disable() {
		let activeTasks = lock.withLock { () -> [any SegmentCancellableTask] in
			enabled = false
			let activeTasks = tasks
			tasks.removeAll()
			return activeTasks
		}
		for task in activeTasks { task.cancel() }
	}

	func register(_ task: some SegmentCancellableTask) {
		let shouldCancel = lock.withLock { () -> Bool in
			guard enabled else { return true }
			tasks.append(task)
			return false
		}
		if shouldCancel { task.cancel() }
	}

	var activeTaskCount: Int { lock.withLock { tasks.count } }
}

private final class SegmentHTTPSession: NSObject, AnalyticsHTTPSession, @unchecked Sendable {
	typealias DataTaskType = URLSessionDataTask
	typealias UploadTaskType = URLSessionUploadTask

	private let session: URLSession
	private let tasks = SegmentTaskRegistry()

	override init() {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.httpMaximumConnectionsPerHost = 2
		session = URLSession(configuration: configuration)
		super.init()
	}

	func uploadTask(
		with request: URLRequest, fromFile file: URL,
		completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void
	) -> URLSessionUploadTask {
		let task = session.uploadTask(with: request, fromFile: file, completionHandler: completionHandler)
		track(task)
		return task
	}

	func uploadTask(
		with request: URLRequest, from bodyData: Data?,
		completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void
	) -> URLSessionUploadTask {
		let task = session.uploadTask(with: request, from: bodyData, completionHandler: completionHandler)
		track(task)
		return task
	}

	func dataTask(
		with request: URLRequest, completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void
	) -> URLSessionDataTask {
		let task = session.dataTask(with: request, completionHandler: completionHandler)
		track(task)
		return task
	}

	func finishTasksAndInvalidate() {
		// Segment creates a short-lived HTTPClient for CDN settings, then invalidates its session on
		// deinit. This adapter intentionally shares one consent-controlled session across those
		// clients, so only explicit disable() may close that shared transport and cancel its tasks.
	}

	func enable() { tasks.enable() }
	func disable() { tasks.disable() }

	private func track(_ task: URLSessionTask) { tasks.register(task) }
}
