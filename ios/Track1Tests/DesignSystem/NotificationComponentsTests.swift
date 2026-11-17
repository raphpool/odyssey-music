import SwiftUI
import UIKit
import XCTest

@testable import Track1

/// The values are spelled out again from the TRA-740 ticket (Figma nodes `317:5225` and `317:5226`, read on
/// 2026-11-17): a measure changed in the metrics alone fails here. Each row of a table is one value, named
/// in the failure message.
final class NotificationComponentsTests: XCTestCase {
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

	// MARK: DeviceOutline (317:5225)

	func testDeviceOutlineFrameMatchesFigma() {
		assertMatchesFigma([
			("width", DeviceOutlineMetrics.width, 275),
			("height", DeviceOutlineMetrics.height, 584.971),
		])
	}

	func testDeviceBodyMatchesFigma() {
		let layer = DeviceOutlineMetrics.deviceBody
		assertMatchesFigma([
			("body x", layer.x, 2.38),
			("body y", layer.y, 0),
			("body width", layer.width, 270.231),
			("body height", layer.height, 584.971),
			("body radius", layer.cornerRadius, 44.509),
		])
	}

	func testBezelMatchesFigma() {
		let layer = DeviceOutlineMetrics.bezel
		assertMatchesFigma([
			("bezel x", layer.x, 6.36),
			("bezel y", layer.y, 3.97),
			("bezel width", layer.width, 262.283),
			("bezel height", layer.height, 577.023),
			("bezel radius", layer.cornerRadius, 40.535),
		])
	}

	func testScreenMatchesFigma() {
		let layer = DeviceOutlineMetrics.screen
		assertMatchesFigma([
			("screen x", layer.x, 12.72),
			("screen y", layer.y, 10.33),
			("screen width", layer.width, 249.566),
			("screen height", layer.height, 564.306),
			("screen radius", layer.cornerRadius, 35.766),
		])
	}

	func testIslandMatchesFigma() {
		let layer = DeviceOutlineMetrics.island
		assertMatchesFigma([
			("island x", layer.x, 96.17),
			("island y", layer.y, 21.46),
			("island width", layer.width, 82.659),
			("island height", layer.height, 23.049),
			("island radius", layer.cornerRadius, 15.896),
		])
	}

	func testBodyShadowsMatchFigma() {
		guard DeviceOutlineMetrics.bodyShadows.count == 2 else { return XCTFail("the body has two shadows") }
		let first = DeviceOutlineMetrics.bodyShadows[0]
		let second = DeviceOutlineMetrics.bodyShadows[1]
		assertMatchesFigma([
			("first shadow y", first.y, 1.59),
			("first shadow blur", first.blur, 3.179),
			("first shadow spread", first.spread, 0),
			("second shadow y", second.y, 4.769),
			("second shadow blur", second.blur, 12.717),
			("second shadow spread", second.spread, -1.59),
		])
		XCTAssertEqual(first.opacity, 0.05, "first shadow opacity")
		XCTAssertEqual(second.opacity, 0.1, "second shadow opacity")
	}

	func testDeviceLayersUseTheFigmaColors() {
		XCTAssertEqual(rgbaHex(DeviceOutlineMetrics.bodyColor), "c8b6a3ff", "colorIconSecondary")
		XCTAssertEqual(rgbaHex(DeviceOutlineMetrics.bezelColor), "241713ff", "colorSurfaceDefault")
		XCTAssertEqual(rgbaHex(DeviceOutlineMetrics.screenColor), "1a110eff", "colorBackgroundElevated")
		XCTAssertEqual(rgbaHex(DeviceOutlineMetrics.islandColor), "302019ff", "colorSurfacePressed")
	}

	func testDeviceOutlineIsHiddenFromVoiceOver() {
		XCTAssertTrue(DeviceOutlineMetrics.isAccessibilityHidden)
	}

	@MainActor
	func testDeviceOutlineMeasuresTheFigmaFrame() {
		let host = UIHostingController(rootView: DeviceOutline())
		let size = host.sizeThatFits(in: CGSize(width: 400, height: 1000))
		XCTAssertEqual(size.width, 275, accuracy: 0.5)
		XCTAssertEqual(size.height, 584.971, accuracy: 0.5)
	}

	// MARK: NotificationPreview (317:5226)

