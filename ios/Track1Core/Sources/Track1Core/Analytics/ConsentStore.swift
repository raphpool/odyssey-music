import Foundation

public enum ConsentStatus: String, Codable, Equatable, Sendable {
	case unknown
	case granted
	case denied
}

public struct AnalyticsConsent: Codable, Equatable, Sendable {
	public let version: Int
	public let status: ConsentStatus
	public let decidedAt: Date?

	public static let unknown = AnalyticsConsent(version: 1, status: .unknown, decidedAt: nil)
}

@MainActor
public final class ConsentStore {
	private static let consentKey = "track1.analytics-consent.v1"
	private static let anonymousIDKey = "track1.analytics-anonymous-id.v1"
	private let defaults: UserDefaults
	private let now: @Sendable () -> Date

	public init(defaults: UserDefaults = .standard, now: @escaping @Sendable () -> Date = Date.init) {
		if ProcessInfo.processInfo.arguments.contains("-track1-reset-analytics-consent") {
			defaults.removeObject(forKey: Self.consentKey)
			defaults.removeObject(forKey: Self.anonymousIDKey)
		}
		self.defaults = defaults
		self.now = now
	}

	public func read() -> AnalyticsConsent {
		guard let data = defaults.data(forKey: Self.consentKey),
			let value = try? JSONDecoder().decode(AnalyticsConsent.self, from: data),
			value.version == 1
		else { return .unknown }
		return value
	}

	public func grant() -> AnalyticsConsent { write(.granted) }
	public func deny() -> AnalyticsConsent { write(.denied) }

	public func anonymousID() -> UUID? {
		defaults.string(forKey: Self.anonymousIDKey).flatMap(UUID.init(uuidString:))
	}

	public func saveAnonymousID(_ value: UUID) {
		defaults.set(value.uuidString.lowercased(), forKey: Self.anonymousIDKey)
	}
	public func clearAnonymousID() { defaults.removeObject(forKey: Self.anonymousIDKey) }

	private func write(_ status: ConsentStatus) -> AnalyticsConsent {
		let value = AnalyticsConsent(version: 1, status: status, decidedAt: now())
		if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: Self.consentKey) }
		return value
	}
}
