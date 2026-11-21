import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The player's sticky bar (Figma `338:2493`, TRA-728). Main actor: the tests build `View` values and
/// measure them in a hosting controller.
@MainActor
final class PlayerNowBarTests: XCTestCase {
	private typealias Metrics = PlayerNowBarMetrics

	/// Actions in the order `ListeningActions` returns them: Spotify first, which the bar must reverse.
	private func actions(_ type: NodeType = .artist) -> [ListeningAction] {
		ListeningActions.actions(for: type, name: "Cosmogramma", links: nil)
	}

	private func bar(
		title: String = "Cosmogramma", artist: String? = "Flying Lotus",
		cover: Image? = Image(systemName: "music.note"), actions: [ListeningAction]? = nil,
		isOpening: Bool = false
	) -> PlayerNowBar {
		PlayerNowBar(
			title: title, artist: artist, cover: cover, actions: actions ?? self.actions(), isOpening: isOpening,
			open: { _ in })
	}

	/// The size the bar takes when the page proposes `width`: its own width when there is room for it.
	private func size(of view: some View, width: CGFloat = 1000) -> CGSize {
		UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 1000))
	}

	private func rgbaBytes(_ color: Color) -> [UInt8] {
		var (red, green, blue, alpha) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
		guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return [] }
		return [red, green, blue, alpha].map { UInt8(($0 * 255).rounded()) }
	}

	func testEveryMeasureMatchesTheMockup() {
		let expected: [(String, CGFloat, CGFloat)] = [
			("pill radius (full)", Metrics.cornerRadius, 999),
			("side padding", Metrics.horizontalPadding, 20),
			("vertical padding", Metrics.verticalPadding, 4),
			("gap between blocks", Metrics.blockSpacing, 16),
			("height", Metrics.height, 50),
			("mockup width", Metrics.designWidth, 306.3),
			("cover 338:2517", Metrics.coverSize, 30.881),
			("gap in the text block", Metrics.textSpacing, 0),
			("title size", Metrics.titleRole.size, 16),
			("title line height", Metrics.titleRole.lineHeight, 24),
			("artist size", Metrics.artistRole.size, 13),
			("artist line height", Metrics.artistRole.lineHeight, 18),
			("brand mark", Metrics.logoSize, 17.6),
			("arrow", Metrics.arrowSize, 18.7),
			("mark to arrow", Metrics.markSpacing, 4.4),
			("touch target", Metrics.minimumTouchTarget, 44),
		]
		for (name, actual, wanted) in expected {
			XCTAssertEqual(actual, wanted, accuracy: 0.0001, name)
		}
	}

	func testRolesColorsAndIdentifiersAreTheMockupOnes() {
		XCTAssertEqual(Metrics.titleRole, .monoBarTitle)
		XCTAssertEqual(Metrics.titleRole.face, .jetBrainsMonoBold)
		XCTAssertEqual(Metrics.artistRole, .bodySmall)
		XCTAssertEqual(rgbaBytes(Metrics.fill), [0xFF, 0xFF, 0xFF, 0x26], "colorGlassPill: #FFFFFF at 15 %.")
		XCTAssertEqual(rgbaBytes(Metrics.fill), rgbaBytes(Track1Tokens.colorGlassPill))
		XCTAssertEqual(rgbaBytes(Metrics.titleColor), rgbaBytes(Track1Tokens.colorTextPrimary))
		XCTAssertEqual(rgbaBytes(Metrics.artistColor), rgbaBytes(Track1Tokens.colorTextPrimary))
		XCTAssertEqual(rgbaBytes(Metrics.arrowColor), rgbaBytes(Track1Tokens.colorIconPrimary))
		XCTAssertEqual(Metrics.identifier, "player-now-bar")
		XCTAssertEqual(Metrics.buttonIdentifier(for: .appleMusic), "player-open-apple_music")
		XCTAssertEqual(Metrics.buttonIdentifier(for: .spotify), "player-open-spotify")
	}

	/// Before iOS 26 the bar keeps its flat `colorGlassPill`; from iOS 26 it is drawn as a glass capsule.
	func testBarIsFlatBeforeIOS26AndGlassFromIOS26() {
		XCTAssertEqual(BarSurface.surface(isGlassAvailable: false), .flat)
		XCTAssertEqual(BarSurface.surface(isGlassAvailable: true), .glass)
		XCTAssertEqual(rgbaBytes(Metrics.fill), rgbaBytes(Track1Tokens.colorGlassPill))
	}

	func testAServiceDrawsItsMarkAndArrowAndReachesAtLeast44() {
		let visual = Metrics.serviceVisualSize
		let outset = Metrics.touchOutset
		XCTAssertEqual(visual.width, 17.6 + 4.4 + 18.7, accuracy: 0.001)
		XCTAssertEqual(visual.height, 18.7, accuracy: 0.001)
		XCTAssertGreaterThanOrEqual(visual.width + 2 * outset.width, 44 - 0.001)
		XCTAssertGreaterThanOrEqual(visual.height + 2 * outset.height, 44 - 0.001)
	}

	func testServicesAreAppleMusicThenSpotify() {
		let listening = actions()
		XCTAssertEqual(listening.map(\.provider), [.spotify, .appleMusic], "The input is Spotify first.")
		let shown = bar(actions: listening).buttonActions
		XCTAssertEqual(shown.map(\.provider), [.appleMusic, .spotify])
		XCTAssertEqual(shown, StreamingBar.ordered(listening), "The order is the Streaming bar's.")
	}

	func testZeroOneAndTwoActionsGiveZeroOneAndTwoButtons() {
		XCTAssertTrue(bar(actions: []).buttonActions.isEmpty)
		for type in [NodeType.genre, .label] {
			XCTAssertTrue(bar(actions: actions(type)).buttonActions.isEmpty, "\(type)")
		}
		for action in actions() {
			XCTAssertEqual(bar(actions: [action]).buttonActions, [action], "\(action.provider)")
		}
		XCTAssertEqual(bar(actions: actions()).buttonActions.count, 2)
	}

	func testWithoutAnActionTheBarKeepsItsCoverAndItsText() {
		let chrome = 2 * Metrics.horizontalPadding + Metrics.coverSize + Metrics.blockSpacing
		let title = size(of: Track1Text("Cosmogramma", role: Metrics.titleRole, verbatim: true)).width
		let artist = size(of: Track1Text("Flying Lotus", role: Metrics.artistRole, verbatim: true)).width
		XCTAssertEqual(size(of: bar(actions: [])).width, chrome + max(title, artist), accuracy: 0.5)
	}

	/// A button adds one gap and what it draws: its 44 x 44 touch area is not in the layout.
	func testEachButtonWidensTheBarByItsDrawnSizeAndOneGap() {
		let listening = actions()
		let none = size(of: bar(actions: [])).width
		let one = size(of: bar(actions: [listening[0]])).width
		let two = size(of: bar(actions: listening)).width
		let step = Metrics.blockSpacing + Metrics.serviceVisualSize.width
		XCTAssertEqual(one - none, step, accuracy: 0.5)
		XCTAssertEqual(two - one, step, accuracy: 0.5)
	}

	func testButtonsAreDisabledWhileALinkOpens() {
		XCTAssertTrue(bar(isOpening: true).buttonsAreDisabled)
		XCTAssertFalse(bar(isOpening: false).buttonsAreDisabled)
		XCTAssertEqual(bar(isOpening: true).buttonActions.count, 2, "They are disabled, not removed.")
	}

	func testTheLabelOfAButtonIsTheTitleOfItsAction() {
		for action in actions() {
			XCTAssertEqual(PlayerNowBar.accessibilityLabel(for: action), action.title, "\(action.provider)")
			XCTAssertTrue(action.title.contains(action.provider.displayName), action.title)
		}
	}

	func testTitleAndArtistAreDrawnVerbatim() {
		// Read as Markdown, `**Gras**` would lose its asterisks: the bar would be narrower than the text.
		let (title, artist) = ("**Gras** %@ `x`", "*Flying* _Lotus_")
		let width = size(of: bar(title: title, artist: artist, cover: nil, actions: [])).width
		let chrome = 2 * Metrics.horizontalPadding + Metrics.coverSize + Metrics.blockSpacing
		let verbatim = size(of: Track1Text(title, role: Metrics.titleRole, verbatim: true)).width
		let artistWidth = size(of: Track1Text(artist, role: Metrics.artistRole, verbatim: true)).width
		let parsed = size(of: Track1Text(title, role: Metrics.titleRole)).width

		XCTAssertNotEqual(parsed, verbatim, accuracy: 0.5, "The sample must tell Markdown from verbatim.")
		XCTAssertEqual(width - chrome, max(verbatim, artistWidth), accuracy: 0.5)
	}

	func testAMissingOrBlankArtistDrawsNoSecondLine() {
		for artist in [nil, "", "  \n "] as [String?] { XCTAssertNil(bar(artist: artist).shownArtist) }
		XCTAssertEqual(bar(artist: "Flying Lotus").shownArtist, "Flying Lotus")
	}

	func testThePillIs50PointsHighWhateverItHolds() {
		for artist in [nil, "Flying Lotus"] as [String?] {
			for cover in [nil, Image(systemName: "music.note")] as [Image?] {
				for count in 0...2 {
					let shown = bar(artist: artist, cover: cover, actions: Array(actions().prefix(count)))
					XCTAssertEqual(
						size(of: shown).height, Metrics.height, accuracy: 0.5,
						"artist \(artist ?? "none"), cover \(cover == nil ? "none" : "image"), \(count) actions")
				}
			}
		}
	}

	func testTheBarIsAsWideAsItsContentLikeTheMockup() {
		XCTAssertEqual(size(of: bar()).width, Metrics.designWidth, accuracy: 1)
	}

	func testWithoutACoverThePlaceholderTakesTheSizeOfTheCover() {
		let (image, placeholder) = (bar(), bar(cover: nil))
		XCTAssertEqual(size(of: placeholder).width, size(of: image).width, accuracy: 0.5)
		XCTAssertEqual(size(of: placeholder).height, size(of: image).height, accuracy: 0.5)
	}

	func testALongTitleAndTheLargestTextSizeKeepTheButtonsInThePill() {
		let long = String(repeating: "Cosmogramma ", count: 12)
		let proposed = Metrics.designWidth
		XCTAssertLessThanOrEqual(size(of: bar(title: long, artist: long), width: proposed).width, proposed + 0.5)
		let largest = bar(title: long, artist: long).dynamicTypeSize(.accessibility5)
		XCTAssertLessThanOrEqual(size(of: largest, width: proposed).width, proposed + 0.5)
	}
}
