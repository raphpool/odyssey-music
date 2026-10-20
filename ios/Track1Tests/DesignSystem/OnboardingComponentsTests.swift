import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Genre tile (`175:6`), Subgenre row (`175:27`), Select-all chip (`175:47`) and Bottom action bar
/// (`173:137`), TRA-389. Figma values are spelled out again here, read on 2026-10-13 from the variants
/// `175:2` / `175:4`, `175:21` / `175:24`, `175:39` / `175:43` and `173:123`: a token changed in the
/// components alone fails here. The counter label is tested in the package (`OnboardingCopyTests`).
final class OnboardingComponentsTests: XCTestCase {
	private func components(_ color: Color) -> [Double] {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		return [red, green, blue, alpha].map { Double($0) }
	}

	/// Floats are never compared exactly: a color built from an opacity does not round-trip bit for bit.
	private func assertSameColor(
		_ actual: Color, _ expected: Color, _ message: String = "", file: StaticString = #filePath,
		line: UInt = #line
	) {
		let lhs = components(actual)
		let rhs = components(expected)
		for index in lhs.indices {
			XCTAssertEqual(lhs[index], rhs[index], accuracy: 0.002, message, file: file, line: line)
		}
	}

	private func rgbaHex(_ color: Color) -> String {
		components(color).map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}

	// MARK: Genre tile

	func testSelectedGenreTileResolvesToTheSelectionTokens() {
		let style = GenreTileStyle.resolve(isSelected: true)
		assertSameColor(style.overlay, Track1Tokens.colorSelectionSurface.opacity(0.9), "surface at 90 %")
		XCTAssertEqual(components(style.overlay)[3], 0.9, accuracy: 0.002)
		XCTAssertEqual(style.border.map(rgbaHex), "bc7722ff")
		assertSameColor(style.border ?? .clear, Track1Tokens.colorSelectionBorder)
		assertSameColor(style.content, Track1Tokens.colorSelectionContent)
		XCTAssertEqual(rgbaHex(style.content), "bc7722ff")
	}

	func testDefaultGenreTileUsesTheScrimAndNoBorder() {
		let style = GenreTileStyle.resolve(isSelected: false)
		assertSameColor(style.overlay, Track1Tokens.colorOverlayScrim)
		// Figma draws the scrim at 54.1 %.
		XCTAssertEqual(components(style.overlay)[3], 0.541, accuracy: 0.002)
		XCTAssertNil(style.border)
		assertSameColor(style.content, Track1Tokens.colorTextPrimary)
	}

	func testGenreTileBorderIs3PointsAndTheRatioIs164To176() {
		XCTAssertEqual(GenreTile.borderWidth, 3)
		XCTAssertEqual(GenreTile.aspectRatio, 164.0 / 176.0, accuracy: 0.0001)
	}

	func testOnlyADecodedImageReplacesThePlaceholder() {
		let image = UIImage()
		XCTAssertNil(GenreTile.image(for: nil))
		XCTAssertNil(GenreTile.image(for: .loading))
		XCTAssertNil(GenreTile.image(for: .unavailable))
		XCTAssertTrue(GenreTile.image(for: .image(image)) === image)
	}

	func testPlaceholderGradientIsTheThreeFigmaTokens() {
		let stops = GenreTileStyle.stops
		XCTAssertEqual(stops.map { rgbaHex($0.color) }, ["6a4938ff", "302019ff", "120c0aff", "120c0aff"])
		XCTAssertEqual(stops[0].location, 0, accuracy: 0.0001)
		XCTAssertEqual(stops[1].location, 0.35714, accuracy: 0.0001)
		XCTAssertEqual(stops[2].location, 0.71429, accuracy: 0.0001)
		XCTAssertEqual(GenreTileStyle.angleDegrees, 132.978, accuracy: 0.001)
	}

	func testGradientLineFollowsTheCSSAngleOnTheTileRatio() {
		let tile = GenreTileStyle.gradientPoints(angleDegrees: 132.97863505964398, aspectRatio: 164.0 / 176.0)
		// Corners get the first and last color: the line overshoots the unit square by about 3.5 %.
		XCTAssertEqual(tile.start.x, -0.0352, accuracy: 0.002)
		XCTAssertEqual(tile.start.y, 0.0350, accuracy: 0.002)
		XCTAssertEqual(tile.end.x, 1.0352, accuracy: 0.002)
		XCTAssertEqual(tile.end.y, 0.9650, accuracy: 0.002)

		let toRight = GenreTileStyle.gradientPoints(angleDegrees: 90, aspectRatio: 1)
		XCTAssertEqual(toRight.start.x, 0, accuracy: 0.0001)
		XCTAssertEqual(toRight.end.x, 1, accuracy: 0.0001)
		XCTAssertEqual(toRight.start.y, 0.5, accuracy: 0.0001)
		let toBottom = GenreTileStyle.gradientPoints(angleDegrees: 180, aspectRatio: 1)
		XCTAssertEqual(toBottom.start.y, 0, accuracy: 0.0001)
		XCTAssertEqual(toBottom.end.y, 1, accuracy: 0.0001)
	}

