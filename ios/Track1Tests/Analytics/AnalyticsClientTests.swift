import Foundation
import Segment
import Track1Core
import XCTest

@testable import Track1

@MainActor
final class AnalyticsClientTests: XCTestCase {
	private var defaults: UserDefaults!

	override func setUp() {
		super.setUp()
		defaults = UserDefaults(suiteName: "AnalyticsClientTests.\(UUID().uuidString)")!
	}

	override func tearDown() {
		defaults.removePersistentDomain(forName: defaults.volatileDomainNames.first ?? "")
		defaults = nil
		super.tearDown()
	}

	func testAllSeventeenContractEventsAcceptOnlyTheirAllowlistedProperties() {
		let identifiers = UUID().uuidString.lowercased()
		let events: [(AnalyticsEventName, [String: AnalyticsValue])] = [
			(.appOpened, [:]),
			(.onboardingStarted, ["flow_id": .string(identifiers)]),
			(.onboardingCompleted, ["flow_id": .string(identifiers), "genres_count": .integer(3)]),
			(.preferencesUpdated, ["genres_count": .integer(2), "action": .string("updated")]),
			(.dailyRecommendationViewed, recommendationProperties),
			(.dailyRecommendationOpened, recommendationProperties),
			(.notificationPermissionResult, ["status": .string("denied")]),
			(.notificationOpened, ["notification_id": .string("push-1"), "target_local_date": .string("2026-10-05")]),
			(.nodeViewed, ["node_id": .string("artist-1"), "node_type": .string("artist")]),
			(
				.relationOpened,
				[
					"from_node_id": .string("artist-1"), "node_id": .string("track-1"), "node_type": .string("track"),
					"relation_kind": .string("appears_on"),
				]
			),
			(.searchSubmitted, ["filter": .string("all")]),
			(
				.searchResultOpened,
				["node_type": .string("track"), "availability": .string("cached"), "results_count": .integer(1)]
			),
			(.generationRequested, ["request_id": .string(identifiers), "node_type": .string("artist")]),
			(
				.generationCompleted,
				["request_id": .string(identifiers), "node_id": .string("artist-1"), "node_type": .string("artist")]
			),
			(
				.generationFailed,
				["request_id": .string(identifiers), "node_type": .string("artist"), "error_code": .string("failed")]
			),
			(.externalListeningOpened, listeningProperties),
			(
				.externalListeningFailed,
				listeningProperties.merging(["error_code": .string("open_failed")]) { _, new in new }
			),
		]

		XCTAssertEqual(events.map(\.0).count, AnalyticsEventName.allCases.count)
		for (name, properties) in events {
			XCTAssertTrue(
				AnalyticsValidation.accepts(AnalyticsEvent(name: name, properties: properties, source: .app)),
				name.rawValue)
			XCTAssertFalse(
				AnalyticsValidation.accepts(
					AnalyticsEvent(
						name: name, properties: properties.merging(["query": .string("private")]) { _, new in new },
						source: .app)))
		}
	}

	func testUnknownAndDeniedNeverCreateTransportOrEvents() async {
		let factory = TransportFactory()
		let client = makeClient(factory: factory)
		await client.initialize()
		client.record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		XCTAssertEqual(factory.created, 0)
		await client.deny()
		client.record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		XCTAssertEqual(factory.created, 0)
		XCTAssertEqual(client.consent.status, .denied)
	}

	func testGrantCreatesOneTransportAndUsesFreshMeasurementIdentityAfterWithdrawal() async {
		let factory = TransportFactory()
		let client = makeClient(factory: factory)
		await client.initialize()
		await client.grant()
		let firstIdentity = try! XCTUnwrap(client.anonymousID)
		XCTAssertEqual(factory.created, 1)
		XCTAssertEqual(factory.transports[0].enables, 1)
		await client.grant()
		XCTAssertEqual(factory.created, 1)
		await client.deny()
		await client.grant()
		XCTAssertEqual(factory.created, 1)
		XCTAssertNotEqual(client.anonymousID, firstIdentity)
		XCTAssertEqual(factory.transports[0].purges, 1)
		XCTAssertEqual(factory.transports[0].enables, 2)
	}

