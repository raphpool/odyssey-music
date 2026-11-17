import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// The values are spelled out again from the Figma nodes `324:1818` (date tile), `324:1820` (pills) and
/// `324:1813` ("Découvrir"), read on 2026-11-17 (TRA-727, TRA-765): a measure changed in the metrics alone
/// fails here. Each row of a table is one value, named in the failure message.
final class TodayComponentsTests: XCTestCase {
	private typealias Row = (name: String, actual: CGFloat, figma: CGFloat)

	private func assertMatchesFigma(_ rows: [Row], file: StaticString = #filePath, line: UInt = #line) {
		for row in rows {
			XCTAssertEqual(row.actual, row.figma, row.name, file: file, line: line)
		}
	}

	private func assertText(_ role: Track1TextRole, _ face: Track1FontFace, _ size: CGFloat, _ line: CGFloat) {
		XCTAssertEqual(role.face, face)
		XCTAssertEqual(role.size, size)
		XCTAssertEqual(role.lineHeight, line)
	}

	// MARK: DateBadge (324:1818)

	func testDateBadgeMetricsMatchFigma() {
		assertMatchesFigma([
			("width", DateBadgeMetrics.width, 53),
			("padding", DateBadgeMetrics.padding, 10),
			("text inset", DateBadgeMetrics.textInset, 8.5),
			("corner radius", DateBadgeMetrics.cornerRadius, 16),
			("border width", TodayTileSurface.borderWidth, 1),
			("height", DateBadgeMetrics.height, 72),
		])
		XCTAssertEqual(DateBadgeMetrics.textRole, .title3)
		assertText(.title3, .jetBrainsMonoBold, 20, 25)
	}

	func testTileBorderAndGradientMatchFigma() {
		XCTAssertEqual(rgbaHex(TodayTileSurface.borderColor), "f6e9d814")
		XCTAssertEqual(rgbaHex(TodayTileSurface.topColor), "f6e9d81a")
		XCTAssertEqual(rgbaHex(TodayTileSurface.bottomColor), "f6e9d800")
		XCTAssertEqual(TodayTileSurface.startPoint, .top)
		XCTAssertEqual(TodayTileSurface.endPoint, .bottom)
	}

	func testDateBadgeIsOneAccessibilityElementReadAsDayThenMonth() {
		XCTAssertEqual(DateBadgeMetrics.accessibilityLabel(day: "11", month: "OCT"), "11 OCT")
	}

	@MainActor
	func testDateBadgeMeasures53By72AtTheDefaultTextSize() {
		let host = UIHostingController(rootView: DateBadge(day: "11", month: "OCT"))
		let size = host.sizeThatFits(in: CGSize(width: 390, height: 1000))
		XCTAssertEqual(size.width, 53, accuracy: 0.5)
		XCTAssertEqual(size.height, 72, accuracy: 0.5)
	}

	/// 53 pt is a minimum: a four-letter month widens the tile instead of spilling out of it.
	@MainActor
	func testDateBadgeGrowsForALongerMonth() {
		let host = UIHostingController(rootView: DateBadge(day: "11", month: "JUIL"))
		XCTAssertGreaterThan(host.sizeThatFits(in: CGSize(width: 390, height: 1000)).width, 53)
	}

	// MARK: GenrePillRow (324:1820)

	func testPillMetricsMatchFigma() {
		assertMatchesFigma([
			("spacing", GenrePillMetrics.spacing, 8),
			("horizontal padding", GenrePillMetrics.horizontalPadding, 8),
			("vertical padding", GenrePillMetrics.verticalPadding, 4),
			("corner radius", GenrePillMetrics.cornerRadius, 999),
			("height", GenrePillMetrics.height, 28),
		])
		XCTAssertEqual(GenrePillMetrics.lineLimit, 1)
		XCTAssertEqual(GenrePillMetrics.textRole, .bodySmall)
		assertText(.bodySmall, .robotoRegular, 13, 18)
	}

	@MainActor
	func testNoGenreProducesNoViewAndReservesNoSpace() {
		let host = UIHostingController(rootView: GenrePillRow(genres: []))
		XCTAssertEqual(host.sizeThatFits(in: CGSize(width: 345, height: 1000)), .zero)
	}

	@MainActor
	func testOnePillMeasures28Points() {
		let host = UIHostingController(rootView: GenrePillRow(genres: ["IDM"]))
		XCTAssertEqual(host.sizeThatFits(in: CGSize(width: 345, height: 1000)).height, 28, accuracy: 0.5)
	}

	/// Rows are centered, and a pill that does not fit starts a new row, 8 pt below.
	func testFlowWrapsAndCentersEachRow() {
		let wide = CGSize(width: 150, height: 28)
		let flow = GenrePillFlow.frames(sizes: [wide, wide, CGSize(width: 100, height: 28)], width: 345, spacing: 8)
		XCTAssertEqual(flow.frames[0], CGRect(x: 18.5, y: 0, width: 150, height: 28))
		XCTAssertEqual(flow.frames[1], CGRect(x: 176.5, y: 0, width: 150, height: 28))
		XCTAssertEqual(flow.frames[2], CGRect(x: 122.5, y: 36, width: 100, height: 28))
		XCTAssertEqual(flow.size, CGSize(width: 308, height: 64))
	}

