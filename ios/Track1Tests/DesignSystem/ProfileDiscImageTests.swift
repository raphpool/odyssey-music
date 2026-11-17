import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The values are spelled out again from the TRA-721 ticket (Figma `362:3008`, the empty disc `362:3129`):
/// a constant changed in `ProfileDiscMetrics` alone fails here.
final class ProfileDiscImageTests: XCTestCase {
	private let expectedAssetNames: [ProfileDisc: String] = [
		.iridescent: "Disc/Iridescent",
		.blue: "Disc/Blue",
		.mint: "Disc/Mint",
		.coral: "Disc/Coral",
		.violet: "Disc/Violet",
		.teal: "Disc/Teal",
	]

	private let expectedLabels: [ProfileDisc: String] = [
		.iridescent: "Disque iridescent",
		.blue: "Disque bleu",
		.mint: "Disque menthe",
		.coral: "Disque corail",
		.violet: "Disque violet",
		.teal: "Disque sarcelle",
	]

	/// The alpha byte of one pixel (`y` counted from the top), read by drawing the image into a 1 x 1 context.
	private func alpha(of image: CGImage, x: Int, y: Int) throws -> UInt8 {
		let space = CGColorSpaceCreateDeviceRGB()
		let info = CGImageAlphaInfo.premultipliedLast.rawValue
		let made = CGContext(
			data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: space, bitmapInfo: info)
		let context = try XCTUnwrap(made, "the 1 x 1 context could not be created")
		let frame = CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height)
		context.draw(image, in: frame)
		let data = try XCTUnwrap(context.data, "the 1 x 1 context has no pixel data")
		return data.load(fromByteOffset: 3, as: UInt8.self)
	}

	private func rgbaBytes(of color: Color) throws -> [UInt8] {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		XCTAssertTrue(UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha))
		return [red, green, blue, alpha].map { UInt8(($0 * 255).rounded()) }
	}

	// MARK: Images

	func testEveryDiscHasItsAssetName() {
		XCTAssertEqual(Set(ProfileDisc.allCases), Set(expectedAssetNames.keys), "a disc has no expected name")
		for disc in ProfileDisc.allCases {
			XCTAssertEqual(ProfileDiscImage.assetName(for: disc), expectedAssetNames[disc], "\(disc)")
		}
	}

	func testEveryDiscLoadsFromTheCatalogue() {
		for disc in ProfileDisc.allCases {
			XCTAssertNotNil(UIImage(named: ProfileDiscImage.assetName(for: disc)), "image of \(disc)")
		}
	}

	func testEveryImageIsASquareOf436PixelsWithoutShadow() throws {
		for disc in ProfileDisc.allCases {
			let name = ProfileDiscImage.assetName(for: disc)
			let cgImage = try XCTUnwrap(UIImage(named: name)?.cgImage, name)
			XCTAssertEqual(cgImage.width, 436, "width of \(name)")
			XCTAssertEqual(cgImage.height, 436, "height of \(name)")
			// The shadow is drawn by the component: a corner outside the circle must be transparent and the
			// middle of the disc (the opaque white centre of the Figma) must not be.
			XCTAssertEqual(try alpha(of: cgImage, x: 0, y: 0), 0, "top left corner of \(name)")
			XCTAssertEqual(try alpha(of: cgImage, x: 435, y: 435), 0, "bottom right corner of \(name)")
			XCTAssertEqual(try alpha(of: cgImage, x: 218, y: 218), 255, "centre of \(name)")
		}
	}

	func testTheEmptyDiscLoadsNoImage() {
		XCTAssertNil(ProfileDiscImage.imageName(for: nil))
		for disc in ProfileDisc.allCases {
			XCTAssertEqual(ProfileDiscImage.imageName(for: disc), expectedAssetNames[disc], "\(disc)")
		}
	}

	// MARK: Empty disc (362:3129)

	func testTheEmptyDiscIsTheTokenColour() throws {
		XCTAssertEqual(try rgbaBytes(of: ProfileDiscMetrics.emptyColor), [0x6F, 0x6F, 0x6F, 255])
		XCTAssertEqual(ProfileDiscMetrics.emptyColor, Track1Tokens.colorDiscEmpty)
	}

	func testTheEmptyOpeningIsAbout7PercentOfTheDisc() {
		XCTAssertEqual(ProfileDiscMetrics.emptyOpeningRatio, 0.0782)
		XCTAssertEqual(ProfileDiscMetrics.emptyOpeningDiameter(size: 100), 7.82, accuracy: 0.0001)
		XCTAssertEqual(ProfileDiscMetrics.emptyOpeningDiameter(size: 72.7), 5.685, accuracy: 0.001)
	}

	func testTheShapeOfTheEmptyDiscHasAHoleOfTheOpeningDiameter() {
		let size: CGFloat = 200
		let opening = ProfileDiscMetrics.emptyOpeningDiameter(size: size)
		let frame = CGRect(x: 0, y: 0, width: size, height: size)
		let path = ProfileDiscShape(openingDiameter: opening).path(in: frame)
		let middle = size / 2
		let radius = opening / 2
		XCTAssertFalse(path.contains(CGPoint(x: middle, y: middle), eoFill: true), "centre")
		XCTAssertFalse(path.contains(CGPoint(x: middle + radius * 0.9, y: middle), eoFill: true), "inside the hole")
		XCTAssertTrue(path.contains(CGPoint(x: middle + radius * 1.1, y: middle), eoFill: true), "outside the hole")
		XCTAssertTrue(path.contains(CGPoint(x: middle, y: middle - size * 0.45), eoFill: true), "on the disc")
		XCTAssertFalse(path.contains(CGPoint(x: 1, y: 1), eoFill: true), "outside the circle")
	}

	func testTheShapeWithoutOpeningIsAFullCircle() {
		let path = ProfileDiscShape(openingDiameter: 0).path(in: CGRect(x: 0, y: 0, width: 100, height: 100))
		XCTAssertTrue(path.contains(CGPoint(x: 50, y: 50), eoFill: true), "centre")
		XCTAssertFalse(path.contains(CGPoint(x: 1, y: 1), eoFill: true), "outside the circle")
	}

	// MARK: Shadow

	func testTheShadowIsThatOfA72Point7Disc() {
		XCTAssertEqual(ProfileDiscMetrics.referenceSize, 72.7)
		XCTAssertEqual(ProfileDiscMetrics.referenceShadow.y, 1.385)
		XCTAssertEqual(ProfileDiscMetrics.referenceShadow.blur, 2.423)
		XCTAssertEqual(ProfileDiscMetrics.referenceShadow.spread, -0.346)
	}

	func testTheShadowIsProportionalToTheSize() {
		let atReference = ProfileDiscMetrics.shadow(size: 72.7)
		XCTAssertEqual(atReference.y, 1.385, accuracy: 0.0001)
		XCTAssertEqual(atReference.blur, 2.423, accuracy: 0.0001)
		XCTAssertEqual(atReference.spread, -0.346, accuracy: 0.0001)
		let doubled = ProfileDiscMetrics.shadow(size: 145.4)
		XCTAssertEqual(doubled.y, 2.77, accuracy: 0.0001)
		XCTAssertEqual(doubled.blur, 4.846, accuracy: 0.0001)
		XCTAssertEqual(doubled.spread, -0.692, accuracy: 0.0001)
	}

	func testTheShadowColourIs13212AAt28Percent() throws {
		// 0.28 * 255 = 71.4, which the byte rounds to 71.
		XCTAssertEqual(try rgbaBytes(of: ProfileDiscMetrics.shadowColor), [0x13, 0x21, 0x2A, 71])
	}

	// MARK: Accessibility

	func testEveryDiscHasItsLabel() {
		XCTAssertEqual(Set(ProfileDisc.allCases), Set(expectedLabels.keys), "a disc has no expected label")
		for disc in ProfileDisc.allCases {
			XCTAssertEqual(ProfileDiscImage.accessibilityLabel(for: disc), expectedLabels[disc], "\(disc)")
		}
	}

	func testTheEmptyDiscHasItsLabel() {
		XCTAssertEqual(ProfileDiscImage.accessibilityLabel(for: nil), "Emplacement vide")
	}

	// MARK: Layout

	/// 0.5 pt of tolerance: a hosting controller may round its size up to the pixel grid.
	@MainActor
	func testTheViewRendersASquareOfItsSize() {
		let discs: [ProfileDisc?] = ProfileDisc.allCases.map(Optional.some) + [nil]
		for disc in discs {
			for size in [CGFloat(40), 72.7, 144] {
				let fitted = UIHostingController(rootView: ProfileDiscImage(disc: disc, size: size))
					.sizeThatFits(in: CGSize(width: 1000, height: 1000))
				XCTAssertEqual(fitted.width, size, accuracy: 0.5, "width for \(String(describing: disc)) at \(size)")
				XCTAssertEqual(fitted.height, size, accuracy: 0.5, "height for \(String(describing: disc)) at \(size)")
			}
		}
	}
}
