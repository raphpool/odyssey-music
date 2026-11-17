import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Disc step (TRA-730), measures of the ticket on the 393 x 852 frame. The move of the disc is SwiftUI's:
/// what is tested here is what the screen decides (the measures, the tints, what a touch reports, the
/// state of the button, the motion branch).
@MainActor
final class DiscStepViewTests: XCTestCase {
	private func components(_ color: Color) -> [CGFloat] {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		return [red, green, blue, alpha]
	}

	private func rgbaHex(_ color: Color) -> String {
		components(color).map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}

	private let accuracy: CGFloat = 0.0001

	private func selectedTiles(_ selected: ProfileDisc?) -> [ProfileDisc] {
		ProfileDisc.allCases.filter {
			DiscStepView.traits(for: $0, selected: selected).contains(.isSelected)
		}
	}

	// MARK: Measures

	func testBackgroundIsTheVerticalGradientOfTheScreen() {
		let stops = DiscStepMetrics.backgroundStops
		XCTAssertEqual(stops.map { rgbaHex($0.color) }, ["3d3429ff", "1a110eff"])
		XCTAssertEqual(stops[0].location, 0, accuracy: 0.000001)
		XCTAssertEqual(stops[1].location, 0.33099, accuracy: 0.000001)
	}

	func testTitleBlockIsAtY164WithAGapOf12() {
		XCTAssertEqual(DiscStepMetrics.titleTop, 164)
		XCTAssertEqual(DiscStepMetrics.titleSpacing, 12)
	}

	func testTitlesAreMonoItemPrimaryAndMonoSectionSecondary() {
		XCTAssertEqual(DiscStepMetrics.titleRole, .monoItem)
		XCTAssertEqual(DiscStepMetrics.titleRole.size, 18)
		XCTAssertEqual(DiscStepMetrics.titleRole.lineHeight, 22)
		XCTAssertEqual(rgbaHex(DiscStepMetrics.titleColor), "f6e9d8ff", "text/primary")
		XCTAssertEqual(DiscStepMetrics.subtitleRole, .monoSection)
		XCTAssertEqual(DiscStepMetrics.subtitleRole.face, .jetBrainsMonoBold)
		XCTAssertEqual(DiscStepMetrics.subtitleRole.size, 15)
		XCTAssertEqual(DiscStepMetrics.subtitleRole.lineHeight, 20)
		XCTAssertEqual(rgbaHex(DiscStepMetrics.subtitleColor), "c8b6a3ff", "text/secondary")
	}

	func testSlotMeasures() {
		XCTAssertEqual(DiscStepMetrics.slotTop, 264.89)
		XCTAssertEqual(DiscStepMetrics.slotSize, 143.838)
		XCTAssertEqual(DiscStepMetrics.slotRadius, 31.465)
		XCTAssertEqual(DiscStepMetrics.slotDiscSize, 122.137)
		XCTAssertEqual(DiscStepMetrics.slotDiscInset, 9.31)
	}

	/// (393 - 143.838) / 2.
	func testSlotIsCenteredOnTheFrame() {
		XCTAssertEqual(DiscStepMetrics.slotLeft, 124.581, accuracy: accuracy)
	}

	func testGridMeasures() {
		XCTAssertEqual(DiscStepMetrics.gridOrigin, CGPoint(x: 43, y: 506))
		XCTAssertEqual(DiscStepMetrics.gridWidth, 306)
		XCTAssertEqual(DiscStepMetrics.gridColumns, 3)
		XCTAssertEqual(DiscStepMetrics.gridRows, 2)
		XCTAssertEqual(DiscStepMetrics.gridSpacing, 22)
	}

	func testTileMeasures() {
		XCTAssertEqual(DiscStepMetrics.tileSize, 85.618)
		XCTAssertEqual(DiscStepMetrics.tileRadius, 18.729)
		XCTAssertEqual(DiscStepMetrics.tileDiscSize, 72.7)
		XCTAssertEqual(DiscStepMetrics.tileDiscInset, 5.54)
	}

	func testReferenceFrameAndBar() {
		XCTAssertEqual(DiscStepMetrics.referenceWidth, 393)
		XCTAssertEqual(DiscStepMetrics.referenceHeight, 852)
		XCTAssertEqual(DiscStepMetrics.referenceTopInset, 59)
		XCTAssertEqual(DiscStepMetrics.barTop, 744)
	}

	/// 24 above the button, 52 for the button, 32 under it: the bar starts at y 744 on 852.
	func testBarStartsAtY744OnTheReferenceFrame() {
		let bar = BottomActionBar.topInset + Track1Tokens.sizeControlLarge + BottomActionBar.bottomInset
		XCTAssertEqual(DiscStepMetrics.referenceHeight - bar, DiscStepMetrics.barTop)
	}

	// MARK: Grid geometry

	func testTilePitchIs107Point618() {
		XCTAssertEqual(DiscStepMetrics.tilePitch, 107.618, accuracy: accuracy)
	}

