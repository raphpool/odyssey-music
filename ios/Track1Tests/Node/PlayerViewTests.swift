import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The reader of Figma `338:2461`: its reading (TRA-731), then its header, Now bar and states (TRA-782).
@MainActor
final class PlayerViewTests: XCTestCase {
	private typealias Metrics = PlayerMetrics

	private static let article =
		"The first sentence is long enough to stand alone. The second sentence is also long enough to stand. "
		+ "The third sentence closes the article properly."

	/// Three paragraphs of 100, 200 and 100 pt in an 844 pt screen: the first centred at offset 0 (margin 337),
	/// the last at the largest offset (margin 407, content 1256).
	private static let frames = [
		PlayerItemFrame(minY: 337, height: 100), PlayerItemFrame(minY: 493, height: 200),
		PlayerItemFrame(minY: 749, height: 100),
	]

	private static func edge(_ name: String) -> String {
		#"{"slug":"artist:a","type":"artist","name":"\#(name)"}"#
	}

	private func node(
		article: String = "", teaser: String? = nil, edges: String = "", citations: String = "[]"
	) throws -> NodeDetail {
		let teaserJSON = teaser.map { #""\#($0)""# } ?? "null"
		let source = """
			{"id":"project:sample","type":"project","name":"Sample","teaser":\(teaserJSON),"article":"\(article)","citations":\(citations),"facts":{},"edges":{\(edges)},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return try decoder.decode(NodeDetail.self, from: Data(source.utf8))
	}

	private func rgba(_ color: Color) -> [UInt8] {
		var (red, green, blue, alpha) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return [] }
		return [red, green, blue, alpha].map { UInt8(($0 * 255).rounded()) }
	}

	// MARK: - Measures

	func testTheColumnIs309PointsWide() { XCTAssertEqual(Metrics.columnWidth, 309) }

	func testParagraphsAre56PointsApart() { XCTAssertEqual(Metrics.paragraphSpacing, 56) }

	func testTheReadingCenterIsTheMiddleOfTheMockupParagraph() {
		XCTAssertEqual(Metrics.readingCenter, 387)
		XCTAssertEqual(268 + 238.0 / 2, Metrics.readingCenter, "338:2480 spans y 268 to 506.")
		XCTAssertEqual(Metrics.readingViewport, 774)
	}

	func testRolesColoursAndIdentifiersAreTheMockupOnes() {
		XCTAssertEqual(Metrics.role, .reader)
		XCTAssertEqual(rgba(Metrics.focusedColor), rgba(Track1Tokens.colorTextPrimary))
		XCTAssertEqual(rgba(Metrics.dimColor), [0x8D, 0x7A, 0x6D, 0xFF])
		XCTAssertEqual(Metrics.identifier, "player")
		XCTAssertEqual(Metrics.paragraphIdentifier(2), "player-paragraph-2")
	}

	/// TRA-801: the 20 to 22 pt growth of the focus reflowed the lines while the text was scrolling.
	func testEverySentenceHasTheReaderRoleAndOnlyTheColourTellsTheFocus() {
		XCTAssertEqual(Metrics.role, .reader)
		XCTAssertEqual(Track1TextRole.reader.size, 22)

		let focused = (0..<3).map { rgba(Metrics.color(isFocused: $0 == 1)) }
		let white = rgba(Track1Tokens.colorTextPrimary)
		let dim: [UInt8] = [0x8D, 0x7A, 0x6D, 0xFF]
		XCTAssertEqual(focused, [dim, white, dim])
	}

	func testOnlyTheFocusedSentenceExposesTheFocusValue() {
		XCTAssertEqual(Metrics.focusValue, "focus")
		XCTAssertEqual(Metrics.accessibilityValue(isFocused: true), "focus")
		XCTAssertEqual(Metrics.accessibilityValue(isFocused: false), "")
	}

	/// TRA-801: the colour is the only thing that changes with the focus, and it changes at once.
	func testReduceMotionRemovesTheFadeOfTheFocusColour() {
		XCTAssertNil(Track1Motion.animation(.fast, reduceMotion: true))
		XCTAssertNotNil(Track1Motion.animation(.fast, reduceMotion: false))
	}

	/// TRA-831 (plan player-gradient-tint, D4): the elevated colour is reached at 45 %, below the screen.
	func testTheBackgroundIsTheCoverBandsAt0And15And30PercentThenTheElevatedColourFrom45() {
		let bands = [
			LinearRGB(red: 0.29, green: 0.33, blue: 0.32), LinearRGB(red: 0.27, green: 0.26, blue: 0.23),
			LinearRGB(red: 0.20, green: 0.16, blue: 0.13),
		]
		let stops = Metrics.tintStops(CoverTint(stops: bands, shadow: bands[0]))

		XCTAssertEqual(stops.map(\.location), [0, 0.15, 0.30, 0.45, 1])
		for (stop, band) in zip(stops, bands) { XCTAssertEqual(rgba(stop.color), rgba(Color(band))) }
		for stop in stops.suffix(2) { XCTAssertEqual(rgba(stop.color), [0x1A, 0x11, 0x0E, 0xFF]) }
		XCTAssertEqual(Metrics.tintHeight, 2064)
	}

	/// TRA-831 (D5): the tint covers the whole screen, the dark starts only below its bottom edge.
	func testTheBackgroundOnlyReachesTheElevatedColourBelowTheScreen() {
		XCTAssertGreaterThan(Metrics.tintEndpoint * Metrics.tintHeight, Metrics.designHeight)
	}

	func testTheCoverBandsStrictlyIncreaseAndEndBeforeTheElevatedColour() throws {
		let positions = Metrics.tintPositions
		let last = try XCTUnwrap(positions.last)
		XCTAssertEqual(positions.count, 3)
		for (previous, next) in zip(positions, positions.dropFirst()) { XCTAssertLessThan(previous, next) }
		XCTAssertLessThan(last, Metrics.tintEndpoint)
	}

	func testTheFadeIsClearWhereTheMockupParagraphsReachZero() {
		XCTAssertEqual(42 + 0.05637 * 170, Metrics.fadeTopClear, accuracy: 0.01)
		XCTAssertEqual(562 + 0.89869 * 306, Metrics.fadeBottomClear, accuracy: 0.01)

		let stops = Metrics.fadeStops(height: 844)
		let wanted: [CGFloat] = [0, 51.58, 212, 562, 837, 844].map { $0 / 844 }
		XCTAssertEqual(stops.count, wanted.count)
		for (stop, location) in zip(stops, wanted) { XCTAssertEqual(stop.location, location, accuracy: 0.0001) }
		XCTAssertEqual(stops.map { rgba($0.color)[3] }, [0, 0, 255, 255, 0, 0])
	}

	/// TRA-826 (plan player-source-link, D2 and D3): the source line under the last sentence.
	func testTheSourceLineMeasuresAndColoursAreThePlanOnes() {
		XCTAssertEqual(Metrics.sourceIdentifier, "player-source")
		XCTAssertEqual(Metrics.sourceSpacing, 24)
		XCTAssertEqual(rgba(Metrics.sourceLabelColor), [0xF6, 0xE9, 0xD8, 0xFF])
		XCTAssertEqual(rgba(Metrics.sourceDomainColor), [0xF6, 0xE9, 0xD8, 0xCC])
		XCTAssertEqual(Metrics.sourceDomainOpacity, 0.8)
		XCTAssertEqual(Metrics.sourceTouchOutset, 5, "44 pt of touch on the 34 pt line of the reader role.")
	}

	// MARK: - Paragraphs

	func testThereIsOneParagraphPerSentenceInTheOrderOfTheArticle() throws {
		let sentences = ArticleSentences.split(Self.article)
		XCTAssertEqual(sentences.count, 3)

		let paragraphs = PlayerView.paragraphs(for: try node(article: Self.article, teaser: "Un teaser."))

		XCTAssertEqual(paragraphs, sentences, "The teaser is for an empty article only.")
	}

	func testAnEmptyArticleIsReadFromTheCleanedTeaser() throws {
		let paragraphs = PlayerView.paragraphs(for: try node(article: "", teaser: "Un teaser sans mise en forme."))

		XCTAssertEqual(paragraphs, ["Un teaser sans mise en forme."])
	}

	func testAnEmptyArticleWithoutATeaserShowsTheMessage() throws {
		XCTAssertEqual(PlayerView.emptyMessage, "Pas encore de texte pour cette œuvre.")
		XCTAssertEqual(PlayerView.paragraphs(for: try node(article: "", teaser: nil)), [PlayerView.emptyMessage])
	}

	func testAFrenchNodeIsReadFromItsFrenchArticle() throws {
		let french = "La première phrase est assez longue pour tenir seule. La seconde phrase est aussi longue."
		let source = """
			{"id":"project:sample","type":"project","name":"Sample","teaser":"English teaser.",\
			"article":"\(Self.article)","citations":[],"facts":{},"edges":{},\
			"materialized_at":"2026-10-08T00:00:00Z","image_url":null,\
			"l10n":{"fr":{"teaser":"Un teaser.","article":"\(french)"}}}
			"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		decoder.userInfo[.preferredLanguages] = ["fr-FR"]

		let node = try decoder.decode(NodeDetail.self, from: Data(source.utf8))

		XCTAssertEqual(node.contentLanguage, .fr)
		XCTAssertEqual(PlayerView.paragraphs(for: node), ArticleSentences.split(french))
		XCTAssertNotEqual(PlayerView.paragraphs(for: node), ArticleSentences.split(Self.article))
	}

	// MARK: - Source

	private static let citation = #"[{"url":"https://www.pitchfork.com/reviews/x","title":"Review"}]"#

	func testAnArticleWithACitationHasASource() throws {
		let source = PlayerView.source(for: try node(article: Self.article, citations: Self.citation))

		XCTAssertEqual(source?.domain, "pitchfork.com")
	}

	func testAnArticleWithoutCitationsHasNoSource() throws {
		XCTAssertNil(PlayerView.source(for: try node(article: Self.article, citations: "[]")))
	}

	/// The reader shows `emptyMessage` there: no text, so nothing to attribute.
	func testAnEmptyArticleWithoutATeaserHasNoSourceEvenWithACitation() throws {
		XCTAssertNil(PlayerView.source(for: try node(article: "", teaser: nil, citations: Self.citation)))
	}

	func testAnEmptyArticleReadFromTheTeaserKeepsItsSource() throws {
		let source = PlayerView.source(for: try node(article: "", teaser: "Un teaser.", citations: Self.citation))

		XCTAssertEqual(source?.domain, "pitchfork.com")
	}

	// MARK: - Focus and scroll

	func testTheFocusedParagraphIsTheOneThatHoldsTheReadingCenter() {
		for (offset, index) in [(0, 0), (206, 1), (412, 2)] as [(CGFloat, Int)] {
			let focused = PlayerView.focusedIndex(offset: offset, frames: Self.frames)

			XCTAssertEqual(focused, index, "offset \(offset)")
			XCTAssertEqual(
				focused, PlayerScroll.focusedIndex(offset: Double(offset), viewportHeight: 774, frames: Self.frames))
		}
		XCTAssertEqual(PlayerView.focusedIndex(offset: 0, frames: []), 0, "The first one until they are measured.")
	}

	/// TRA-795: the offset and the frames come in either order, and the focus must follow the last one.
	func testTheFocusFollowsAnOffsetReportedBeforeTheFramesAreMeasured() {
		let offset: CGFloat = 206

		XCTAssertEqual(PlayerView.focusedIndex(offset: offset, frames: []), 0)
		XCTAssertEqual(PlayerView.focusedIndex(offset: offset, frames: Self.frames), 1)
	}

	func testFramesAreReadInTheOrderOfTheParagraphs() {
		let rect = { (frame: PlayerItemFrame) in CGRect(x: 0, y: frame.minY, width: 309, height: frame.height) }
		let reported = [2: rect(Self.frames[2]), 0: rect(Self.frames[0]), 1: rect(Self.frames[1])]

		XCTAssertEqual(PlayerView.items(from: reported), Self.frames)
	}

	func testTheMarginsLetTheFirstAndTheLastParagraphReachTheCentre() {
		XCTAssertEqual(Metrics.topMargin(paragraph: 100), 337)
		XCTAssertEqual(Metrics.bottomMargin(viewport: 844, paragraph: 100), 407)
		XCTAssertEqual(Metrics.topMargin(paragraph: 1000), 0, "A tall paragraph needs none.")
		XCTAssertEqual(Metrics.bottomMargin(viewport: 844, paragraph: 1000), 0)
	}

	func testAGestureSettlesOneParagraphFurtherWithinTheContent() {
		func settled(
			_ origin: CGFloat, _ proposed: CGFloat, content: CGFloat = 1256, _ frames: [PlayerItemFrame] = Self.frames
		) -> CGFloat {
			Metrics.settledOffset(origin: origin, proposed: proposed, viewport: 844, content: content, frames: frames)
		}

		XCTAssertEqual(settled(0, 190), 206, "The middle of the second paragraph (593) goes to 387.")
		XCTAssertEqual(settled(0, 1000), 206, "However far the scroll view proposed, it is one step.")
		XCTAssertEqual(settled(412, 300), 206, "And one step back.")
		XCTAssertEqual(settled(206, 220), 206, "A short gesture comes back to the current paragraph.")
		XCTAssertEqual(settled(412, 1000), 412, "Never past the end of the content.")
		XCTAssertEqual(settled(0, -50), 0, "Never before its start.")
		XCTAssertEqual(settled(206, 400, content: 600), 0, "Kept inside a content that is shorter than the screen.")
		XCTAssertEqual(settled(0, -50, []), 0)
	}

	/// TRA-801: a touch that lands during the scroll of the previous swipe counts from where that scroll was
	/// heading, and the behaviour may be asked twice for one gesture without taking a second step.
	func testTheCarouselCarriesTheTouchBetweenTwoSwipes() {
		let carousel = PlayerCarousel()
		var seen: (origin: Double, touchedAt: Double)?
		func settle(_ proposed: Double, to target: Double, at now: Double) -> Double {
			seen = nil
			return carousel.settle(proposed: proposed, now: now) { origin, touchedAt in
				seen = (origin, touchedAt)
				return target
			}
		}

		carousel.moved(to: 0, at: 10)
		carousel.touch(at: 0, now: 10.01)
		XCTAssertEqual(settle(150, to: 200, at: 10.1), 200)
		XCTAssertEqual(seen?.origin, 0, "At rest it counts from the offset of the touch.")
		XCTAssertEqual(settle(200, to: 999, at: 10.12), 200, "Asked again, it answers the same.")
		XCTAssertNil(seen, "Without counting again.")

		carousel.moved(to: 60, at: 10.30)
		carousel.touch(at: 60, now: 10.31)
		XCTAssertEqual(settle(210, to: 400, at: 10.35), 400)
		XCTAssertEqual(seen?.origin, 200, "Mid-flight it counts from where the scroll was heading.")
		XCTAssertEqual(seen?.touchedAt, 60, "And the displacement from where the finger landed.")

		carousel.moved(to: 150, at: 11)
		_ = settle(300, to: 250, at: 12)
		XCTAssertEqual(seen?.origin, 150, "A scroll that no touch started counts from where it is.")

		carousel.touch(at: 20, now: 13)
		carousel.moved(to: 90, at: 13.05)
		_ = settle(120, to: 100, at: 13.9)
		XCTAssertEqual(seen?.origin, 20, "A finger that paused before it lifted keeps its touch.")

		carousel.touch(at: 5, now: 20)
		_ = settle(300, to: 250, at: 25)
		XCTAssertEqual(seen?.origin, 90, "A tap is not the touch of a scroll that comes much later.")
	}

	// MARK: - Header and Now bar

	func testTheHeaderStartsAt24() { XCTAssertEqual(Metrics.headerLeading, 24) }

	func testTheHeaderStartsAt56FromTheTop() { XCTAssertEqual(Metrics.headerTop, 56) }

	func testTheHeaderAndItsBackButtonAre40PointsHigh() {
		XCTAssertEqual(Metrics.headerHeight, 40)
		XCTAssertEqual(Metrics.backSize, 40)
	}

	func testTheNowBarEnds5PointsAboveTheTabBar() { XCTAssertEqual(Metrics.nowBarGap, 5) }

	func testTheNowBarTopIs694InTheMockupFrame() {
		// 393 x 844 with the 21 pt under the tab bar that Figma draws: the tab bar frame starts at 749.
		XCTAssertEqual(844 - 21 - Track1TabBarMetrics.reservedHeight(safeAreaBottom: 21), 749)
		XCTAssertEqual(844 - Metrics.nowBarBottomInset(safeAreaBottom: 21) - PlayerNowBarMetrics.height, 694)
		XCTAssertEqual(Metrics.nowBarBottomInset(safeAreaBottom: 0), 91, "86 for the tab bar, 5 for the gap.")
	}

	func testTheArtistLineJoinsTheNamesOfTheArtistsEdge() throws {
		let (one, two) = (Self.edge("Band A"), Self.edge(" Band B "))
		let many = try node(edges: #""artists":[\#(one),\#(two)]"#)

		XCTAssertEqual(PlayerView.artistNames(of: many), "Band A, Band B")
		XCTAssertEqual(PlayerView.artistNames(of: try node(edges: #""artists":\#(one)"#)), "Band A")
		XCTAssertNil(PlayerView.artistNames(of: try node()))
	}

	func testNetworkNamesAreDrawnOnOneLineWithoutBidiControls() {
		XCTAssertEqual(PlayerView.oneLine("A\u{202E}B\nC  D\t"), "AB C D")
	}

	// MARK: - States and back

	func testEachStateGetsItsScreenAndAFailedNodeCanBeRetried() throws {
		func name(_ state: NodeViewState) -> String {
			switch PlayerView.screen(for: state) {
			case .reader: "reader"
			case .loading: "loading"
			case .missing: "missing"
			case .failed: "failed"
			}
		}
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "project:sample"))
		let states: [NodeViewState] = [.loading, .loaded(try node()), .missing(identity), .failed]

		XCTAssertEqual(states.map(name), ["loading", "reader", "missing", "failed"])
		XCTAssertEqual(Track1StatusView.visibleActionTitle(for: .nodeFailed, hasAction: true), "Réessayer")
	}

	func testTheBackActionIsTheOneTheCallerGaveAndTheBackButtonHasItsIdentifier() throws {
		var calls = 0
		let identity = try XCTUnwrap(NodeIdentity(rawValue: "project:sample"))
		let model = NodeViewModel(
			identity: identity, context: .independent(source: .home), readNode: { _ in .notModified(etag: "x") })
		let store = NodeImageStore<UIImage>(readImage: { _ in .notModified(etag: "x") }, load: { _ in nil })

		PlayerView(model: model, imageStore: store, safeAreaBottom: 34, onBack: { calls += 1 }).onBack()

		XCTAssertEqual(calls, 1)
		XCTAssertEqual(Metrics.backIdentifier, "player-back")
	}

	func testThePlayerSourceDrawsNoShareControl() throws {
		let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
			.deletingLastPathComponent().appendingPathComponent("Track1/Features/Node/PlayerView.swift")
		let text = try String(contentsOf: source, encoding: .utf8)

		XCTAssertFalse(text.contains("player-share"))
	}
}
