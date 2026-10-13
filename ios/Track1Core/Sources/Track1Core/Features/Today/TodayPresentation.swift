import Foundation

/// What `TodayViewModel.discover()` handed out for one recommendation: the node to show and the context that
/// attributes its views to the recommendation.
public struct TodayOpening: Equatable, Sendable {
	public let recommendationID: UUID
	public let identity: NodeIdentity
	public let context: NavigationContext

	public init(recommendationID: UUID, identity: NodeIdentity, context: NavigationContext) {
		self.recommendationID = recommendationID
		self.identity = identity
		self.context = context
	}
}

/// The screen the Today tab shows.
public enum TodayScreen: Equatable, Sendable {
	case loading
	case page(TodayOpening)
	case emptyCatalog
	case unavailable
}

/// Which screen the Today tab shows, kept apart from the view so that no choice is made in SwiftUI (H.2).
public enum TodayPresentation {
	/// `opening` only counts for the recommendation it was handed out for: a page for another one would show
	/// yesterday's node under today's date. Until the matching opening arrives the loading screen stays, and
	/// `isRetrying` brings it back for a retry whose result is not in yet.
	public static func screen(state: TodayState, opening: TodayOpening?, isRetrying: Bool) -> TodayScreen {
		if isRetrying { return .loading }
		switch state {
		case .loading:
			return .loading
		case .recommendation(let recommendation):
			guard let opening, opening.recommendationID == recommendation.recommendationID else { return .loading }
			return .page(opening)
		case .emptyCatalog:
			return .emptyCatalog
		case .unavailable:
			return .unavailable
		}
	}

	/// The recommendation to open, or `nil` while there is none. A change of this value is what starts the
	/// impression and the opening: they run once per recommendation, not once per state change.
	public static func recommendationID(of state: TodayState) -> UUID? {
		if case .recommendation(let recommendation) = state { recommendation.recommendationID } else { nil }
	}

	/// The name the breadcrumb shows for the root of the Today stack.
	public static func rootTitle(of state: TodayState) -> String? {
		if case .recommendation(let recommendation) = state { recommendation.name } else { nil }
	}
}
