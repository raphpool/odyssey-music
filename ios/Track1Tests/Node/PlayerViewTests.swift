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

	private func node(article: String = "", teaser: String? = nil, edges: String = "") throws -> NodeDetail {
		let teaserJSON = teaser.map { #""\#($0)""# } ?? "null"
		let source = """
			{"id":"project:sample","type":"project","name":"Sample","teaser":\(teaserJSON),"article":"\(article)","citations":[],"facts":{},"edges":{\(edges)},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
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
		XCTAssertEqual(Metrics.focusedRole, .reader)
		XCTAssertEqual(Metrics.dimRole, .readerDim)
		XCTAssertEqual(rgba(Metrics.focusedColor), rgba(Track1Tokens.colorTextPrimary))
		XCTAssertEqual(rgba(Metrics.dimColor), [0x8D, 0x7A, 0x6D, 0xFF])
		XCTAssertEqual(Metrics.identifier, "player")
		XCTAssertEqual(Metrics.paragraphIdentifier(2), "player-paragraph-2")
	}

	func testTheBackgroundIsTheCoverBandsAt0And5And10PercentThenTheElevatedColour() {
		let bands = [
			LinearRGB(red: 0.29, green: 0.33, blue: 0.32), LinearRGB(red: 0.27, green: 0.26, blue: 0.23),
			LinearRGB(red: 0.20, green: 0.16, blue: 0.13),
		]
		let stops = Metrics.tintStops(CoverTint(stops: bands, shadow: bands[0]))

		XCTAssertEqual(stops.map(\.location), [0, 0.05, 0.10, 0.15, 1])
		for (stop, band) in zip(stops, bands) { XCTAssertEqual(rgba(stop.color), rgba(Color(band))) }
		for stop in stops.suffix(2) { XCTAssertEqual(rgba(stop.color), [0x1A, 0x11, 0x0E, 0xFF]) }
		XCTAssertEqual(Metrics.tintHeight, 2064)
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

	// MARK: - Focus and scroll

	func testExactlyOneParagraphIsInTheReaderRoleAndItIsTheFocusedOne() {
		for (offset, index) in [(0, 0), (206, 1), (412, 2)] as [(CGFloat, Int)] {
			let focused = PlayerView.focusedIndex(offset: offset, frames: Self.frames)
			let roles = (0..<3).map { PlayerView.role(forParagraph: $0, focusedIndex: focused) }

			XCTAssertEqual(focused, index, "offset \(offset)")
			XCTAssertEqual(
				focused, PlayerScroll.focusedIndex(offset: Double(offset), viewportHeight: 774, frames: Self.frames))
			XCTAssertEqual(roles.filter { $0 == .reader }.count, 1)
			XCTAssertEqual(roles.firstIndex(of: .reader), index)
		}
		XCTAssertEqual(PlayerView.focusedIndex(offset: 0, frames: []), 0, "The first one until they are measured.")
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

	func testAScrollSettlesOnTheCentredParagraphWithinTheContent() {
		func settled(_ proposed: CGFloat, _ frames: [PlayerItemFrame] = Self.frames) -> CGFloat {
			Metrics.snappedOffset(proposed: proposed, viewport: 844, content: 1256, frames: frames)
		}

		XCTAssertEqual(settled(190), 206, "The middle of the second paragraph (593) goes to 387.")
		XCTAssertEqual(settled(1000), 412, "Never past the end of the content.")
		XCTAssertEqual(settled(-50), 0, "Never before its start.")
		XCTAssertEqual(settled(-50, []), 0)
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