	func testWithdrawalStopsAnInFlightEmissionAndPurgesItsQueue() async {
		let factory = TransportFactory()
		let client = makeClient(factory: factory)
		await client.initialize()
		await client.grant()
		let transport = try! XCTUnwrap(factory.transports.first)
		client.record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		XCTAssertEqual(transport.envelopes.count, 1)
		await client.deny()
		client.record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		XCTAssertTrue(transport.disabled)
		XCTAssertEqual(transport.purges, 1)
		XCTAssertEqual(transport.envelopes.count, 1)
	}

	func testAppOpenedTracksOnlyRealForegroundTransitions() async {
		let factory = TransportFactory()
		let client = makeClient(factory: factory)
		await client.initialize()
		await client.grant()
		let transport = try! XCTUnwrap(factory.transports.first)
		client.scenePhaseChanged(to: .active)
		client.scenePhaseChanged(to: .active)
		client.scenePhaseChanged(to: .inactive)
		client.scenePhaseChanged(to: .active)
		client.scenePhaseChanged(to: .background)
		client.scenePhaseChanged(to: .active)
		XCTAssertEqual(transport.envelopes.map(\.eventName), [.appOpened, .appOpened])
	}

	func testAppOpenedIsReconciledWhenActiveBeforeConsentInitialization() async {
		let store = ConsentStore(defaults: defaults)
		_ = store.grant()
		let factory = TransportFactory()
		let client = makeClient(factory: factory, store: store)

		client.scenePhaseChanged(to: .active)
		await client.initialize()
		client.scenePhaseChanged(to: .active)

		let transport = try! XCTUnwrap(factory.transports.first)
		XCTAssertEqual(transport.envelopes.map(\.eventName), [.appOpened])
	}

	func testAppOpenedIsRecordedOnceWhenActiveAfterConsentInitialization() async {
		let store = ConsentStore(defaults: defaults)
		_ = store.grant()
		let factory = TransportFactory()
		let client = makeClient(factory: factory, store: store)

		await client.initialize()
		client.scenePhaseChanged(to: .active)
		client.scenePhaseChanged(to: .active)

		let transport = try! XCTUnwrap(factory.transports.first)
		XCTAssertEqual(transport.envelopes.map(\.eventName), [.appOpened])
	}

	func testAppOpenedNeverTracksBeforeOrAfterInitializationWhenConsentIsNotGranted() async {
		for status in [ConsentStatus.unknown, .denied] {
			for activeBeforeInitialization in [true, false] {
				let suiteName = "AnalyticsClientTests.lifecycle.\(UUID().uuidString)"
				let testDefaults = try! XCTUnwrap(UserDefaults(suiteName: suiteName))
				defer { testDefaults.removePersistentDomain(forName: suiteName) }
				let store = ConsentStore(defaults: testDefaults)
				if status == .denied { _ = store.deny() }
				let factory = TransportFactory()
				let client = makeClient(factory: factory, store: store)

				if activeBeforeInitialization { client.scenePhaseChanged(to: .active) }
				await client.initialize()
				if !activeBeforeInitialization { client.scenePhaseChanged(to: .active) }

				XCTAssertEqual(factory.created, 0, "\(status) / activeBefore=\(activeBeforeInitialization)")
			}
		}
	}

