import Foundation

/// The steps of the onboarding, in the order the flow shows them (see `OnboardingSteps.order`).
public enum OnboardingStepID: String, Hashable, Sendable, CaseIterable {
	case welcome, pseudo, disc, genres, notifications
}

/// Which step comes after which, and whether a step can be left yet.
///
/// Lives in the core rather than in the view so that `swift test` covers it: the view only asks.
public enum OnboardingSteps {
	/// The notification opt-in is not part of the flow until it ships, hence the flag rather than a fixed list.
	public static func order(includesNotifications: Bool) -> [OnboardingStepID] {
		let base: [OnboardingStepID] = [.welcome, .pseudo, .disc, .genres]
		return includesNotifications ? base + [.notifications] : base
	}

	/// Nil after the last step, and for a step that is not in the order (`.notifications` when it is left out).
	public static func next(after step: OnboardingStepID, includesNotifications: Bool) -> OnboardingStepID? {
		let steps = order(includesNotifications: includesNotifications)
		guard let index = steps.firstIndex(of: step), index + 1 < steps.count else { return nil }
		return steps[index + 1]
	}

	/// Nil before the first step, and for a step that is not in the order.
	public static func previous(
		before step: OnboardingStepID,
		includesNotifications: Bool
	) -> OnboardingStepID? {
		let steps = order(includesNotifications: includesNotifications)
		guard let index = steps.firstIndex(of: step), index > 0 else { return nil }
		return steps[index - 1]
	}

	/// Whether the person can move on from `step`. The pseudo goes through `PseudoRules`, so a blank or
	/// invisible one keeps the step locked exactly as the profile would refuse to store it.
	public static func canLeave(
		_ step: OnboardingStepID,
		pseudo: String?,
		disc: ProfileDisc?,
		selectedGenres: Int
	) -> Bool {
		switch step {
		case .welcome, .notifications: return true
		case .pseudo: return PseudoRules.normalized(pseudo ?? "") != nil
		case .disc: return disc != nil
		case .genres: return selectedGenres >= 1
		}
	}
}
