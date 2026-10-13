import Foundation

/// Onboarding strings that depend on a value. The words that never change stay in the views and in
/// `OnboardingFlowModel.ctaTitle(forStep:)`.
public enum OnboardingCopy {
	/// "Total : 1 genre", "Total : 2 genres". French treats 0 and 1 as singular (Figma `173:123` shows the
	/// counter of one genre), so only 2 and more take the plural. A negative count cannot come from a
	/// selection: it reads as 0 rather than printing a minus sign.
	public static func counter(_ count: Int) -> String {
		let shown = max(count, 0)
		return "Total : \(shown) \(shown <= 1 ? "genre" : "genres")"
	}
}
