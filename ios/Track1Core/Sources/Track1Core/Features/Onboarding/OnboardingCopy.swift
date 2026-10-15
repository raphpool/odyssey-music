import Foundation

/// Onboarding strings that depend on a value. The words that never change stay in the views and in
/// `GenreOnboardingModel.ctaTitle(forStep:)`.
public enum OnboardingCopy {
	/// "Total : 1 genre", "Total : 2 genres". French treats 0 and 1 as singular (Figma `173:123` shows the
	/// counter of one genre), so only 2 and more take the plural. A negative count cannot come from a
	/// selection: it reads as 0 rather than printing a minus sign.
	public static func counter(_ count: Int) -> String {
		let shown = max(count, 0)
		return "Total : \(shown) \(shown <= 1 ? "genre" : "genres")"
	}

	/// The help line of the genre step (1.3). With no genre ticked a family stands for all of its genres, so
	/// "Tous" and an empty list give the same profile (plan Q1); the screen says so. The wording holds whether
	/// or not a row is ticked, so the line stays on screen and ticking a first row never shifts the list.
	public static let wholeFamilyHint = "Sans sous-genre coché, toute la famille compte."

	/// "2 familles · 5 sous-genres", the count the settings show for a saved selection. Same French rule as
	/// `counter`: 0 and 1 are singular. The genre part counts the ticked genres, so a family left whole adds
	/// none ("1 famille · 0 sous-genre"). A negative count reads as 0.
	public static func selectionSummary(families: Int, genres: Int) -> String {
		let familyCount = max(families, 0)
		let genreCount = max(genres, 0)
		return "\(familyCount) \(familyCount <= 1 ? "famille" : "familles")"
			+ " · \(genreCount) \(genreCount <= 1 ? "sous-genre" : "sous-genres")"
	}
}