	/// The six tiles, row by row, in the order of `ProfileDisc.allCases`.
	func testTheSixTilesSitOnThePitchOfTheGrid() {
		let expected: [CGPoint] = [
			CGPoint(x: 43, y: 506), CGPoint(x: 150.618, y: 506), CGPoint(x: 258.236, y: 506),
			CGPoint(x: 43, y: 613.618), CGPoint(x: 150.618, y: 613.618), CGPoint(x: 258.236, y: 613.618),
		]
		XCTAssertEqual(ProfileDisc.allCases.count, expected.count)
		for (index, disc) in ProfileDisc.allCases.enumerated() {
			let origin = DiscStepMetrics.tileOrigin(of: disc)
			XCTAssertEqual(origin.x, expected[index].x, accuracy: accuracy, "x of \(disc)")
			XCTAssertEqual(origin.y, expected[index].y, accuracy: accuracy, "y of \(disc)")
			XCTAssertEqual(origin, DiscStepMetrics.tileOrigin(at: index))
		}
	}

	func testGridFitsItsWidthAndStaysAboveTheBar() {
		let lastColumnEnd = DiscStepMetrics.tileOrigin(at: 2).x + DiscStepMetrics.tileSize
		XCTAssertLessThanOrEqual(lastColumnEnd, DiscStepMetrics.gridOrigin.x + DiscStepMetrics.gridWidth)
		let lastRowEnd = DiscStepMetrics.tileOrigin(at: 3).y + DiscStepMetrics.tileSize
		XCTAssertLessThan(lastRowEnd, DiscStepMetrics.barTop)
	}

	// MARK: Tints

	func testTintOfEachDisc() {
		let expected: [ProfileDisc: String] = [
			.iridescent: "f6e9d8ff",  // 246, 233, 216
			.blue: "d6dbf8ff",  // 214, 219, 248
			.mint: "d6f8edff",  // 214, 248, 237
			.coral: "f8e6d6ff",  // 248, 230, 214
			.violet: "f3d6f8ff",  // 243, 214, 248
			.teal: "d6f0f8ff",  // 214, 240, 248
		]
		XCTAssertEqual(expected.count, ProfileDisc.allCases.count)
		for disc in ProfileDisc.allCases {
			XCTAssertEqual(rgbaHex(DiscStepMetrics.tint(for: disc)), expected[disc], "\(disc)")
		}
	}

	func testAnEmptySlotOrTileTakesTheBlueTint() {
		XCTAssertEqual(rgbaHex(DiscStepMetrics.tint(for: nil)), "d6dbf8ff")
		XCTAssertEqual(rgbaHex(DiscStepMetrics.tint(for: nil)), rgbaHex(DiscStepMetrics.tint(for: .blue)))
	}

	/// 10 % on top; the fade reaches 0 % at 151.15 % of the height, so 1 - 1 / 1.5115 of the ramp is
	/// done at the bottom edge.
	func testGradientGoesFromTenPercentTowardsZeroAt151Percent() {
		XCTAssertEqual(DiscStepMetrics.gradientTopOpacity, 0.1)
		XCTAssertEqual(DiscStepMetrics.gradientZeroAt, 1.5115)
		XCTAssertEqual(DiscStepMetrics.gradientBottomOpacity, 0.1 * (1 - 1 / 1.5115), accuracy: 0.000001)
		XCTAssertEqual(DiscStepMetrics.gradientBottomOpacity, 0.0338, accuracy: 0.0001)
	}

	func testGradientStopsCarryTheTintOfTheDisc() {
		let opacities = [DiscStepMetrics.gradientTopOpacity, DiscStepMetrics.gradientBottomOpacity]
		for disc in ProfileDisc.allCases {
			let stops = DiscStepMetrics.gradientStops(for: disc)
			XCTAssertEqual(stops.map(\.location), [0, 1])
			let tint = components(DiscStepMetrics.tint(for: disc))
			for (stop, opacity) in zip(stops, opacities) {
				let got = components(stop.color)
				for channel in 0..<3 {
					XCTAssertEqual(got[channel], tint[channel], accuracy: 0.002, "\(disc)")
				}
				XCTAssertEqual(got[3], CGFloat(opacity), accuracy: 0.002, "\(disc)")
			}
		}
	}

	// MARK: Copy and identifiers

	func testTextsAreTheFrenchOnesOfTheTicket() {
		XCTAssertEqual(DiscStepView.title, "Bienvenue sur track1")
		XCTAssertEqual(DiscStepView.subtitle, "Choisis ton disque de profil")
		XCTAssertEqual(DiscStepView.continueTitle, "Continuer")
	}

	func testIdentifiersAreTheOnesOfTheTicket() {
		XCTAssertEqual(DiscStepView.slotIdentifier, "onboarding-disc-slot")
		XCTAssertEqual(DiscStepView.continueIdentifier, "onboarding-disc-continue")
		XCTAssertEqual(
			ProfileDisc.allCases.map(DiscStepView.tileIdentifier(for:)),
			[
				"onboarding-disc-iridescent", "onboarding-disc-blue", "onboarding-disc-mint",
				"onboarding-disc-coral", "onboarding-disc-violet", "onboarding-disc-teal",
			])
	}

