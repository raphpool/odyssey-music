import SwiftUI
import XCTest

@testable import Track1

/// The numbers are spelled out again here from the TRA-711 ticket (Figma nodes `362:4944` and `362:4910`
/// and the notification preview): a constant changed in `AppMarkMetrics` alone fails here.
final class AppMarkTests: XCTestCase {
	func testTheImageIsInTheCatalogueAsASquareOf552Pixels() throws {
		XCTAssertEqual(AppMark.imageName, "Brand/AppMark")
		let image = try XCTUnwrap(UIImage(named: "Brand/AppMark"))
		let cgImage = try XCTUnwrap(image.cgImage)
		XCTAssertEqual(cgImage.width, 552)
		XCTAssertEqual(cgImage.height, 552)
	}

	func testTheMetricsAreThoseOfTheMockUp() {
		XCTAssertEqual(AppMarkMetrics.cornerRatio, 0.21875)
		XCTAssertEqual(AppMarkMetrics.splashSize, 184.32)
		XCTAssertEqual(AppMarkMetrics.welcomeSize, 122.88)
		XCTAssertEqual(AppMarkMetrics.notificationSize, 36)
	}

	func testTheCornerRadiusIsThatOfTheFigmaNodes() {
		XCTAssertEqual(AppMarkMetrics.cornerRatio * 184.32, 40.32, accuracy: 0.01, "splash, 362:4944")
		XCTAssertEqual(AppMarkMetrics.cornerRatio * 122.88, 26.88, accuracy: 0.01, "Welcome, 362:4910")
		XCTAssertEqual(AppMarkMetrics.cornerRatio * 36, 7.875, accuracy: 0.01, "notification preview")
	}

	/// 0.5 pt of tolerance: a hosting controller may round its size up to the pixel grid (184.32 pt is
	/// 552.96 px at 3x).
	@MainActor
	func testTheViewRendersASquareOfItsSize() {
		for size in [AppMarkMetrics.notificationSize, AppMarkMetrics.welcomeSize, AppMarkMetrics.splashSize] {
			let fitted = UIHostingController(rootView: AppMark(size: size))
				.sizeThatFits(in: CGSize(width: 1000, height: 1000))
			XCTAssertEqual(fitted.width, size, accuracy: 0.5, "width for \(size)")
			XCTAssertEqual(fitted.height, size, accuracy: 0.5, "height for \(size)")
		}
	}

	func testTheViewCarriesTheAppMarkIdentifier() {
		XCTAssertEqual(AppMark.identifier, "app-mark")
	}
}
