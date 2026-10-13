import Foundation
import Observation
import SwiftUI
import Track1Core

@MainActor
protocol AnalyticsTransport: AnyObject {
	func send(_ envelope: AnalyticsEnvelope)
	func enable()
	func disable()
	func purge()
}

@MainActor
@Observable
final class AnalyticsClient {
	private(set) var consent = AnalyticsConsent.unknown
	private(set) var hasLoadedConsent = false
	private(set) var isAvailable = false
	private(set) var anonymousID: UUID?

	private let store: ConsentStore
	private let makeTransport: @MainActor (AnalyticsConfiguration) -> AnalyticsTransport?
	private let configuration: AnalyticsConfiguration
	private var transport: AnalyticsTransport?
	private var foregrounded = false
	private var generation = 0

	init(
		store: ConsentStore = ConsentStore(),
		configuration: AnalyticsConfiguration,
		makeTransport: @escaping @MainActor (AnalyticsConfiguration) -> AnalyticsTransport? = {
			SegmentAdapter(configuration: $0)
		}
	) {
		self.store = store
		self.configuration = configuration
		self.makeTransport = makeTransport
	}

	func initialize() async {
		let loaded = store.read()
		consent = loaded
		hasLoadedConsent = true
		guard loaded.status == .granted else { return }
		await activateIfPossible()
		if foregrounded { record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app)) }
	}

	func grant() async {
		guard consent.status != .granted else { return }
		consent = store.grant()
		await activateIfPossible()
		if foregrounded { record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app)) }
	}

	func deny() async {
		generation += 1
		foregrounded = false
		isAvailable = false
		anonymousID = nil
		consent = store.deny()
		transport?.disable()
		transport?.purge()
		store.clearAnonymousID()
	}

	func record(_ event: AnalyticsEvent) {
		guard consent.status == .granted, let transport, let anonymousID,
			AnalyticsValidation.accepts(event)
		else { return }
		let envelope = AnalyticsEnvelope(
			eventName: event.name,
			eventID: UUID(),
			appVersion: configuration.appVersion,
			buildNumber: configuration.buildNumber,
			environment: configuration.environment,
			source: event.source,
			occurredAt: event.occurredAt,
			anonymousID: anonymousID,
			properties: event.properties
		)
		transport.send(envelope)
	}

	func scenePhaseChanged(to phase: ScenePhase) {
		switch phase {
		case .active:
			guard foregrounded == false else { return }
			foregrounded = true
			record(AnalyticsEvent(name: .appOpened, properties: [:], source: .app))
		case .background:
			foregrounded = false
		case .inactive:
			break
		@unknown default:
			break
		}
	}

	private func activateIfPossible() async {
		guard consent.status == .granted, configuration.writeKey != nil else { return }
		if let transport {
			transport.enable()
			anonymousID = store.anonymousID() ?? UUID()
			if let anonymousID { store.saveAnonymousID(anonymousID) }
			isAvailable = true
			return
		}
		let token = generation
		let stored = store.anonymousID()
		guard token == generation, consent.status == .granted, transport == nil else { return }
		let newIdentity = stored ?? UUID()
		if stored == nil { store.saveAnonymousID(newIdentity) }
		guard token == generation, consent.status == .granted, transport == nil,
			let transport = makeTransport(configuration)
		else { return }
		self.transport = transport
		transport.enable()
		anonymousID = newIdentity
		isAvailable = true
	}
}

struct AnalyticsConfiguration: Sendable {
	let writeKey: String?
	let environment: AppConfiguration.Environment
	let appVersion: String
	let buildNumber: String

	init(
		writeKey: String?,
		environment: AppConfiguration.Environment,
		appVersion: String,
		buildNumber: String
	) {
		let trimmed = writeKey?.trimmingCharacters(in: .whitespacesAndNewlines)
		self.writeKey = trimmed?.isEmpty == false ? trimmed : nil
		self.environment = environment
		self.appVersion = appVersion
		self.buildNumber = buildNumber
	}
}