	func testRealSegmentAdapterSendsOnlyAfterGrantAndPurgesAfterWithdrawal() async throws {
		let session = InterceptingHTTPSession()
		let client = AnalyticsClient(
			store: ConsentStore(defaults: defaults),
			configuration: AnalyticsConfiguration(
				writeKey: "intercepted-key", environment: .development, appVersion: "1.0", buildNumber: "1"),
			makeTransport: { configuration in SegmentAdapter(configuration: configuration, session: session) }
		)
		await client.initialize()
		client.record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		try await Task.sleep(for: .milliseconds(100))
		XCTAssertEqual(session.requestCount, 0)

		await client.deny()
		client.record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		try await Task.sleep(for: .milliseconds(100))
		XCTAssertEqual(session.requestCount, 0)

		await client.grant()
		client.record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		let didSendAppOpened = try await session.waitForBody(containing: "app_opened")
		XCTAssertTrue(didSendAppOpened)
		let body = session.bodies.joined(separator: "\n")
		XCTAssertFalse(body.contains("userId"))
		XCTAssertFalse(body.lowercased().contains("advertisingid"))
		XCTAssertFalse(body.lowercased().contains("identifierforvendor"))

		let requestsBeforeWithdrawal = session.requestCount
		await client.deny()
		client.record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		try await Task.sleep(for: .milliseconds(100))
		XCTAssertEqual(session.requestCount, requestsBeforeWithdrawal)
	}

	func testRealSegmentAdapterMapsEventIDToMessageIDAndStripsContext() async throws {
		let session = InterceptingHTTPSession()
		let adapter = try XCTUnwrap(
			SegmentAdapter(
				configuration: AnalyticsConfiguration(
					writeKey: "envelope-key", environment: .preview, appVersion: "1.2.3", buildNumber: "42"),
				session: session
			))
		adapter.enable()
		let eventID = UUID()
		adapter.send(
			AnalyticsEnvelope(
				eventName: .appOpened,
				eventID: eventID,
				appVersion: "1.2.3",
				buildNumber: "42",
				environment: .preview,
				source: .app,
				occurredAt: Date(timeIntervalSince1970: 1_728_000_000),
				anonymousID: UUID(),
				properties: [:]
			))
		let didSendEvent = try await session.waitForBody(containing: eventID.uuidString.lowercased())
		XCTAssertTrue(didSendEvent)
		let body = session.bodies.joined(separator: "\n")
		XCTAssertTrue(body.contains("\"messageId\":\"\(eventID.uuidString.lowercased())\""))
		XCTAssertFalse(body.contains("\"context\""))
		adapter.disable()
		adapter.purge()
	}

	func testRealSegmentWaitsForDelayedStartupBeforeSendingTheFirstEvent() async throws {
		let session = InterceptingHTTPSession(delaysSettingsResponse: true)
		let adapter = try XCTUnwrap(
			SegmentAdapter(
				configuration: AnalyticsConfiguration(
					writeKey: "delayed-settings-key", environment: .preview, appVersion: "1.0", buildNumber: "1"),
				session: session
			))
		adapter.enable()
		adapter.send(
			AnalyticsEnvelope(
				eventName: .appOpened,
				eventID: UUID(),
				appVersion: "1.0",
				buildNumber: "1",
				environment: .preview,
				source: .app,
				occurredAt: .now,
				anonymousID: UUID(),
				properties: [:]
			))

		#if SEGMENT_CDN_STANDARD || SEGMENT_CDN_PROOF
			// 2026-10-07: Preview compiles Segment 1.10.0 without DEBUG, so its real SDK startup
			// requests delayed CDN settings. The test-target flag keeps this branch explicit rather
			// than inferring it from the host application's build flags.
			let didInterceptSettingsRequest = try await session.waitForSettingsRequest()
			XCTAssertTrue(didInterceptSettingsRequest)
			XCTAssertEqual(session.completedEventBodies.count, 0)
			session.releaseSettings()
		#else
			// 2026-10-07: Development compiles Segment 1.10.0 with DEBUG, which bypasses CDN
			// settings under XCTest. This asserts that the test did not accidentally use CDN startup.
			XCTAssertEqual(session.settingsRequestCount, 0)
		#endif

		let didSendAfterStartup = try await session.waitForBody(containing: "app_opened")
		XCTAssertTrue(didSendAfterStartup)
		adapter.disable()
		adapter.purge()
	}

