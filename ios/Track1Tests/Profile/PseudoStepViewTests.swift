import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Pseudo step (`362:1766` empty, `362:2894` filled), TRA-723, read on 2026-11-17 (393 x 852). The keyboard,
/// the focus and the placeholder are the system's: what is tested here is what the screen decides (the
/// measures, what the return key and "Continuer" send, the length bound, the starting text).
@MainActor
final class PseudoStepViewTests: XCTestCase {
	private func rgbaHex(_ color: Color) -> String {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		return [red, green, blue, alpha].map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}

	/// What `onSubmit` received, in order.
	private func sent(by text: String) -> [String] {
		var received: [String] = []
		PseudoStepView.submit(text) { received.append($0) }
		return received
	}

	// MARK: Measures

	func testTitleAndFieldTopsAreTheFigmaValues() {
		XCTAssertEqual(PseudoStepMetrics.titleTop, 164)
		XCTAssertEqual(PseudoStepMetrics.fieldTop, 344)
	}

	/// 164 - 59 = 105 and 344 - 59 = 285: the title and the field land at y 164 and y 344 under the 59 pt
	/// status bar of the 393 x 852 frame.
	func testTopsAreReducedByTheStatusBarOfTheReferenceFrame() {
		XCTAssertEqual(PseudoStepMetrics.referenceTopInset, 59)
		XCTAssertEqual(PseudoStepMetrics.titleTopPadding, 105)
		XCTAssertEqual(PseudoStepMetrics.fieldTopPadding, 285)
	}

	/// `362:1807`: 24 above the button, 32 under it, 16 on the sides.
	func testBarMarginsAreTheFigmaValues() {
		XCTAssertEqual(PseudoStepMetrics.barTopInset, 24)
		XCTAssertEqual(PseudoStepMetrics.barBottomInset, 32)
		XCTAssertEqual(PseudoStepMetrics.barHorizontalInset, 16)
	}

	/// The bar draws its own margins: the screen's numbers must be the ones it really uses.
	func testBarMarginsAreTheOnesOfBottomActionBar() {
		XCTAssertEqual(PseudoStepMetrics.barTopInset, BottomActionBar.topInset)
		XCTAssertEqual(PseudoStepMetrics.barBottomInset, BottomActionBar.bottomInset)
		XCTAssertEqual(PseudoStepMetrics.barHorizontalInset, BottomActionBar.horizontalInset)
	}

	/// Bar of 24 + 52 + 32 = 108 pt from the bottom of the frame: it starts at y 744 on 852.
	func testBarStartsAtY744OnTheReferenceFrame() {
		let button = Track1Tokens.sizeControlLarge
		XCTAssertEqual(button, 52)
		XCTAssertEqual(852 - (PseudoStepMetrics.barTopInset + button + PseudoStepMetrics.barBottomInset), 744)
	}

	// MARK: Style

	func testTitleIsMonoItemInTextPrimary() {
		XCTAssertEqual(PseudoStepMetrics.titleRole, .monoItem)
		XCTAssertEqual(PseudoStepMetrics.titleRole.face, .jetBrainsMonoRegular)
		XCTAssertEqual(PseudoStepMetrics.titleRole.size, 18)
		XCTAssertEqual(PseudoStepMetrics.titleRole.lineHeight, 22)
		XCTAssertEqual(rgbaHex(PseudoStepMetrics.titleColor), "f6e9d8ff", "text/primary")
	}

	/// "Inter" 34 in the Figma, Roboto 34/41 in the app.
	func testFieldIsInputLargeWithPrimaryTextAndTertiaryPlaceholder() {
		XCTAssertEqual(PseudoStepMetrics.fieldRole, .inputLarge)
		XCTAssertEqual(PseudoStepMetrics.fieldRole.face, .robotoRegular)
		XCTAssertEqual(PseudoStepMetrics.fieldRole.size, 34)
		XCTAssertEqual(PseudoStepMetrics.fieldRole.lineHeight, 41)
		XCTAssertEqual(rgbaHex(PseudoStepMetrics.textColor), "f6e9d8ff", "text/primary, 362:2906")
		XCTAssertEqual(rgbaHex(PseudoStepMetrics.placeholderColor), "8d7a6dff", "text/tertiary, 362:2893")
	}

	/// `#3D3429` at the top to `#1A110E` at 33.099 %, read on the root nodes `362:1766` and `362:2894`.
	func testBackgroundIsTheVerticalGradientOfTheRootNodes() {
		let stops = PseudoStepMetrics.backgroundStops
		XCTAssertEqual(stops.count, 2)
		XCTAssertEqual(stops[0].location, 0, accuracy: 0.000001)
		XCTAssertEqual(stops[1].location, 0.33099, accuracy: 0.000001)
		XCTAssertEqual(stops.map { rgbaHex($0.color) }, ["3d3429ff", "1a110eff"])
	}

	// MARK: Copy and identifiers

