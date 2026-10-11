import Foundation

struct NavigationContext: Hashable, Sendable {
	let source: AnalyticsSource
	let recommendationID: UUID?
	let notificationID: UUID?

	init(source: AnalyticsSource, recommendationID: UUID? = nil, notificationID: UUID? = nil) {
		self.source = source
		self.recommendationID = recommendationID
		self.notificationID = notificationID
	}

	static func independent(source: AnalyticsSource) -> NavigationContext {
		NavigationContext(source: source)
	}

	func followingRelation() -> NavigationContext {
		NavigationContext(source: .relation, recommendationID: recommendationID, notificationID: notificationID)
	}

	var attributionProperties: [String: AnalyticsValue] {
		var properties: [String: AnalyticsValue] = [:]
		if let recommendationID {
			properties["recommendation_id"] = .string(recommendationID.uuidString.lowercased())
		}
		if let notificationID { properties["notification_id"] = .string(notificationID.uuidString.lowercased()) }
		return properties
	}
}