	// MARK: Without a choice

	func testWithoutAChoiceTheButtonIsDisabledAndContinueIsNeverCalled() {
		XCTAssertFalse(DiscStepView.isContinueEnabled(selected: nil))
		var calls = 0
		XCTAssertFalse(DiscStepView.proceed(selected: nil) { calls += 1 })
		XCTAssertEqual(calls, 0)
	}

	func testWithoutAChoiceNoTileHoldsTheEmptyDiscAndTheSlotIsEmpty() {
		for disc in ProfileDisc.allCases {
			XCTAssertEqual(DiscStepView.containedDisc(in: disc, selected: nil), disc)
			XCTAssertFalse(DiscStepView.traits(for: disc, selected: nil).contains(.isSelected))
		}
		XCTAssertEqual(ProfileDiscImage.accessibilityLabel(for: nil), "Emplacement vide")
	}

	// MARK: After a choice

	func testAChoiceReportsOnceAndEnablesTheButton() {
		var received: [ProfileDisc] = []
		XCTAssertTrue(DiscStepView.choose(.mint, selected: nil) { received.append($0) })
		XCTAssertEqual(received, [.mint])
		XCTAssertTrue(DiscStepView.isContinueEnabled(selected: .mint))
		var calls = 0
		XCTAssertTrue(DiscStepView.proceed(selected: .mint) { calls += 1 })
		XCTAssertEqual(calls, 1)
	}

	func testOnlyTheChosenTileIsSelectedAndItShowsTheEmptyDisc() {
		XCTAssertTrue(DiscStepView.traits(for: .mint, selected: .mint).contains(.isSelected))
		XCTAssertNil(DiscStepView.containedDisc(in: .mint, selected: .mint))
		for disc in ProfileDisc.allCases where disc != .mint {
			XCTAssertFalse(DiscStepView.traits(for: disc, selected: .mint).contains(.isSelected), "\(disc)")
			XCTAssertEqual(DiscStepView.containedDisc(in: disc, selected: .mint), disc)
		}
	}

	/// A second choice replaces the first: the parent keeps the last `onSelect`, and one tile is selected.
	func testASecondChoiceReplacesTheFirst() {
		var selected: ProfileDisc?
		DiscStepView.choose(.blue, selected: selected) { selected = $0 }
		DiscStepView.choose(.coral, selected: selected) { selected = $0 }
		XCTAssertEqual(selected, .coral)
		XCTAssertEqual(selectedTiles(selected), [.coral])
		XCTAssertEqual(DiscStepView.containedDisc(in: .blue, selected: selected), .blue)
	}

	func testTouchingTheEmptyTileOfTheChosenDiscDoesNothing() {
		var received: [ProfileDisc] = []
		XCTAssertFalse(DiscStepView.choose(.teal, selected: .teal) { received.append($0) })
		XCTAssertEqual(received, [])
	}

	// MARK: Accessibility

	func testEveryTileIsAButtonLabelledByTheDiscImage() {
		let labels = ProfileDisc.allCases.map(DiscStepView.tileLabel(for:))
		XCTAssertEqual(
			labels,
			[
				"Disque iridescent", "Disque bleu", "Disque menthe", "Disque corail", "Disque violet",
				"Disque sarcelle",
			])
		for disc in ProfileDisc.allCases {
			XCTAssertEqual(DiscStepView.tileLabel(for: disc), ProfileDiscImage.accessibilityLabel(for: disc))
			XCTAssertTrue(DiscStepView.traits(for: disc, selected: nil).contains(.isButton))
			XCTAssertTrue(DiscStepView.traits(for: disc, selected: disc).contains(.isButton))
		}
	}

	/// No counter, no fade, one button with its own identifier.
	func testBarHasItsOwnIdentifierAndNoCounterNorFade() {
		let bar = DiscStepView.actionBar(selected: nil) {}
		XCTAssertEqual(bar.identifier, "onboarding-disc-continue")
		XCTAssertFalse(bar.showsFade)
		XCTAssertEqual(bar.parts, [.button])
	}

	// MARK: Motion

	func testTheDiscFliesUnlessReduceMotionIsOn() {
		XCTAssertEqual(DiscStepMetrics.movement(reduceMotion: false), .flies)
		XCTAssertEqual(DiscStepMetrics.movement(reduceMotion: true), .crossFades)
	}

	func testTheAnimationIsTheSpringOfTrack1MotionOrAStandardCrossFade() {
		XCTAssertEqual(
			DiscStepMetrics.animation(reduceMotion: false), Track1Motion.spring(reduceMotion: false))
		XCTAssertEqual(
			DiscStepMetrics.animation(reduceMotion: true), .easeInOut(duration: Track1Motion.standard.duration))
		XCTAssertNil(Track1Motion.spring(reduceMotion: true))
	}
}