	func testFlowClampsAPillWiderThanTheWidth() {
		let flow = GenrePillFlow.frames(
			sizes: [CGSize(width: 500, height: 28), CGSize(width: 60, height: 28)], width: 300, spacing: 8)
		XCTAssertEqual(flow.frames[0], CGRect(x: 0, y: 0, width: 300, height: 28))
		XCTAssertEqual(flow.frames[1], CGRect(x: 120, y: 36, width: 60, height: 28))
		XCTAssertLessThanOrEqual(flow.size.width, 300)
	}

	func testFlowOfNothingIsEmpty() {
		let flow = GenrePillFlow.frames(sizes: [], width: 345, spacing: 8)
		XCTAssertEqual(flow.size, .zero)
		XCTAssertTrue(flow.frames.isEmpty)
	}

	/// At the largest text size the pills no longer fit on one row: they wrap and stay within the screen.
	@MainActor
	func testPillsWrapInsteadOfLeavingTheScreenAtTheLargestTextSize() {
		let genres = ["IDM", "Glitch", "Ambient", "Drum and bass", "Trip hop"]
		let one = UIHostingController(rootView: GenrePillRow(genres: ["IDM"]).dynamicTypeSize(.accessibility5))
		let many = UIHostingController(rootView: GenrePillRow(genres: genres).dynamicTypeSize(.accessibility5))
		let proposal = CGSize(width: 320, height: 5000)
		let oneRow = one.sizeThatFits(in: proposal).height
		let size = many.sizeThatFits(in: proposal)
		XCTAssertLessThanOrEqual(size.width, 320)
		// At least two rows: two pill heights and the gap between them.
		XCTAssertGreaterThanOrEqual(size.height, 2 * oneRow + GenrePillMetrics.spacing - 0.5)
	}

	// MARK: DiscoverButton (324:1813)

	func testDiscoverButtonMetricsMatchFigma() {
		assertMatchesFigma([
			("leading padding", DiscoverButtonMetrics.leadingPadding, 12),
			("trailing padding", DiscoverButtonMetrics.trailingPadding, 16),
			("vertical padding", DiscoverButtonMetrics.verticalPadding, 12),
			("height", DiscoverButtonMetrics.height, 44),
			("corner radius", DiscoverButtonMetrics.cornerRadius, 999),
			("icon size", DiscoverButtonMetrics.iconSize, 20),
			("icon to label", DiscoverButtonMetrics.iconSpacing, 4),
		])
		XCTAssertEqual(DiscoverButtonMetrics.title, "Découvrir")
		XCTAssertEqual(DiscoverButtonMetrics.identifier, "today-discover")
		XCTAssertEqual(DiscoverButtonMetrics.labelRole, .monoButton)
		assertText(.monoButton, .jetBrainsMonoMedium, 15, 20)
	}

	/// What the button applies, through the metrics the view reads: bone fill, espresso label and icon.
	func testDiscoverColorsMatchFigma() {
		XCTAssertEqual(rgbaHex(DiscoverButtonMetrics.fill), "f6e9d8ff")
		XCTAssertEqual(rgbaHex(DiscoverButtonMetrics.labelColor), "0b0706ff")
		XCTAssertEqual(DiscoverButtonMetrics.iconTone, .inverse)
		XCTAssertEqual(rgbaHex(DiscoverButtonMetrics.pressedFill), "c8b6a3ff")
	}

	func testEachTapCallsTheActionOnce() {
		var calls = 0
		XCTAssertTrue(DiscoverButtonTap.isEnabled(isLoading: false))
		for tap in 1...3 {
			XCTAssertTrue(DiscoverButtonTap.handle(isLoading: false) { calls += 1 })
			XCTAssertEqual(calls, tap)
		}
	}

	func testNoTapCallsTheActionWhileLoading() {
		var calls = 0
		XCTAssertFalse(DiscoverButtonTap.isEnabled(isLoading: true))
		XCTAssertFalse(DiscoverButtonTap.handle(isLoading: true) { calls += 1 })
		XCTAssertEqual(calls, 0)
	}

	@MainActor
	func testDiscoverButtonMeasures44PointsAtTheDefaultTextSize() {
		let host = UIHostingController(rootView: DiscoverButton {})
		XCTAssertEqual(host.sizeThatFits(in: CGSize(width: 390, height: 1000)).height, 44, accuracy: 0.5)
	}

	// MARK: Helpers

	/// `rrggbbaa`, to compare with the Figma hex and to read a failure.
	private func rgbaHex(_ color: Color) -> String {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "no-rgb" }
		return [red, green, blue, alpha].map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}
}
