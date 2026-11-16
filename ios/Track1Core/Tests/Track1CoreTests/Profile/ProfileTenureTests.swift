import XCTest

@testable import Track1Core

final class ProfileTenureTests: XCTestCase {
	private func calendar(_ identifier: String) -> Calendar {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: identifier) ?? TimeZone(secondsFromGMT: 0) ?? .current
		return calendar
	}

	/// A fixed instant, read in the given calendar's time zone.
	private func date(
		_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12, _ minute: Int = 0, in calendar: Calendar
	) -> Date {
		let components = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
		return calendar.date(from: components) ?? Date(timeIntervalSince1970: 0)
	}

	func testCreatedAndNowOnTheSameDayIsOne() {
		let utc = calendar("UTC")
		let created = date(2026, 3, 10, 0, 5, in: utc)
		let now = date(2026, 3, 10, 23, 55, in: utc)
		XCTAssertEqual(ProfileTenure.days(since: created, now: now, calendar: utc), 1)
	}

	func testCreatedYesterdayAtTwentyThreeFiftyNineAndNowAtZeroZeroOneIsTwo() {
		let utc = calendar("UTC")
		let created = date(2026, 3, 9, 23, 59, in: utc)
		let now = date(2026, 3, 10, 0, 1, in: utc)
		XCTAssertEqual(ProfileTenure.days(since: created, now: now, calendar: utc), 2)
	}

	func testOneHundredFortyFourCalendarDaysApartIsOneHundredFortyFive() {
		let utc = calendar("UTC")
		let created = date(2026, 1, 1, 18, 0, in: utc)
		// 2026-01-01 + 144 days = 2026-05-25.
		let now = date(2026, 5, 25, 9, 0, in: utc)
		XCTAssertEqual(ProfileTenure.days(since: created, now: now, calendar: utc), 145)
	}

	func testTheCountFollowsTheTimeZoneOfTheCalendar() {
		// 23:30 UTC on Jan 14 is already Jan 15 in Paris (UTC+1 in winter), so the same two instants are
		// two calendar days in UTC and one in Paris.
		let utc = calendar("UTC")
		let paris = calendar("Europe/Paris")
		let created = date(2026, 1, 14, 23, 30, in: utc)
		let now = date(2026, 1, 15, 10, 0, in: utc)
		XCTAssertEqual(ProfileTenure.days(since: created, now: now, calendar: utc), 2)
		XCTAssertEqual(ProfileTenure.days(since: created, now: now, calendar: paris), 1)
	}

	func testACalendarDayIsNotTwentyFourHoursAcrossADaylightSavingChange() {
		// Paris springs forward on 2026-03-29, which makes that day 23 hours long. Created at 23:30 on Mar 28 and
		// now at 23:30 on Mar 29 are only 23 hours apart, so dividing a time interval by 24 hours would give 1,
		// yet they sit on two consecutive calendar days: the count is 2.
		let paris = calendar("Europe/Paris")
		let created = date(2026, 3, 28, 23, 30, in: paris)
		let now = date(2026, 3, 29, 23, 30, in: paris)
		XCTAssertEqual(ProfileTenure.days(since: created, now: now, calendar: paris), 2)
	}

	func testACreationDateInTheFutureIsOne() {
		let utc = calendar("UTC")
		let created = date(2026, 3, 20, in: utc)
		let now = date(2026, 3, 10, in: utc)
		XCTAssertEqual(ProfileTenure.days(since: created, now: now, calendar: utc), 1)
	}

	func testTheSuffixIsSingularForOne() {
		XCTAssertEqual(ProfileTenure.suffix(days: 1), "depuis 1 jour")
	}

	func testTheSuffixIsPluralFromTwo() {
		XCTAssertEqual(ProfileTenure.suffix(days: 2), "depuis 2 jours")
		XCTAssertEqual(ProfileTenure.suffix(days: 145), "depuis 145 jours")
	}

	func testTheSuffixReadsAValueBelowOneAsOne() {
		XCTAssertEqual(ProfileTenure.suffix(days: 0), "depuis 1 jour")
		XCTAssertEqual(ProfileTenure.suffix(days: -7), "depuis 1 jour")
	}

	func testThePrefixIsTheFirstLine() {
		XCTAssertEqual(ProfileTenure.prefix, "Tu explores")
	}

	func testTheSpokenLabelReadsTheWholeSentence() {
		XCTAssertEqual(ProfileTenure.spoken(days: 145), "Tu explores track1 depuis 145 jours")
		XCTAssertEqual(ProfileTenure.spoken(days: 1), "Tu explores track1 depuis 1 jour")
	}

	func testTheSpokenLabelReadsAValueBelowOneAsOne() {
		XCTAssertEqual(ProfileTenure.spoken(days: 0), "Tu explores track1 depuis 1 jour")
	}
}
