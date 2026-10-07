import Foundation

enum AnalyticsEventName: String, CaseIterable, Sendable {
	case appOpened = "app_opened"
	case onboardingStarted = "onboarding_started"
	case onboardingCompleted = "onboarding_completed"
	case preferencesUpdated = "preferences_updated"
	case dailyRecommendationViewed = "daily_recommendation_viewed"
	case dailyRecommendationOpened = "daily_recommendation_opened"
	case notificationPermissionResult = "notification_permission_result"
	case notificationOpened = "notification_opened"
	case nodeViewed = "node_viewed"
	case relationOpened = "relation_opened"
	case searchSubmitted = "search_submitted"
	case searchResultOpened = "search_result_opened"
	case generationRequested = "generation_requested"
	case generationCompleted = "generation_completed"
	case generationFailed = "generation_failed"
	case externalListeningOpened = "external_listening_opened"
	case externalListeningFailed = "external_listening_failed"
}

enum AnalyticsSource: String, CaseIterable, Sendable {
	case app
	case onboarding
	case settings
	case home
	case search
	case relation
	case notification
	case deeplink
}

enum AnalyticsValue: Equatable, Sendable {
	case string(String)
	case integer(Int)
}

struct AnalyticsEvent: Equatable, Sendable {
	let name: AnalyticsEventName
	let properties: [String: AnalyticsValue]
	let source: AnalyticsSource
	let occurredAt: Date

	init(
		name: AnalyticsEventName,
		properties: [String: AnalyticsValue],
		source: AnalyticsSource,
		occurredAt: Date = .now
	) {
		self.name = name
		self.properties = properties
		self.source = source
		self.occurredAt = occurredAt
	}
}

struct AnalyticsEnvelope: Equatable, Sendable {
	let eventName: AnalyticsEventName
	let eventID: UUID
	let schemaVersion = 1
	let platform = "ios"
	let appVersion: String
	let buildNumber: String
	let environment: AppConfiguration.Environment
	let source: AnalyticsSource
	let occurredAt: Date
	let anonymousID: UUID
	let properties: [String: AnalyticsValue]
}

enum AnalyticsValidation {
	private static let nodeTypes: Set<String> = ["artist", "project", "track", "genre", "label"]
	private static let providers: Set<String> = ["spotify", "apple_music"]

	static func accepts(_ event: AnalyticsEvent) -> Bool {
		guard let rule = rules[event.name],
			Set(event.properties.keys) == rule.required.union(rule.optional)
				|| Set(event.properties.keys).isSubset(of: rule.required.union(rule.optional)),
			rule.required.isSubset(of: Set(event.properties.keys))
		else { return false }

		return event.properties.allSatisfy { key, value in rule.validates(key, value) }
	}

	private struct Rule: Sendable {
		let required: Set<String>
		let optional: Set<String>
		let validates: @Sendable (String, AnalyticsValue) -> Bool
	}

	private static let rules: [AnalyticsEventName: Rule] = [
		.appOpened: Rule(required: [], optional: [], validates: always),
		.onboardingStarted: Rule(required: ["flow_id"], optional: [], validates: uuid),
		.onboardingCompleted: Rule(required: ["flow_id", "genres_count"], optional: [], validates: flowAndCount),
		.preferencesUpdated: Rule(required: ["genres_count", "action"], optional: [], validates: preferences),
		.dailyRecommendationViewed: Rule(required: recommendationKeys, optional: [], validates: recommendation),
		.dailyRecommendationOpened: Rule(required: recommendationKeys, optional: [], validates: recommendation),
		.notificationPermissionResult: Rule(required: ["status"], optional: [], validates: notificationPermission),
		.notificationOpened: Rule(
			required: ["notification_id", "target_local_date"], optional: [], validates: notificationOpened),
		.nodeViewed: Rule(required: ["node_id", "node_type"], optional: attributionKeys, validates: node),
		.relationOpened: Rule(
			required: ["from_node_id", "node_id", "node_type", "relation_kind"], optional: attributionKeys,
			validates: relation),
		.searchSubmitted: Rule(required: ["filter"], optional: [], validates: search),
		.searchResultOpened: Rule(
			required: ["node_type", "availability", "results_count"], optional: ["node_id"], validates: searchResult),
		.generationRequested: Rule(required: ["request_id", "node_type"], optional: [], validates: request),
		.generationCompleted: Rule(
			required: ["request_id", "node_id", "node_type"], optional: [], validates: requestAndNode),
		.generationFailed: Rule(
			required: ["request_id", "node_type", "error_code"], optional: [], validates: generationFailure),
		.externalListeningOpened: Rule(required: listeningKeys, optional: attributionKeys, validates: listening),
		.externalListeningFailed: Rule(
			required: listeningKeys.union(["error_code"]), optional: attributionKeys, validates: listeningFailure),
	]