	func testGenreTileIdentifierCarriesTheFamilyKey() {
		XCTAssertEqual(GenreTile.identifier(for: "electronic"), "genre-tile-electronic")
	}

	// MARK: Subgenre row and Select-all chip

	func testSelectedChoiceResolvesToTheSelectionTokens() {
		let style = OnboardingChoiceColors.resolve(isSelected: true)
		XCTAssertEqual(rgbaHex(style.fill), "1a110eff", "background/elevated")
		XCTAssertEqual(rgbaHex(style.border), "bc7722ff", "selection/border")
		XCTAssertEqual(rgbaHex(style.title), "bc7722ff", "selection/content")
		XCTAssertEqual(rgbaHex(style.detail), "bc7722ff", "selection/content")
		assertSameColor(style.fill, Track1Tokens.colorBackgroundElevated)
		assertSameColor(style.border, Track1Tokens.colorSelectionBorder)
		assertSameColor(style.title, Track1Tokens.colorSelectionContent)
		assertSameColor(style.detail, Track1Tokens.colorSelectionContent)
	}

	func testDefaultChoiceHasNoFillAndTheContrastBorder() {
		let style = OnboardingChoiceColors.resolve(isSelected: false)
		XCTAssertEqual(components(style.fill)[3], 0, accuracy: 0.001, "no fill")
		XCTAssertEqual(rgbaHex(style.border), "ffffff85", "border/contrast")
		assertSameColor(style.border, Track1Tokens.colorBorderContrast)
		assertSameColor(style.title, Track1Tokens.colorTextPrimary)
		assertSameColor(style.detail, Track1Tokens.colorTextSecondary)
	}

	func testChoiceBorderIs2Points() {
		XCTAssertEqual(OnboardingChoiceColors.borderWidth, 2)
	}

	func testSubgenreDescriptionIsCutAtTwoLines() {
		XCTAssertEqual(SubgenreRow.descriptionLineLimit, 2)
	}

	func testABlankSubgenreDescriptionDrawsNothing() {
		XCTAssertNil(SubgenreRow.visibleDescription(nil))
		XCTAssertNil(SubgenreRow.visibleDescription(""))
		XCTAssertNil(SubgenreRow.visibleDescription("  \n "))
		XCTAssertEqual(SubgenreRow.visibleDescription("Warm and soulful."), "Warm and soulful.")
	}

	func testSubgenreSpokenLabelJoinsNameAndDescription() {
		XCTAssertEqual(
			SubgenreRow.accessibilityLabel(name: "Deep House", description: "Warm and soulful."),
			"Deep House, Warm and soulful.")
		XCTAssertEqual(SubgenreRow.accessibilityLabel(name: "Deep House", description: " "), "Deep House")
	}

	func testSubgenreIdentifierCarriesTheTaxonomyID() {
		XCTAssertEqual(SubgenreRow.identifier(for: "Q10413"), "subgenre-row-Q10413")
	}

	func testSelectAllShowsAChevronUntilEverySubgenreIsIn() {
		XCTAssertEqual(SelectAllChip.glyph(isSelected: false), .chevronDown)
		XCTAssertEqual(SelectAllChip.glyph(isSelected: true), .check)
		XCTAssertEqual(SelectAllChip.title, "Tous")
		XCTAssertEqual(SelectAllChip.identifier, "select-all")
	}

	// MARK: Subgenre chip

	func testSubgenreChipIdentifierCarriesTheTaxonomyID() {
		XCTAssertEqual(SubgenreChip.identifier(for: "Q10413"), "subgenre-chip-Q10413")
	}

	func testSubgenreChipGlyphFitsTheLabelLineHeight() {
		XCTAssertEqual(SubgenreChip.glyphSize, 16)
	}

	// MARK: Genre accordion card

	func testGenreCardIdentifierCarriesTheFamilyKey() {
		XCTAssertEqual(GenreAccordionCard<EmptyView>.identifier(for: "hip-hop"), "genre-card-hip-hop")
	}

	func testGenreCardChevronIs20Points() {
		XCTAssertEqual(GenreAccordionCard<EmptyView>.chevronSize, 20)
	}

	func testGenreCardCornerRadiusIs20() {
		XCTAssertEqual(GenreAccordionCardStyle.cornerRadius, 20)
	}

