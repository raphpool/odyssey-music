import Foundation
import XCTest

@testable import Track1Core

final class TodayPresentationTests: XCTestCase {
	private let firstID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
	private let secondID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!

	private func recommendation(
		_ id: UUID, name: String = "Miles Davis", genreNames: [String] = []
	) throws -> DailyRecommendation {
		DailyRecommendation(
			recommendationID: id, localDate: "2026-10-13", profileRevision: 1,
			nodeID: try XCTUnwrap(NodeIdentity(rawValue: "artist:miles-davis")), nodeType: .artist, name: name,
			teaser: nil, reasons: [], profileGenreNames: genreNames, viewRecorded: false)
	}

	func testTheReasonLineReadsTheGenreNamesOfTheRecommendation() throws {
		let state = TodayState.recommendation(
			try recommendation(firstID, genreNames: ["IDM", "Glitch", "Ambient"]))

		XCTAssertEqual(TodayPresentation.reasonLine(of: state), "parce que tu explores IDM - Glitch - Ambient")
	}

	func testARecommendationWithoutGenreNamesHasNoReasonLine() throws {
		XCTAssertNil(TodayPresentation.reasonLine(of: .recommendation(try recommendation(firstID))))
	}

	func testStatesWithoutARecommendationHaveNoReasonLine() {
		for state in [TodayState.loading, .emptyCatalog, .unavailable] {
			XCTAssertNil(TodayPresentation.reasonLine(of: state))
		}
	}

	private func opening(_ id: UUID) throws -> TodayOpening {
		TodayOpening(
			recommendationID: id, identity: try XCTUnwrap(NodeIdentity(rawValue: "artist:miles-davis")),
			context: NavigationContext(source: .home, recommendationID: id))
	}

	func testLoadingStaysLoadingWhateverTheOpening() throws {
		XCTAssertEqual(TodayPresentation.screen(state: .loading, opening: nil, isRetrying: false), .loading)
		XCTAssertEqual(
			TodayPresentation.screen(state: .loading, opening: try opening(firstID), isRetrying: false), .loading)
	}

	func testARecommendationWaitsForItsOpeningBeforeShowingThePage() throws {
		let state = TodayState.recommendation(try recommendation(firstID))

		XCTAssertEqual(TodayPresentation.screen(state: state, opening: nil, isRetrying: false), .loading)
		XCTAssertEqual(
			TodayPresentation.screen(state: state, opening: try opening(firstID), isRetrying: false),
			.page(try opening(firstID)))
	}

	func testAnOpeningOfAnotherRecommendationNeverShowsItsPage() throws {
		// A new profile revision replaces the recommendation: the old page must not stay under the new date.
		let state = TodayState.recommendation(try recommendation(secondID))

		XCTAssertEqual(
			TodayPresentation.screen(state: state, opening: try opening(firstID), isRetrying: false), .loading)
	}

	func testEmptyCatalogAndUnavailableShowTheirOwnScreen() throws {
		XCTAssertEqual(
			TodayPresentation.screen(state: .emptyCatalog, opening: try opening(firstID), isRetrying: false),
			.emptyCatalog)
		XCTAssertEqual(
			TodayPresentation.screen(state: .unavailable, opening: nil, isRetrying: false), .unavailable)
	}

	func testARetryInFlightShowsLoadingInEveryState() throws {
		let page = TodayState.recommendation(try recommendation(firstID))

		for state in [TodayState.unavailable, .emptyCatalog, .loading, page] {
			XCTAssertEqual(
				TodayPresentation.screen(state: state, opening: try opening(firstID), isRetrying: true), .loading)
		}
	}

	func testTheRecommendationIDChangesOnlyWithTheRecommendation() throws {
		let first = TodayState.recommendation(try recommendation(firstID))
		var viewed = try recommendation(firstID)
		viewed.viewRecorded = true

		// The impression marker rewrites the state; it must not start the opening again.
		XCTAssertEqual(TodayPresentation.recommendationID(of: first), firstID)
		XCTAssertEqual(TodayPresentation.recommendationID(of: .recommendation(viewed)), firstID)
		XCTAssertEqual(
			TodayPresentation.recommendationID(of: .recommendation(try recommendation(secondID))), secondID)
		XCTAssertNil(TodayPresentation.recommendationID(of: .loading))
		XCTAssertNil(TodayPresentation.recommendationID(of: .unavailable))
	}

	func testTheRootTitleIsTheNameOfTheRecommendedNode() throws {
		XCTAssertEqual(
			TodayPresentation.rootTitle(of: .recommendation(try recommendation(firstID, name: "Boards of Canada"))),
			"Boards of Canada")
		XCTAssertNil(TodayPresentation.rootTitle(of: .emptyCatalog))
	}
}