	func testRealSegmentWithdrawalCancelsDelayedUploadAndPurgesSDKIdentity() async throws {
		let writeKey = "cancelled-upload-key"
		let session = InterceptingHTTPSession(delaysUploads: true)
		let adapter = try XCTUnwrap(
			SegmentAdapter(
				configuration: AnalyticsConfiguration(
					writeKey: writeKey, environment: .development, appVersion: "1.0", buildNumber: "1"),
				session: session
			))
		adapter.enable()
		adapter.send(
			AnalyticsEnvelope(
				eventName: .appOpened,
				eventID: UUID(),
				appVersion: "1.0",
				buildNumber: "1",
				environment: .development,
				source: .app,
				occurredAt: .now,
				anonymousID: UUID(),
				properties: [:]
			))
		let didStartUpload = try await session.waitForUploadStart()
		XCTAssertTrue(didStartUpload)
		adapter.disable()
		adapter.purge()
		XCTAssertEqual(session.cancelledUploadCount, 1)
		XCTAssertEqual(session.completedEventBodies.count, 0)
		let sdkDefaults = try XCTUnwrap(UserDefaults(suiteName: "com.segment.storage.\(writeKey)"))
		XCTAssertNil(sdkDefaults.object(forKey: "segment.anonymousId"))
	}

	func testRealSegmentAdapterReusesItsSingleSDKInstanceAfterRapidRegrant() async throws {
		let session = InterceptingHTTPSession()
		var creations = 0
		let client = AnalyticsClient(
			store: ConsentStore(defaults: defaults),
			configuration: AnalyticsConfiguration(
				writeKey: "rapid-regrant-key", environment: .development, appVersion: "1.0", buildNumber: "1"),
			makeTransport: { configuration in
				creations += 1
				return SegmentAdapter(configuration: configuration, session: session)
			}
		)
		await client.initialize()
		await client.grant()
		let firstIdentity = try XCTUnwrap(client.anonymousID)
		await client.deny()
		await client.grant()
		XCTAssertEqual(creations, 1)
		XCTAssertNotEqual(client.anonymousID, firstIdentity)
		client.record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		let didSendAfterRegrant = try await session.waitForBody(containing: "app_opened")
		XCTAssertTrue(didSendAfterRegrant)
	}

	func testSegmentTaskRegistryCancelsAConcurrentRegistrationAfterWithdrawal() {
		let registry = SegmentTaskRegistry()
		let createdBeforeRegistration = RecordingCancellableTask()
		let created = DispatchSemaphore(value: 0)
		let registrationPermission = DispatchSemaphore(value: 0)
		let registered = DispatchSemaphore(value: 0)

		DispatchQueue.global().async {
			created.signal()
			registrationPermission.wait()
			registry.register(createdBeforeRegistration)
			registered.signal()
		}

		XCTAssertEqual(created.wait(timeout: .now() + 1), .success)
		registry.disable()
		registrationPermission.signal()
		XCTAssertEqual(registered.wait(timeout: .now() + 1), .success)
		XCTAssertTrue(createdBeforeRegistration.wasCancelled)
		XCTAssertEqual(registry.activeTaskCount, 0)

		let createdAfterWithdrawal = RecordingCancellableTask()
		registry.register(createdAfterWithdrawal)
		XCTAssertTrue(createdAfterWithdrawal.wasCancelled)
		XCTAssertEqual(registry.activeTaskCount, 0)

		registry.enable()
		let createdAfterRegrant = RecordingCancellableTask()
		registry.register(createdAfterRegrant)
		XCTAssertFalse(createdAfterRegrant.wasCancelled)
		XCTAssertEqual(registry.activeTaskCount, 1)
	}

	private func makeClient(factory: TransportFactory, store: ConsentStore? = nil) -> AnalyticsClient {
		AnalyticsClient(
			store: store ?? ConsentStore(defaults: defaults),
			configuration: AnalyticsConfiguration(
				writeKey: "test-key", environment: .development, appVersion: "1.0", buildNumber: "1"),
			makeTransport: { _ in factory.make() }
		)
	}