	func testExpandedGenreCardIsOnTheDefaultSurface() {
		let background = GenreAccordionCardStyle.background(isExpanded: true)
		XCTAssertEqual(rgbaHex(background), "241713ff", "surface/default")
		assertSameColor(background, Track1Tokens.colorSurfaceDefault)
	}

	func testCollapsedGenreCardIsOnTheElevatedBackground() {
		let background = GenreAccordionCardStyle.background(isExpanded: false)
		XCTAssertEqual(rgbaHex(background), "1a110eff", "background/elevated")
		assertSameColor(background, Track1Tokens.colorBackgroundElevated)
	}

	func testGenreCardAccentIsThePrimaryTextUntilASubgenreIsTicked() {
		let accent = GenreAccordionCardStyle.accent(selectedCount: 0)
		XCTAssertEqual(rgbaHex(accent), "f6e9d8ff", "text/primary")
		assertSameColor(accent, Track1Tokens.colorTextPrimary)
	}

	func testGenreCardAccentIsTheSelectionColorOnceASubgenreIsTicked() {
		for count in [1, 4] {
			let accent = GenreAccordionCardStyle.accent(selectedCount: count)
			XCTAssertEqual(rgbaHex(accent), "bc7722ff", "selection/content, \(count) ticked")
			assertSameColor(accent, Track1Tokens.colorSelectionContent)
		}
	}

	func testGenreCardSpokenLabelStopsAtTheCountWhenNothingIsTicked() {
		XCTAssertEqual(
			GenreAccordionCard<EmptyView>.accessibilityLabel(title: "Hip-hop", subgenreCount: 13, selectedCount: 0),
			"Hip-hop, 13 sous-genres")
	}

	func testGenreCardSpokenLabelAddsTheSelectedCountWithoutParentheses() {
		XCTAssertEqual(
			GenreAccordionCard<EmptyView>.accessibilityLabel(title: "Jazz", subgenreCount: 13, selectedCount: 4),
			"Jazz, 13 sous-genres, 4 sélectionnés")
	}

	func testGenreCardSpokenLabelIsSingularForOne() {
		XCTAssertEqual(
			GenreAccordionCard<EmptyView>.accessibilityLabel(title: "Rock", subgenreCount: 1, selectedCount: 1),
			"Rock, 1 sous-genre, 1 sélectionné")
	}

	// MARK: Bottom action bar

	func testBottomBarIdentifiers() {
		XCTAssertEqual(BottomActionBar.actionIdentifier, "bottom-action")
		XCTAssertEqual(BottomActionBar.counterIdentifier, "bottom-counter")
	}

	func testBottomBarFadesFromTransparentToTheBaseBackgroundByThirtyFivePercent() {
		let stops = BottomActionBar.fadeStops
		XCTAssertEqual(stops.count, 3)
		for (stop, expected) in zip(stops, [0.0, 0.35, 1.0]) {
			XCTAssertEqual(stop.location, expected, accuracy: 0.0001)
		}
		XCTAssertEqual(stops.map { rgbaHex($0.color) }, ["120c0a00", "120c0aff", "120c0aff"])
	}

	@MainActor
	func testBottomBarKeepsBottomActionAsItsDefaultIdentifier() {
		let bar = BottomActionBar(title: "Continuer", isEnabled: true, counter: nil) {}
		XCTAssertEqual(bar.identifier, "bottom-action")
	}

	@MainActor
	func testBottomBarPutsThePassedIdentifierOnItsButton() {
		let bar = BottomActionBar(title: "Continuer", isEnabled: true, counter: nil, identifier: "custom-id") {}
		XCTAssertEqual(bar.identifier, "custom-id")
	}

	@MainActor
	func testBottomBarDrawsItsFadeUnlessTold() {
		let plain = BottomActionBar(title: "Continuer", isEnabled: true, counter: nil) {}
		let bare = BottomActionBar(title: "Continuer", isEnabled: true, counter: nil, showsFade: false) {}
		XCTAssertTrue(plain.showsFade)
		XCTAssertFalse(bare.showsFade)
	}

	// MARK: Onboarding screens' bars (TRA-440)

	@MainActor
	func testWelcomeBarHasItsOwnIdentifierAndNoFade() {
		let bar = WelcomeView.actionBar {}
		XCTAssertEqual(bar.identifier, "onboarding-start")
		XCTAssertFalse(bar.showsFade)
	}

	@MainActor
	func testSubgenresBarHasItsOwnIdentifierAndKeepsTheFade() {
		let bar = SubgenresStepView.actionBar(title: "Continuer", counter: "2 sélectionnés") {}
		XCTAssertEqual(bar.identifier, "onboarding-subgenres-continue")
		XCTAssertTrue(bar.showsFade)
	}
}
