import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The pure rules of the Streaming button and of the Streaming bar (Figma `172:75`, `172:76`, read
/// 2026-10-13) and the brand marks they draw. Main actor: the tests build `View` values.
@MainActor
final class StreamingBarTests: XCTestCase {
	/// Actions in the order `ListeningActions` returns them: Spotify first, which the bar must reverse.
	private func actions(_ type: NodeType = .artist) -> [ListeningAction] {
		ListeningActions.actions(for: type, name: "Sample", links: nil)
	}

	// MARK: - Order

	func testOrderedPutsAppleMusicBeforeSpotify() {
		let listening = actions()
		XCTAssertEqual(listening.map(\.provider), [.spotify, .appleMusic], "The input is in Spotify-first order.")

		let ordered = StreamingBar.ordered(listening)

		XCTAssertEqual(ordered.map(\.provider), [.appleMusic, .spotify])
		XCTAssertEqual(ordered, [listening[1], listening[0]], "Actions are reordered, never rewritten.")
	}

	func testOrderedKeepsAnOrderedListAndASingleAction() {
		let listening = actions()
		let ordered = StreamingBar.ordered(listening.reversed())

		XCTAssertEqual(StreamingBar.ordered(ordered), ordered)
		XCTAssertEqual(StreamingBar.ordered([listening[0]]), [listening[0]])
	}

	func testOrderedOfNothingIsNothing() {
		XCTAssertEqual(StreamingBar.ordered([]), [])
	}

	// MARK: - Presence

	func testNoActionMeansNoBar() {
		XCTAssertFalse(StreamingBar(actions: [], isOpening: false, open: { _ in }).isPresent)
		XCTAssertFalse(StreamingBar(actions: [], isOpening: true, open: { _ in }).isPresent)
	}

	func testAGenreAndALabelGetNoBar() {
		for type in [NodeType.genre, .label] {
			XCTAssertFalse(
				StreamingBar(actions: actions(type), isOpening: false, open: { _ in }).isPresent, "\(type)")
		}
	}

	func testALinkableNodeGetsABar() {
		for type in [NodeType.artist, .project, .track] {
			XCTAssertTrue(
				StreamingBar(actions: actions(type), isOpening: false, open: { _ in }).isPresent, "\(type)")
		}
	}

	// MARK: - Identifiers and names

	func testButtonIdentifiersFollowTheProvider() {
		XCTAssertEqual(StreamingBar.identifier, "streaming-bar")
		XCTAssertEqual(StreamingButton.identifier(for: .appleMusic), "listen-apple_music")
		XCTAssertEqual(StreamingButton.identifier(for: .spotify), "listen-spotify")
		for provider in ListeningProvider.allCases {
			XCTAssertEqual(StreamingButton.identifier(for: provider), "listen-\(provider.rawValue)")
		}
	}

	func testButtonsDrawTheLowercaseNamesOfTheFigma() {
		XCTAssertEqual(StreamingButton.name(for: .appleMusic), "apple music")
		XCTAssertEqual(StreamingButton.name(for: .spotify), "spotify")
	}

	func testTheLogoIs16PointsAndThePillAtLeast44() {
		XCTAssertEqual(StreamingButton.logoSize, 16, accuracy: 0.001)
		XCTAssertEqual(Track1Tokens.sizeControlMedium, 44, accuracy: 0.001)
	}

	// MARK: - Brand marks

	func testEveryProviderHasItsBrandMarkInTheCatalog() {
		XCTAssertEqual(StreamingButton.logoName(for: .appleMusic), "Brand/AppleMusic")
		XCTAssertEqual(StreamingButton.logoName(for: .spotify), "Brand/Spotify")
		for provider in ListeningProvider.allCases {
			let name = StreamingButton.logoName(for: provider)
			XCTAssertNotNil(UIImage(named: name), name)
		}
	}

	func testBrandMarksOfAppleMusicAndSpotifyExist() {
		XCTAssertNotNil(UIImage(named: "Brand/AppleMusic"))
		XCTAssertNotNil(UIImage(named: "Brand/Spotify"))
	}

	func testYouTubeMusicHasNoBrandMark() {
		XCTAssertNil(UIImage(named: "Brand/YouTubeMusic"), "D12: YouTube Music is never offered.")
	}
}