	private var recommendationProperties: [String: AnalyticsValue] {
		[
			"recommendation_id": .string("recommendation-1"), "local_date": .string("2026-10-05"),
			"node_id": .string("artist-1"), "node_type": .string("artist"),
		]
	}

	private var listeningProperties: [String: AnalyticsValue] {
		[
			"node_id": .string("track-1"), "node_type": .string("track"), "provider": .string("spotify"),
			"link_kind": .string("exact"),
		]
	}
}

private final class RecordingCancellableTask: SegmentCancellableTask, @unchecked Sendable {
	private let lock = NSLock()
	private var cancellationCount = 0

	var wasCancelled: Bool { lock.withLock { cancellationCount > 0 } }

	func cancel() { lock.withLock { cancellationCount += 1 } }
}

private final class InterceptingHTTPSession: AnalyticsHTTPSession, @unchecked Sendable {
	typealias DataTaskType = InterceptingTask
	typealias UploadTaskType = InterceptingTask

	private let lock = NSLock()
	private let delaysSettingsResponse: Bool
	private let delaysUploads: Bool
	private var capturedRequests: [URLRequest] = []
	private var completedBodies: [String] = []
	private var waitingSettings: [InterceptingTask] = []
	private var waitingUploads: [InterceptingTask] = []
	private var cancelledUploads = 0
	private var enabled = true

	init(delaysSettingsResponse: Bool = false, delaysUploads: Bool = false) {
		self.delaysSettingsResponse = delaysSettingsResponse
		self.delaysUploads = delaysUploads
	}

	var requestCount: Int {
		lock.withLock { capturedRequests.count }
	}

	var bodies: [String] {
		lock.withLock { completedBodies }
	}

	var completedEventBodies: [String] { bodies }
	var cancelledUploadCount: Int { lock.withLock { cancelledUploads } }
	var settingsRequestCount: Int {
		lock.withLock { capturedRequests.filter(\.isSettingsRequest).count }
	}

	func uploadTask(
		with request: URLRequest, fromFile file: URL,
		completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void
	) -> InterceptingTask {
		let body = try? Data(contentsOf: file)
		return task(request: request, body: body, completionHandler: completionHandler)
	}

	func uploadTask(
		with request: URLRequest, from bodyData: Data?,
		completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void
	) -> InterceptingTask {
		task(request: request, body: bodyData, completionHandler: completionHandler)
	}

	func dataTask(
		with request: URLRequest, completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void
	) -> InterceptingTask {
		task(request: request, body: nil, completionHandler: completionHandler)
	}

	func finishTasksAndInvalidate() {
		// Segment releases a short-lived settings HTTPClient after scheduling its request. The
		// adapter owns this shared test transport, so only an explicit consent withdrawal disables it.
	}

	func enable() { lock.withLock { enabled = true } }

	func disable() {
		let tasks = lock.withLock { () -> [InterceptingTask] in
			enabled = false
			let tasks = waitingSettings + waitingUploads
			cancelledUploads += waitingUploads.count
			waitingSettings.removeAll()
			waitingUploads.removeAll()
			return tasks
		}
		for task in tasks { task.cancel() }
	}

	func releaseSettings() {
		let settings = lock.withLock { () -> [InterceptingTask] in
			let settings = waitingSettings
			waitingSettings.removeAll()
			return settings
		}
		for setting in settings { setting.complete(with: Self.settingsData) }
	}

	func waitForBody(containing value: String) async throws -> Bool {
		for _ in 0..<40 {
			if bodies.contains(where: { $0.contains(value) }) { return true }
			try await Task.sleep(for: .milliseconds(50))
		}
		return false
	}

	func waitForUploadStart() async throws -> Bool {
		for _ in 0..<40 {
			if lock.withLock({ !waitingUploads.isEmpty }) { return true }
			try await Task.sleep(for: .milliseconds(50))
		}
		return false
	}