	private static let attributionKeys: Set<String> = ["recommendation_id", "notification_id"]
	private static let recommendationKeys: Set<String> = [
		"recommendation_id", "local_date", "node_id", "node_type",
	]
	private static let listeningKeys: Set<String> = ["node_id", "node_type", "provider", "link_kind"]

	private static func always(_: String, _: AnalyticsValue) -> Bool { true }
	private static func string(_ value: AnalyticsValue) -> String? {
		if case .string(let value) = value, !value.isEmpty { return value }
		return nil
	}
	private static func integer(_ value: AnalyticsValue) -> Int? {
		if case .integer(let value) = value, value >= 0 { return value }
		return nil
	}
	private static func uuid(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "flow_id" && UUID(uuidString: string(value) ?? "") != nil
	}
	private static func flowAndCount(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "flow_id"
			? UUID(uuidString: string(value) ?? "") != nil : key == "genres_count" && integer(value) != nil
	}
	private static func preferences(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "genres_count"
			? integer(value) != nil : key == "action" && ["updated", "cleared"].contains(string(value) ?? "")
	}
	private static func recommendation(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "node_type"
			? nodeTypes.contains(string(value) ?? "")
			: key == "local_date" ? ISO8601DateFormatter.track1Date(string(value)) : string(value) != nil
	}
	private static func notificationPermission(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "status" && ["granted", "denied", "undetermined"].contains(string(value) ?? "")
	}
	private static func notificationOpened(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "notification_id"
			? string(value) != nil : key == "target_local_date" && ISO8601DateFormatter.track1Date(string(value))
	}
	private static func node(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "node_type" ? nodeTypes.contains(string(value) ?? "") : string(value) != nil
	}
	private static func relation(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "node_type" ? nodeTypes.contains(string(value) ?? "") : string(value) != nil
	}
	private static func search(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "filter" && nodeTypes.union(["all"]).contains(string(value) ?? "")
	}
	private static func searchResult(_ key: String, _ value: AnalyticsValue) -> Bool {
		switch key {
		case "node_type": nodeTypes.contains(string(value) ?? "")
		case "availability": ["cached", "missing"].contains(string(value) ?? "")
		case "results_count": integer(value) != nil
		default: string(value) != nil
		}
	}
	private static func request(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "request_id"
			? UUID(uuidString: string(value) ?? "") != nil
			: key == "node_type" && nodeTypes.contains(string(value) ?? "")
	}
	private static func requestAndNode(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "node_id" ? string(value) != nil : request(key, value)
	}
	private static func generationFailure(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "error_code"
			? ["failed", "interrupted", "expired"].contains(string(value) ?? "") : request(key, value)
	}
	private static func listening(_ key: String, _ value: AnalyticsValue) -> Bool {
		switch key {
		case "node_type": nodeTypes.contains(string(value) ?? "")
		case "provider": providers.contains(string(value) ?? "")
		case "link_kind": ["exact", "search"].contains(string(value) ?? "")
		default: string(value) != nil
		}
	}
	private static func listeningFailure(_ key: String, _ value: AnalyticsValue) -> Bool {
		key == "error_code" ? ["unsafe_url", "open_failed"].contains(string(value) ?? "") : listening(key, value)
	}
}

extension ISO8601DateFormatter {
	fileprivate static func track1Date(_ value: String?) -> Bool {
		guard let value else { return false }
		return value.wholeMatch(of: /^\d{4}-\d{2}-\d{2}$/) != nil
	}
}
