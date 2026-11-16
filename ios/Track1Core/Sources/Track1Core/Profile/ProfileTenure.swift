import Foundation

/// How long the profile has existed, as the foot of the Genres tab says it (Figma `318:7039`): "Tu explores
/// track1 / depuis 145 jours". The view draws the "track1" logotype as an image between `prefix` and
/// `suffix(days:)`, so the two lines are separate strings.
public enum ProfileTenure {
	/// First line, before the "track1" logotype.
	public static let prefix = "Tu explores"

	/// Calendar days elapsed in `calendar`, the creation day counting for 1. The time zone and the day
	/// boundaries come from the injected calendar, never from `Calendar.current`: 23:30 UTC the evening before
	/// is already "today" in Paris. Days are counted between two starts of day rather than by dividing a time
	/// interval by 24 hours, because a day is 23 or 25 hours long when the clocks change. A creation date in
	/// the future (a clock set back on the device) reads as 1 rather than 0 or a negative count.
	public static func days(since createdAt: Date, now: Date, calendar: Calendar) -> Int {
		let start = calendar.startOfDay(for: createdAt)
		let today = calendar.startOfDay(for: now)
		// `dateComponents` always fills the requested `.day`; the fallback only keeps the footer readable
		// (1 day) instead of crashing a screen over a decorative line, should a calendar refuse the difference.
		let elapsed = calendar.dateComponents([.day], from: start, to: today).day ?? 0
		return max(elapsed, 0) + 1
	}

	/// Second line: "depuis 1 jour", "depuis 145 jours". Only 2 and more take the plural. A value below 1
	/// reads as 1, never as "depuis 0 jour": the creation day counts for 1, so
	/// `days(since:now:calendar:)` cannot return less, and a hand-built value is clamped to the same minimum.
	public static func suffix(days: Int) -> String {
		let shown = max(days, 1)
		return "depuis \(shown) \(shown == 1 ? "jour" : "jours")"
	}

	/// What VoiceOver says for the two lines and the logotype together: "Tu explores track1 depuis 145 jours".
	/// The logotype is an image, so the spoken label has to carry the word.
	public static func spoken(days: Int) -> String {
		"\(prefix) track1 \(suffix(days: days))"
	}
}