	func waitForSettingsRequest() async throws -> Bool {
		for _ in 0..<40 {
			if lock.withLock({ !waitingSettings.isEmpty }) { return true }
			try await Task.sleep(for: .milliseconds(50))
		}
		return false
	}

	private func task(
		request: URLRequest, body: Data?,
		completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void
	) -> InterceptingTask {
		let shouldCancel = lock.withLock { () -> Bool in
			capturedRequests.append(request)
			return !enabled
		}
		let task = InterceptingTask(request: request, body: body, completionHandler: completionHandler) {
			[weak self] task in
			self?.resume(task)
		}
		if shouldCancel { task.cancel() }
		return task
	}

	private func resume(_ task: InterceptingTask) {
		guard lock.withLock({ enabled }) else {
			task.cancel()
			return
		}
		if task.isSettingsRequest {
			if delaysSettingsResponse {
				lock.withLock { waitingSettings.append(task) }
			} else {
				task.complete(with: Self.settingsData)
			}
			return
		}
		if delaysUploads {
			lock.withLock { waitingUploads.append(task) }
		} else {
			completeUpload(task)
		}
	}

	private func completeUpload(_ task: InterceptingTask) {
		guard let body = task.body, let value = String(data: body, encoding: .utf8) else { return }
		lock.withLock { completedBodies.append(value) }
		task.complete(with: Data())
	}

	private static let settingsData = Data(
		"{\"integrations\":{\"Segment.io\":{\"apiKey\":\"test\",\"apiHost\":\"api.segment.io/v1\"}}}".utf8)
}

private final class InterceptingTask: DataTask, UploadTask, @unchecked Sendable {
	private let request: URLRequest
	let body: Data?
	private let completionHandler: @Sendable (Data?, URLResponse?, (any Error)?) -> Void
	private let onResume: @Sendable (InterceptingTask) -> Void
	private let lock = NSLock()
	private var currentState = URLSessionTask.State.suspended

	init(
		request: URLRequest, body: Data?,
		completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void,
		onResume: @escaping @Sendable (InterceptingTask) -> Void
	) {
		self.request = request
		self.body = body
		self.completionHandler = completionHandler
		self.onResume = onResume
	}

	var state: URLSessionTask.State { lock.withLock { currentState } }
	var isSettingsRequest: Bool { request.isSettingsRequest }

	func resume() {
		let shouldResume = lock.withLock { () -> Bool in
			guard currentState == .suspended else { return false }
			currentState = .running
			return true
		}
		guard shouldResume else { return }
		onResume(self)
	}

	func cancel() {
		lock.withLock { currentState = .canceling }
		completionHandler(nil, nil, URLError(.cancelled))
		lock.withLock { currentState = .completed }
	}

	func complete(with data: Data) {
		guard state == .running else { return }
		let response = HTTPURLResponse(
			url: request.url ?? URL(string: "https://segment.test")!, statusCode: 200, httpVersion: nil,
			headerFields: nil)
		completionHandler(data, response, nil)
		lock.withLock { currentState = .completed }
	}
}

extension URLRequest {
	fileprivate var isSettingsRequest: Bool { url?.host?.contains("cdn-settings") == true }
}

@MainActor
private final class TransportFactory {
	private(set) var transports: [RecordingTransport] = []
	var created: Int { transports.count }

	func make() -> RecordingTransport {
		let transport = RecordingTransport()
		transports.append(transport)
		return transport
	}
}

@MainActor
private final class RecordingTransport: AnalyticsTransport {
	private(set) var envelopes: [AnalyticsEnvelope] = []
	private(set) var disabled = false
	private(set) var enables = 0
	private(set) var purges = 0

	func send(_ envelope: AnalyticsEnvelope) {
		guard !disabled else { return }
		envelopes.append(envelope)
	}
	func enable() {
		disabled = false
		enables += 1
	}
	func disable() { disabled = true }
	func purge() { purges += 1 }
}