	func testPreviewMetricsMatchFigma() {
		assertMatchesFigma([
			("width", NotificationPreviewMetrics.width, 327),
			("padding", NotificationPreviewMetrics.padding, 12),
			("spacing", NotificationPreviewMetrics.spacing, 12),
			("corner radius", NotificationPreviewMetrics.cornerRadius, 12),
			("icon size", NotificationPreviewMetrics.iconSize, 36),
			("text spacing", NotificationPreviewMetrics.textSpacing, 2),
		])
		XCTAssertEqual(NotificationPreviewMetrics.bodyLineLimit, 2)
	}

	/// The mark is `AppMark`, which rounds its corners at 21.875 % of its side: 7.875 pt at 36 pt.
	func testTheMarkHasTheFigmaCornerRadius() {
		XCTAssertEqual(NotificationPreviewMetrics.iconSize * AppMarkMetrics.cornerRatio, 7.875, accuracy: 0.01)
	}

	func testPreviewTextRolesAndColorsMatchFigma() {
		XCTAssertEqual(NotificationPreviewMetrics.titleRole, .labelMedium)
		assertText(.labelMedium, .robotoSemiBold, 15, 20)
		XCTAssertEqual(NotificationPreviewMetrics.bodyRole, .bodySmall)
		assertText(.bodySmall, .robotoRegular, 13, 18)
		XCTAssertEqual(rgbaHex(NotificationPreviewMetrics.titleColor), "f6e9d8ff", "colorTextPrimary")
		XCTAssertEqual(rgbaHex(NotificationPreviewMetrics.bodyColor), "c8b6a3ff", "colorTextSecondary")
	}

	/// The second stop is at 115.85 %, past the bottom edge: the gradient line ends at y = 1.1585.
	func testPreviewGradientMatchesFigma() {
		XCTAssertEqual(rgbaHex(NotificationPreviewMetrics.topColor), "f6e9d81a")
		XCTAssertEqual(rgbaHex(NotificationPreviewMetrics.bottomColor), "f6e9d800")
		XCTAssertEqual(NotificationPreviewMetrics.gradientStart, UnitPoint(x: 0.5, y: 0))
		XCTAssertEqual(NotificationPreviewMetrics.gradientEnd, UnitPoint(x: 0.5, y: 1.1585))
	}

	func testPreviewIsOneAccessibilityElementThatSaysItIsAnExample() {
		let label = NotificationPreviewMetrics.accessibilityLabel(title: "Titre", body: "Corps")
		XCTAssertEqual(label, "Exemple de notification : Titre. Corps")
	}

	@MainActor
	private func previewSize(body: String, width: CGFloat = 327) -> CGSize {
		UIHostingController(rootView: NotificationPreview(title: "Titre", body: body))
			.sizeThatFits(in: CGSize(width: width, height: 1000))
	}

	/// 64 pt: 12 + (title 20 + 2 + one body line 18) + 12. The text column is taller than the 36 pt mark.
	@MainActor
	func testPreviewMeasures327By64WithAOneLineBody() {
		let size = previewSize(body: "Corps")
		XCTAssertEqual(size.width, 327, accuracy: 0.5)
		XCTAssertEqual(size.height, 64, accuracy: 0.5)
	}

	/// 82 pt for two lines (36 pt of body): 12 + (20 + 2 + 36) + 12. A hard line break gives the exact count
	/// whatever the font, so three lines that stay at 82 pt, like a very long body, were cut at two. Without
	/// the limit they would measure 100 pt.
	@MainActor
	func testALongBodyStopsAtTwoLines() {
		let twoLines = previewSize(body: "Un\ndeux")
		let threeLines = previewSize(body: "Un\ndeux\ntrois")
		let long = previewSize(body: String(repeating: "Aphex Twin, album Selected Ambient Works. ", count: 20))
		XCTAssertEqual(twoLines.height, 82, accuracy: 0.5)
		XCTAssertEqual(threeLines.height, twoLines.height, accuracy: 0.5)
		XCTAssertEqual(long.height, twoLines.height, accuracy: 0.5)
	}

	/// 327 pt is a maximum: a wider proposal stops there, a narrower one is filled.
	@MainActor
	func testPreviewWidthIsCappedAt327() {
		XCTAssertEqual(previewSize(body: "Corps", width: 393).width, 327, accuracy: 0.5)
		XCTAssertEqual(previewSize(body: "Corps", width: 300).width, 300, accuracy: 0.5)
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