	func testTextsAreTheFrenchOnesOfTheTicket() {
		XCTAssertEqual(PseudoStepView.title, "C'est quoi ton pseudo ?")
		XCTAssertEqual(PseudoStepView.placeholder, "Slim Shady")
		XCTAssertEqual(PseudoStepView.continueTitle, "Continuer")
	}

	func testIdentifiersAreTheOnesOfTheTicket() {
		XCTAssertEqual(PseudoStepView.titleIdentifier, "onboarding-pseudo-title")
		XCTAssertEqual(PseudoStepView.fieldIdentifier, "onboarding-pseudo-field")
		XCTAssertEqual(PseudoStepView.continueIdentifier, "onboarding-pseudo-continue")
	}

	// MARK: Submission

	func testReturnOnAnEmptyFieldSendsNothing() {
		XCTAssertEqual(sent(by: ""), [])
		XCTAssertFalse(PseudoStepView.submit("") { _ in })
	}

	func testReturnOnSpacesOnlySendsNothing() {
		XCTAssertEqual(sent(by: "   "), [])
		XCTAssertEqual(sent(by: " \t\n "), [])
		XCTAssertFalse(PseudoStepView.submit("   ") { _ in })
	}

	/// A zero width space is neither whitespace nor a control: `PseudoRules` still refuses it.
	func testReturnOnAnInvisibleCharacterSendsNothing() {
		XCTAssertEqual(sent(by: "\u{200B}"), [])
	}

	/// "Raph  " then return: one call, with the stored form.
	func testReturnSendsTheNormalizedPseudoOnce() {
		XCTAssertEqual(sent(by: "Raph  "), ["Raph"])
		XCTAssertTrue(PseudoStepView.submit("Raph  ") { _ in })
	}

	func testSubmissionSendsExactlyWhatPseudoRulesStores() {
		XCTAssertEqual(sent(by: "  Slim   Shady "), [PseudoRules.normalized("  Slim   Shady ")!])
		XCTAssertEqual(sent(by: "  Slim   Shady "), ["Slim Shady"])
	}

	func testContinueIsEnabledOnlyForAPseudoThatNormalizes() {
		XCTAssertFalse(PseudoStepView.isContinueEnabled(""))
		XCTAssertFalse(PseudoStepView.isContinueEnabled("   "))
		XCTAssertTrue(PseudoStepView.isContinueEnabled("Raph"))
		XCTAssertTrue(PseudoStepView.isContinueEnabled("  R  "))
	}

	/// The bar the screen builds: its own identifier, no counter, no fade, one button.
	func testBarHasItsOwnIdentifierAndNoCounterNorFade() {
		let bar = PseudoStepView.actionBar(text: "Raph") { _ in }
		XCTAssertEqual(bar.identifier, "onboarding-pseudo-continue")
		XCTAssertFalse(bar.showsFade)
		XCTAssertEqual(bar.parts, [.button])
	}

	// MARK: Length bound

	func testTheTwentyFirstCharacterDoesNotEnter() {
		let twenty = String(repeating: "a", count: PseudoRules.maxLength)
		XCTAssertEqual(PseudoRules.maxLength, 20)
		XCTAssertEqual(PseudoStepView.bounded(twenty), twenty)
		XCTAssertEqual(PseudoStepView.bounded(twenty + "b"), twenty)
	}

	/// The bound counts graphemes: a family emoji is one character made of five scalars.
	func testTheBoundCountsGraphemesNotScalars() {
		let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
		let twenty = String(repeating: family, count: PseudoRules.maxLength)
		XCTAssertEqual(PseudoStepView.bounded(twenty), twenty)
		XCTAssertEqual(PseudoStepView.bounded(twenty + family).count, PseudoRules.maxLength)
		XCTAssertEqual(PseudoStepView.bounded(twenty + family), twenty)
	}

	func testAShortTextIsKeptAsTyped() {
		XCTAssertEqual(PseudoStepView.bounded(""), "")
		// Spaces stay in the field: the pseudo is cleaned when it is sent.
		XCTAssertEqual(PseudoStepView.bounded("Raph  "), "Raph  ")
	}

	// MARK: Starting text

	/// Back from the next step: the pseudo already chosen fills the field.
	func testInitialPseudoPrefillsTheField() {
		XCTAssertEqual(PseudoStepView.startingText(for: "Raph"), "Raph")
	}

	func testNoInitialPseudoStartsWithAnEmptyField() {
		XCTAssertEqual(PseudoStepView.startingText(for: nil), "")
	}

	func testAPrefilledPseudoCanBeSentAsIs() {
		XCTAssertTrue(PseudoStepView.isContinueEnabled(PseudoStepView.startingText(for: "Raph")))
		XCTAssertEqual(sent(by: PseudoStepView.startingText(for: "Raph")), ["Raph"])
	}

	func testAnInitialPseudoLongerThanTheBoundIsCut() {
		let long = String(repeating: "a", count: PseudoRules.maxLength + 5)
		XCTAssertEqual(PseudoStepView.startingText(for: long).count, PseudoRules.maxLength)
	}
}
