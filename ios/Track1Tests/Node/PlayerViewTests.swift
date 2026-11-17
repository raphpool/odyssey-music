import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The reading part of Figma `338:2461` (TRA-731); the header, the Now bar and the states are TRA-782's.
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

	private func node(article: String, teaser: String?) throws -> NodeDetail {
		let teaserJSON = teaser.map { #""\#($0)""# } ?? "null"
		let source = """
			{"id":"project:sample","type":"project","name":"Sample","teaser":\(teaserJSON),"article":"\(article)","citations":[],"facts":{},"edges":{},"materialized_at":"2026-10-08T00:00:00Z","image_url":null}
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
}
