import Foundation

public struct NavigationContext: Hashable, Sendable {
	public let source: AnalyticsSource
	public let recommendationID: UUID?
	public let notificationID: UUID?

	public init(source: AnalyticsSource, recommendationID: UUID? = nil, notificationID: UUID? = nil) {
		self.source = source
		self.recommendationID = recommendationID
		self.notificationID = notificationID
	}

	public static func independent(source: AnalyticsSource) -> NavigationContext {
		NavigationContext(source: source)
	}

	public func followingRelation() -> NavigationContext {
		NavigationContext(source: .relation, recommendationID: recommendationID, notificationID: notificationID)
	}

	public var attributionProperties: [String: AnalyticsValue] {
		var properties: [String: AnalyticsValue] = [:]
		if let recommendationID {
			properties["recommendation_id"] = .string(recommendationID.uuidString.lowercased())
		}
		if let notificationID { properties["notification_id"] = .string(notificationID.uuidString.lowercased()) }
		return properties
	}
}
