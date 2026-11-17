import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The home of the day, Figma `324:1788` (TRA-736): its measures, what it draws without a cover, a subtitle
/// or genres, and which screen the Today tab shows while the node is read.
@MainActor
final class TodayHomeViewTests: XCTestCase {
	private typealias Metrics = TodayHomeMetrics

	private let firstID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
	private let secondID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!

	private static func edge(_ slug: String, _ type: String, _ name: String) -> String {
		#"{"slug":"\#(slug)","type":"\#(type)","name":"\#(name)"}"#
	}

	private func makeNode(facts: String = "{}", edges: String = "") throws -> NodeDetail {
		let source = """
			{"id":"project:cosmogramma","type":"project","name":"Cosmogramma","teaser":null,"article":"","citations":[],"facts":\(facts),"edges":{\(edges)},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
	}

	private func makeHome(facts: String = "{}", edges: String = "") throws -> TodayHome {
		var calendar = Calendar(identifier: .gregorian)
		let paris = try XCTUnwrap(TimeZone(identifier: "Europe/Paris"))
		calendar.timeZone = paris
		let date = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 11, hour: 12)))
		return TodayHome(node: try makeNode(facts: facts, edges: edges), date: date, timeZone: paris)
	}

	private var tint: CoverTint {
		CoverTint(
			stops: [
				LinearRGB(red: 0.29, green: 0.33, blue: 0.32), LinearRGB(red: 0.27, green: 0.26, blue: 0.23),
				LinearRGB(red: 0.20, green: 0.16, blue: 0.13),
			],
			shadow: LinearRGB(red: 0.5, green: 0.4, blue: 0.4))
	}

	private func rgba(_ color: Color) -> [UInt8] {
		var (red, green, blue, alpha) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return [] }
		return [red, green, blue, alpha].map { UInt8(($0 * 255).rounded()) }
	}

	private func recommendation(_ id: UUID) throws -> DailyRecommendation {
		DailyRecommendation(
			recommendationID: id, localDate: "2026-10-11", profileRevision: 1,
			nodeID: try XCTUnwrap(NodeIdentity(rawValue: "project:cosmogramma")), nodeType: .project,
			name: "Cosmogramma", teaser: nil, reasons: [], viewRecorded: false)
	}

	// MARK: - Measures (one test per value of Figma 324:1788)

	func testTheTopBlockStartsAtY72() { XCTAssertEqual(Metrics.topBlockTop, 72) }  // 324:1817

	func testTheTopBlockIs345PointsWide() { XCTAssertEqual(Metrics.topBlockWidth, 345) }

	func testTheDateAndTheGenresAre16PointsApart() { XCTAssertEqual(Metrics.topBlockSpacing, 16) }

	func testTheMainBlockStartsAtY222() { XCTAssertEqual(Metrics.mainBlockTop, 222) }  // 324:1804

	func testTheMainBlockIs343PointsWide() { XCTAssertEqual(Metrics.mainBlockWidth, 343) }

	func testTheChildrenOfTheMainBlockAre12PointsApart() { XCTAssertEqual(Metrics.mainBlockSpacing, 12) }

	func testTheCoverIsASquareOf308Point808() { XCTAssertEqual(Metrics.coverSide, 308.808) }  // 324:1808

	func testTheCoverShadowBlursOver18Point982AndSpreadsOver7Point593() {
		XCTAssertEqual(Metrics.coverShadowBlur, 18.982)
		XCTAssertEqual(Metrics.coverShadowSpread, 7.593)
	}

	func testTheCoverShadowIs121212AtAQuarter() {
		XCTAssertEqual(rgba(Metrics.coverShadowColor), [0x12, 0x12, 0x12, 0x40])
		XCTAssertEqual(rgba(Metrics.coverShadowColor), rgba(Track1Tokens.colorCoverShadow))
	}

	func testTheTitleIsTitle2AndTheSubtitleBodyMedium() {
		XCTAssertEqual(Metrics.titleRole, .title2)  // 324:1811, Bold 22 / 28
		XCTAssertEqual(Metrics.titleRole.size, 22)
		XCTAssertEqual(Metrics.titleRole.lineHeight, 28)
		XCTAssertEqual(Metrics.subtitleRole, .bodyMedium)  // 324:1812, 15 / 22
		XCTAssertEqual(Metrics.subtitleRole.size, 15)
		XCTAssertEqual(Metrics.subtitleRole.lineHeight, 22)
	}

	func testTheSubtitleSitsSixPointsUnderTheTitle() { XCTAssertEqual(Metrics.subtitleSpacing, 6) }

	func testTheIdentifiersAreTheOnesTheUITestsLookFor() {
		XCTAssertEqual(Metrics.identifier, "today-home")
		XCTAssertEqual(Metrics.titleIdentifier, "today-title")
		XCTAssertEqual(DiscoverButtonMetrics.identifier, "today-discover")
	}

	func testTheTabBarOfTheMockupStartsAtY749InAFrameOf844() {
		XCTAssertEqual(Metrics.tabBarTop, 749)
		XCTAssertEqual(Metrics.designHeight, 844)
	}

	/// 308.808 + 25 + (28 + 6 + 22) + 44 and three gaps of 12: the card ends at 691.8, above the bar at 749,
	/// so on a screen of 844 it does not scroll.
	func testTheCardFitsAboveTheTabBarWithoutScrolling() {
		XCTAssertEqual(Metrics.mainBlockHeight, 469.808, accuracy: 0.001)
		XCTAssertLessThanOrEqual(
			Metrics.mainBlockTop + Metrics.mainBlockHeight + Metrics.bottomPadding, Metrics.tabBarTop)
	}

	func testTheTopBlockEndsBeforeTheMainBlockStarts() {
		// 72 (date) + 16 + 28 (one row of genres) from y 72.
		let topBlockHeight = DateBadgeMetrics.height + Metrics.topBlockSpacing + GenrePillMetrics.height
		XCTAssertEqual(topBlockHeight, 116)
		XCTAssertLessThanOrEqual(Metrics.topBlockTop + topBlockHeight, Metrics.mainBlockTop)
	}

	// MARK: - Background

	func testTheBackgroundIsTheFourStopGradientOfTheReader() throws {
		let stops = try XCTUnwrap(Metrics.tintStops(tint))

		XCTAssertEqual(stops.map(\.location), [0, 0.05, 0.10, 0.15, 1])
		for index in 0..<3 {
			XCTAssertEqual(stops[index].color, Color(tint.stops[index]), "band \(index)")
		}
		XCTAssertEqual(stops[3].color, Track1Tokens.colorBackgroundElevated)
		XCTAssertEqual(stops[4].color, Track1Tokens.colorBackgroundElevated)
		XCTAssertEqual(Metrics.tintHeight, 2064)
		XCTAssertEqual(stops.map(\.location), PlayerMetrics.tintStops(tint).map(\.location))
	}

	func testWithoutATintTheBackgroundIsFlat() {
		XCTAssertNil(Metrics.tintStops(nil))
	}

	// MARK: - Cover

	func testWithoutAnImageTheCoverFallsBackOnTheUnavailableArtwork() {
		XCTAssertEqual(TodayHomeContent.cover(hasImage: false), .placeholder)
		XCTAssertEqual(TodayHomeContent.cover(hasImage: true), .image)
		let unavailable = Track1ArtworkStyle.resolve(.unavailable)
		XCTAssertNotNil(unavailable.glyph)
		XCTAssertNotNil(unavailable.border)
	}

	func testThePlaceholderGlyphKeepsTheShareOfTheLargeArtwork() {
		let share = Track1Artwork.Size.large.glyphSize / Track1Artwork.Size.large.points
		XCTAssertEqual(Metrics.placeholderGlyphSize / Metrics.coverSide, share, accuracy: 0.0001)
	}

	func testTheCoverIsLabelledWithTheTitle() {
		XCTAssertEqual(TodayHomeContent.coverAccessibilityLabel(title: "Cosmogramma"), "Pochette de Cosmogramma")
	}

	// MARK: - Texts

	func testTheHomeReadsItsTextsFromTodayHome() throws {
		let idm = Self.edge("genre:idm", "genre", "IDM")
		let glitch = Self.edge("genre:glitch", "genre", "Glitch")
		let artist = Self.edge("artist:flying-lotus", "artist", "Flying Lotus")
		let full = try makeHome(
			facts: #"{"year":"2010"}"#, edges: #""genres":[\#(idm),\#(glitch)],"artists":[\#(artist)]"#)

		XCTAssertEqual(full.day, "11")
		XCTAssertEqual(full.month, "OCT")
		XCTAssertEqual(full.title, "Cosmogramma")
		XCTAssertEqual(full.type, .project)
		XCTAssertEqual(full.genres, ["IDM", "Glitch"])
		XCTAssertTrue(TodayHomeContent.showsGenres(of: full))
		XCTAssertEqual(TodayHomeContent.subtitle(of: full), "Flying Lotus · 2010")
	}

	func testWithoutArtistNorYearTheSubtitleIsLeftOut() throws {
		let bare = try makeHome()

		XCTAssertNil(TodayHomeContent.subtitle(of: bare))
	}

	func testTheSubtitleKeepsTheYearAloneAndTheArtistAlone() throws {
		let artist = Self.edge("artist:flying-lotus", "artist", "Flying Lotus")
		let yearOnly = try makeHome(facts: #"{"year":"2010"}"#)
		let artistOnly = try makeHome(edges: #""artists":[\#(artist)]"#)

		XCTAssertEqual(TodayHomeContent.subtitle(of: yearOnly), "2010")
		XCTAssertEqual(TodayHomeContent.subtitle(of: artistOnly), "Flying Lotus")
	}

	func testWithoutGenresNoRowIsDrawn() throws {
		let bare = try makeHome()

		XCTAssertTrue(bare.genres.isEmpty)
		XCTAssertFalse(TodayHomeContent.showsGenres(of: bare))
	}

	/// Pins the initializer of the contract: the view is built with or without a tint and a cover.
	func testTheViewIsBuiltWithOrWithoutATintAndACover() throws {
		let bare = try makeHome()

		_ = TodayHomeView(home: bare, tint: nil, cover: nil, isOpening: false, discover: {})
		_ = TodayHomeView(home: bare, tint: tint, cover: Image(systemName: "photo"), isOpening: true, discover: {})
	}

	// MARK: - Which screen

	func testALoadingStateKeepsTheLoadingScreen() {
		XCTAssertEqual(TodayHomeScreen.choose(state: .loading, outcome: nil, isRetrying: false), .loading)
	}

	func testTheEmptyCatalogAndTheUnavailableCatalogKeepTheirScreens() {
		XCTAssertEqual(TodayHomeScreen.choose(state: .emptyCatalog, outcome: nil, isRetrying: false), .emptyCatalog)
		XCTAssertEqual(TodayHomeScreen.choose(state: .unavailable, outcome: nil, isRetrying: false), .unavailable)
	}

	func testARecommendationWhoseNodeIsReadShowsTheHome() throws {
		let state = TodayState.recommendation(try recommendation(firstID))

		XCTAssertEqual(TodayHomeScreen.choose(state: state, outcome: .ready(firstID), isRetrying: false), .home)
	}

	func testARecommendationWhoseNodeIsNotReadYetKeepsTheLoadingScreen() throws {
		let state = TodayState.recommendation(try recommendation(firstID))

		XCTAssertEqual(TodayHomeScreen.choose(state: state, outcome: nil, isRetrying: false), .loading)
	}

	func testANodeThatCannotBeReadIsTheRetryStatusNeverAnEmptyCard() throws {
		let state = TodayState.recommendation(try recommendation(firstID))

		XCTAssertEqual(
			TodayHomeScreen.choose(state: state, outcome: .failed(firstID), isRetrying: false), .unavailable)
	}

	func testTheOutcomeOfAnotherRecommendationDoesNotCount() throws {
		let state = TodayState.recommendation(try recommendation(secondID))

		XCTAssertEqual(TodayHomeScreen.choose(state: state, outcome: .ready(firstID), isRetrying: false), .loading)
		XCTAssertEqual(TodayHomeScreen.choose(state: state, outcome: .failed(firstID), isRetrying: false), .loading)
	}

	func testARetryShowsTheLoadingScreenWhateverTheState() throws {
		let state = TodayState.recommendation(try recommendation(firstID))

		XCTAssertEqual(TodayHomeScreen.choose(state: state, outcome: .failed(firstID), isRetrying: true), .loading)
		XCTAssertEqual(TodayHomeScreen.choose(state: .unavailable, outcome: nil, isRetrying: true), .loading)
	}
}
