import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// Genre tile (`175:6`), the chip colors (`SubgenreChip`, Figma `Select-all chip` `175:47`), the accordion
/// card and Bottom action bar (`173:137`), TRA-389. Figma values are spelled out again here, read on
/// 2026-10-13 from the variants `175:2` / `175:4`, `175:21` / `175:24`, `175:39` / `175:43` and `173:123`: a
/// token changed in the components alone fails here. The counter label is tested in the package
/// (`OnboardingCopyTests`).
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

	// MARK: Chip colors

	/// Figma `316:5084` (read 2026-11-17, TRA-725): the chip has no fill in either state.
	func testDefaultChipHasTheSubtleBorderAndThePrimaryText() {
		let style = SubgenreChipStyle.resolve(isSelected: false)
		// `#F6E9D8` at 10 % in Figma, `0x1A` = 10.2 % in the token.
		XCTAssertEqual(rgbaHex(style.border), "f6e9d81a", "border/subtle")
		assertSameColor(style.border, Track1Tokens.colorBorderSubtle)
		XCTAssertEqual(rgbaHex(style.title), "f6e9d8ff", "text/primary")
		assertSameColor(style.title, Track1Tokens.colorTextPrimary)
	}

	func testSelectedChipHasTheIconPrimaryBorderAndTheSamePrimaryText() {
		let style = SubgenreChipStyle.resolve(isSelected: true)
		XCTAssertEqual(rgbaHex(style.border), "f6e9d8ff", "icon/primary")
		assertSameColor(style.border, Track1Tokens.colorIconPrimary)
		assertSameColor(style.title, Track1Tokens.colorTextPrimary)
	}

	func testChipMeasuresAreTheFigmaValues() {
		XCTAssertEqual(SubgenreChipStyle.borderWidth, 2)
		XCTAssertEqual(SubgenreChipStyle.horizontalPadding, 12)
		XCTAssertEqual(SubgenreChipStyle.verticalPadding, 8)
		XCTAssertEqual(SubgenreChipStyle.glyphSpacing, 8)
		XCTAssertEqual(SubgenreChipStyle.glyphSize, 16)
		XCTAssertEqual(SubgenreChipStyle.titleRole, .monoTag)
		XCTAssertEqual(SubgenreChipStyle.titleRole.size, 13)
		XCTAssertEqual(SubgenreChipStyle.titleRole.lineHeight, 16)
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

	// MARK: Genre accordion card, Figma `316:5078` and `316:5095` (TRA-725)

	func testGenreCardMeasuresAreTheFigmaValues() {
		XCTAssertEqual(GenreAccordionCardMetrics.cornerRadius, 20)
		XCTAssertEqual(GenreAccordionCardMetrics.leadingInset, 24)
		XCTAssertEqual(GenreAccordionCardMetrics.trailingInset, 16)
		XCTAssertEqual(GenreAccordionCardMetrics.verticalInset, 11)
		XCTAssertEqual(GenreAccordionCardMetrics.chevronSize, 20)
		XCTAssertEqual(GenreAccordionCardMetrics.titleSpacing, 8)
		XCTAssertEqual(GenreAccordionCardMetrics.countLineSpacing, 8)
		XCTAssertEqual(GenreAccordionCardMetrics.bodyVerticalInset, 12)
		XCTAssertEqual(GenreAccordionCardMetrics.chevronGap, 8)
	}

	func testGenreCardTextRolesAreTheFigmaOnes() {
		XCTAssertEqual(GenreAccordionCardMetrics.titleRole, .monoItem)
		XCTAssertEqual(GenreAccordionCardMetrics.titleRole.size, 18)
		XCTAssertEqual(GenreAccordionCardMetrics.titleRole.lineHeight, 22)
		XCTAssertEqual(GenreAccordionCardMetrics.badgeRole, .monoTag)
		XCTAssertEqual(GenreAccordionCardMetrics.badgeRole.size, 13)
		XCTAssertEqual(GenreAccordionCardMetrics.badgeRole.lineHeight, 16)
		XCTAssertEqual(GenreAccordionCardMetrics.countRole, .bodySmall)
		XCTAssertEqual(GenreAccordionCardMetrics.countRole.size, 13)
		XCTAssertEqual(GenreAccordionCardMetrics.countRole.lineHeight, 18)
	}

	/// Figma `316:5083` (expanded) and `316:5101`, `316:5106` (collapsed), read 2026-11-17: the same chevron
	/// pointing down in both states. One constant serves both, so the card cannot turn it by state.
	func testGenreCardChevronPointsTheSameWayExpandedAndCollapsed() {
		XCTAssertEqual(GenreAccordionCardMetrics.chevronRotationDegrees, 0)
	}

	func testCollapsedGenreCardIsSeventyPointsHighByTheMetrics() {
		XCTAssertEqual(GenreAccordionCardMetrics.collapsedHeight, 70, accuracy: 0.0001)
	}

	/// The same number read off a real layout, at the 361 pt a card has on a 393 pt screen (393 - 2 x 16).
	@MainActor
	func testACollapsedGenreCardIsSeventyPointsHighAtThe361PointCardWidth() {
		let card = GenreAccordionCard(
			title: "Jazz", subgenreCount: 13, selectedCount: 4, isExpanded: false, identifier: "genre-card-jazz",
			onToggle: {}, content: { EmptyView() }
		)
		let size = UIHostingController(rootView: card).sizeThatFits(in: CGSize(width: 361, height: 1000))
		XCTAssertEqual(size.width, 361, accuracy: 0.5)
		XCTAssertEqual(size.height, 70, accuracy: 0.5)
	}

	func testGenreCardIsOnTheCardSurfaceWhateverItsState() {
		let background = GenreAccordionCardStyle.background
		XCTAssertEqual(rgbaHex(background), "2a241dff", "surface/card")
		assertSameColor(background, Track1Tokens.colorSurfaceCard)
	}

	func testGenreCardTitleAndBadgeAreThePrimaryTextWhateverTheSelection() {
		XCTAssertEqual(rgbaHex(GenreAccordionCardStyle.title), "f6e9d8ff", "text/primary")
		assertSameColor(GenreAccordionCardStyle.title, Track1Tokens.colorTextPrimary)
	}

	func testGenreCardCountLineIsTheSecondaryText() {
		XCTAssertEqual(rgbaHex(GenreAccordionCardStyle.count), "c8b6a3ff", "text/secondary")
		assertSameColor(GenreAccordionCardStyle.count, Track1Tokens.colorTextSecondary)
	}

	func testGenreCardChevronIsTheIconPrimary() {
		XCTAssertEqual(rgbaHex(GenreAccordionCardStyle.chevron), "f6e9d8ff", "icon/primary")
		assertSameColor(GenreAccordionCardStyle.chevron, Track1Tokens.colorIconPrimary)
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

	func testGenreCardBadgeDrawsNothingBelowOne() {
		XCTAssertNil(GenreAccordionCard<EmptyView>.badge(selectedCount: 0))
		XCTAssertNil(GenreAccordionCard<EmptyView>.badge(selectedCount: -1))
	}

	func testGenreCardBadgeIsTheNumberBetweenParentheses() {
		XCTAssertEqual(GenreAccordionCard<EmptyView>.badge(selectedCount: 4), "(4)")
	}

	// MARK: Card header layout (TRA-664)

	private static let foldingTitle = "Musiques traditionnelles d'Afrique et d'Orient"

	/// Where the header of a collapsed card puts its title, its badge and its count line, read off a real
	/// layout at the width of the screen (a 402 pt screen leaves 321 pt in the header).
	@MainActor
	private func headerFrames(badge: String?) -> [String: CGRect] {
		let box = HeaderFrameBox()
		let host = UIHostingController(
			rootView: HeaderLayoutProbe(title: Self.foldingTitle, badge: badge, width: 321) { box.frames = $0 })
		let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
		window.rootViewController = host
		window.makeKeyAndVisible()
		host.view.layoutIfNeeded()
		RunLoop.current.run(until: Date().addingTimeInterval(0.3))
		return box.frames
	}

	/// 2026-10-23 (TRA-664 review, macOS probe, same on `main`): `Track1LineHeightLayout.sizeThatFits` forwarded the
	/// height a stack proposes when it places its children, a `Text` offered too little height reports the
	/// clipped one, and a title folded on three lines was given a two-line frame inside a three-line slot: the
	/// text overran the "N sous-genres" line under it. The frame of the title must be that of its lines, and the
	/// count line must start right under it.
	@MainActor
	func testAFoldedTitleKeepsAFrameAsTallAsItsLinesAndTheCountLineStaysUnderIt() throws {
		for badge in [nil, "(1)"] as [String?] {
			let frames = headerFrames(badge: badge)
			let title = try XCTUnwrap(frames["title"], "title, badge \(badge ?? "none")")
			let count = try XCTUnwrap(frames["count"], "count line")
			let alone = UIHostingController(
				rootView: Track1Text(Self.foldingTitle, role: .monoItem, verbatim: true).frame(width: title.width)
			).sizeThatFits(in: CGSize(width: title.width, height: 1000))
			XCTAssertGreaterThan(alone.height, 22, "the title must fold for this test to mean something")
			XCTAssertEqual(title.height, alone.height, accuracy: 0.5, "title height, badge \(badge ?? "none")")
			XCTAssertEqual(title.minY, 0, accuracy: 0.5, "the title starts at the top of the header")
			XCTAssertEqual(count.minY, title.maxY + Track1Tokens.spacing8, accuracy: 0.5, "count line")
		}
	}

	/// With a badge next to a folded title `.firstTextBaseline` must reach the baseline of the first line: a
	/// custom layout that gives none falls back to its bottom edge and the badge lands on the last line (macOS
	/// probe, 2026-10-24).
	@MainActor
	func testTheBadgeSitsOnTheFirstLineOfAFoldedTitle() throws {
		let frames = headerFrames(badge: "(1)")
		let title = try XCTUnwrap(frames["title"])
		let badge = try XCTUnwrap(frames["badge"])
		XCTAssertGreaterThan(title.height, 22, "the title must fold for this test to mean something")
		XCTAssertLessThanOrEqual(badge.midY, title.minY + 22, "badge \(badge) on the first line of \(title)")
	}

	// MARK: Subgenre chip flow (TRA-679)

	private static let longChipName = "North American Indigenous Music"

	/// Where a flow of `width` points puts each chip and itself, read off a real layout, by title and `"flow"`.
	@MainActor
	private func chipFlowFrames(
		_ titles: [String], width: CGFloat, rowAlignment: ChipRowAlignment = .center
	) -> [String: CGRect] {
		let box = HeaderFrameBox()
		let host = UIHostingController(
			rootView: ChipFlowProbe(titles: titles, width: width, rowAlignment: rowAlignment) { box.frames = $0 })
		let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
		window.rootViewController = host
		window.makeKeyAndVisible()
		host.view.layoutIfNeeded()
		RunLoop.current.run(until: Date().addingTimeInterval(0.3))
		return box.frames
	}

	/// A chip alone in a column of `width` points.
	@MainActor
	private func chipSize(_ title: String, width: CGFloat) -> CGSize {
		UIHostingController(
			rootView: SubgenreChip(title: title, isSelected: false) {}.frame(width: width)
		).sizeThatFits(in: CGSize(width: width, height: 1000))
	}

	/// 2026-10-24 (TRA-679, macOS probe, same on `main`): a chip wider than its row was posed at the row width
	/// with the height of one line, while its text folded: the pill grew out of its slot over the next chip. The
	/// chip must take the height it has alone at that width, and the next row must start under it.
	@MainActor
	func testAChipWiderThanTheRowFoldsAndTheNextRowStartsUnderIt() throws {
		let frames = chipFlowFrames([Self.longChipName, "Emo Rap"], width: 160)
		let long = try XCTUnwrap(frames[Self.longChipName])
		let next = try XCTUnwrap(frames["Emo Rap"])
		let flow = try XCTUnwrap(frames["flow"])
		let alone = chipSize(Self.longChipName, width: 160)
		XCTAssertLessThanOrEqual(long.width, 160.5, "the chip stays inside the row")
		XCTAssertGreaterThanOrEqual(long.height, 51.5, "the name must fold for this test to mean something")
		XCTAssertEqual(long.height, alone.height, accuracy: 0.5, "the chip takes its height alone at 160 pt")
		XCTAssertEqual(next.minY, long.maxY + Track1Tokens.spacing8, accuracy: 0.5, "next row")
		XCTAssertEqual(flow.height, long.height + Track1Tokens.spacing8 + 36, accuracy: 0.5, "flow height")
	}

	/// A chip that fits keeps the exact shape it had: a 36 pt pill, whose corners are half of that.
	@MainActor
	func testAChipThatFitsKeepsThePillHeightAndRadius() {
		XCTAssertEqual(chipSize("Trap", width: 300).height, 36, accuracy: 0.5)
		XCTAssertEqual(SubgenreChip.cornerRadius(lineHeight: 16), 18)
	}

	// MARK: Chip row alignment (TRA-700)

	private static let foldedChipName = "Mauritanian Traditional"
	private static let shortChipName = "Sai"
	/// 2026-10-24 (TRA-700, macOS probe): at 195 pt "Mauritanian Traditional" folds on two lines (52 pt, 122 pt
	/// wide) and leaves room for "Sai" (36 pt) on its row. The probe puts both in one row from 185 to 205 pt.
	private static let sharedRowWidth: CGFloat = 195

	/// The folded chip and the short one of a shared row, read off a real layout, once the preconditions hold
	/// so that the alignment tests below cannot pass on an empty case.
	@MainActor
	private func sharedRow(_ rowAlignment: ChipRowAlignment) throws -> (folded: CGRect, short: CGRect) {
		let frames = chipFlowFrames(
			[Self.foldedChipName, Self.shortChipName], width: Self.sharedRowWidth, rowAlignment: rowAlignment)
		let folded = try XCTUnwrap(frames[Self.foldedChipName])
		let short = try XCTUnwrap(frames[Self.shortChipName])
		XCTAssertGreaterThanOrEqual(
			folded.height, short.height + 15, "the name must fold for this test to mean something")
		XCTAssertGreaterThan(short.minX, folded.maxX, "both chips must share a row")
		XCTAssertLessThan(
			max(folded.minY, short.minY), min(folded.maxY, short.maxY), "both chips must share a row")
		return (folded, short)
	}

	/// The short chip of a shared row sits at the top of the row, next to the first line of the folded chip.
	@MainActor
	func testATopAlignedShortChipSharesItsRowTopWithAFoldedChip() throws {
		let row = try sharedRow(.top)
		XCTAssertEqual(
			row.short.minY, row.folded.minY, accuracy: 0.5, "short chip \(row.short), folded \(row.folded)")
	}

	/// The default stays centered: the node page relies on it for its 32 pt overflow chip.
	@MainActor
	func testTheDefaultAlignmentStillCentersTheShortChipOnTheFoldedOne() throws {
		let row = try sharedRow(.center)
		XCTAssertEqual(
			row.short.midY, row.folded.midY, accuracy: 0.5, "short chip \(row.short), folded \(row.folded)")
	}

	/// `.top` moves chips inside their row only: the row height, so the flow height, does not change.
	@MainActor
	func testTopAlignmentKeepsTheRowHeights() throws {
		// "Trap" is alone on the second row: its `minY` is the row height of the first row, plus the spacing.
		let titles = [Self.foldedChipName, Self.shortChipName, "Trap"]
		let centered = chipFlowFrames(titles, width: Self.sharedRowWidth)
		let top = chipFlowFrames(titles, width: Self.sharedRowWidth, rowAlignment: .top)
		for key in titles + ["flow"] {
			let before = try XCTUnwrap(centered[key], "\(key) centered")
			let after = try XCTUnwrap(top[key], "\(key) at the top")
			XCTAssertEqual(after.width, before.width, accuracy: 0.5, "width of \(key)")
			XCTAssertEqual(after.height, before.height, accuracy: 0.5, "height of \(key)")
		}
		let folded = try XCTUnwrap(top[Self.foldedChipName])
		let third = try XCTUnwrap(top["Trap"])
		XCTAssertEqual(third.minY, folded.maxY + Track1Tokens.spacing8, accuracy: 0.5, "second row")
		let thirdCentered = try XCTUnwrap(centered["Trap"])
		XCTAssertEqual(third.minY, thirdCentered.minY, accuracy: 0.5, "second row, centered")
	}

	// MARK: Bottom action bar

	func testBottomBarIdentifiers() {
		XCTAssertEqual(BottomActionBar.actionIdentifier, "bottom-action")
		XCTAssertEqual(BottomActionBar.counterIdentifier, "bottom-counter")
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
		// TRA-767: no counter, so nothing is laid out before the button.
		XCTAssertEqual(bar.parts, [.button])
	}

	// MARK: Welcome (TRA-724)

	/// Values read on 2026-11-17 in the Figma `1.1 Welcome` (`316:4853`): the gaps of `362:4932` and
	/// `316:4855`, the app mark `362:4910` and the wordmark `318:6607`. They are spelled out again here, so a
	/// metric changed in `WelcomeMetrics` alone fails.
	func testWelcomeMetricsAreTheFigmaValues() {
		XCTAssertEqual(WelcomeMetrics.markTextSpacing, 24)
		XCTAssertEqual(WelcomeMetrics.wordmarkTaglineSpacing, 16)
		XCTAssertEqual(WelcomeMetrics.markSize, 122.88, accuracy: 1e-9)
		XCTAssertEqual(WelcomeMetrics.wordmarkSize.width, 136.032, accuracy: 1e-9)
		XCTAssertEqual(WelcomeMetrics.wordmarkSize.height, 29.6, accuracy: 1e-9)
		XCTAssertEqual(WelcomeMetrics.textSideMargin, 24)
	}

	func testWelcomeMarkIsTheSizeOfTheMarkInTheMockUp() {
		XCTAssertEqual(WelcomeMetrics.markSize, AppMarkMetrics.welcomeSize, accuracy: 1e-9)
		// 26.88 / 122.88, the radius of `362:4910`.
		XCTAssertEqual(WelcomeMetrics.markSize * AppMarkMetrics.cornerRatio, 26.88, accuracy: 1e-9)
	}

	/// The wordmark is an image of the catalog (`Brand/Wordmark`, node `318:6607`), not text: a missing or
	/// misnamed asset would draw nothing, so the name the screen uses must resolve.
	@MainActor
	func testWelcomeWordmarkIsAnImageOfTheCatalog() {
		XCTAssertEqual(WelcomeView.wordmarkImageName, "Brand/Wordmark")
		XCTAssertNotNil(UIImage(named: WelcomeView.wordmarkImageName), WelcomeView.wordmarkImageName)
	}

	/// The drawn wordmark is the heading and VoiceOver reads it as "track1". The reading order itself
	/// (mark hidden, wordmark, tagline, button) follows the view hierarchy and is not a value a unit test
	/// can read: it is left to a check by hand with VoiceOver (TRA-724).
	@MainActor
	func testWelcomeWordmarkIsTheHeadingAndIsReadAsTheProductName() {
		XCTAssertEqual(WelcomeView.wordmarkLabel, "track1")
		XCTAssertEqual(WelcomeView.wordmarkTraits, .isHeader)
		XCTAssertEqual(WelcomeView.wordmarkLabel, WelcomeView.productName)
	}

	/// TRA-724 keeps the French copy and the identifier that the UI tests look for.
	@MainActor
	func testWelcomeKeepsItsStartIdentifierItsLabelAndItsTagline() {
		XCTAssertEqual(WelcomeView.startIdentifier, "onboarding-start")
		XCTAssertEqual(WelcomeView.tagline, "Explorations musicales quotidiennes")
		XCTAssertEqual(WelcomeView.productName, "track1")
	}
}

/// The frames the header probe reads, by identifier.
private final class HeaderFrameBox: @unchecked Sendable {
	var frames: [String: CGRect] = [:]
}

private struct HeaderFrameKey: PreferenceKey {
	static var defaultValue: [String: CGRect] { [:] }
	static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
		value.merge(nextValue()) { $1 }
	}
}

extension View {
	fileprivate func readHeaderFrame(_ id: String) -> some View {
		background(
			GeometryReader { proxy in
				Color.clear.preference(key: HeaderFrameKey.self, value: [id: proxy.frame(in: .named("header"))])
			})
	}
}

/// A `ChipFlowLayout` of `SubgenreChip`s as the genre card poses them, with a frame reader on each chip (by
/// title) and on the flow (`"flow"`).
private struct ChipFlowProbe: View {
	let titles: [String]
	let width: CGFloat
	var rowAlignment: ChipRowAlignment = .center
	let onFrames: @Sendable ([String: CGRect]) -> Void

	var body: some View {
		ChipFlowLayout(rowAlignment: rowAlignment) {
			ForEach(titles, id: \.self) { title in
				SubgenreChip(title: title, isSelected: false) {}.readHeaderFrame(title)
			}
		}
		.readHeaderFrame("flow")
		.frame(width: width)
		.coordinateSpace(name: "header")
		.onPreferenceChange(HeaderFrameKey.self, perform: onFrames)
	}
}

/// The label of a collapsed `GenreAccordionCard` header, same structure and same components, with a frame
/// reader on the title, the badge and the count line. A copy, since the card exposes no frames: keep it in
/// step with `GenreAccordionCard.header`.
private struct HeaderLayoutProbe: View {
	let title: String
	let badge: String?
	let width: CGFloat
	let onFrames: @Sendable ([String: CGRect]) -> Void

	var body: some View {
		Button {
		} label: {
			HStack(spacing: GenreAccordionCardMetrics.chevronGap) {
				VStack(alignment: .leading, spacing: GenreAccordionCardMetrics.countLineSpacing) {
					HStack(alignment: .firstTextBaseline, spacing: GenreAccordionCardMetrics.titleSpacing) {
						Track1Text(title, role: GenreAccordionCardMetrics.titleRole, verbatim: true)
							.readHeaderFrame("title")
						if let badge {
							Track1Text(badge, role: GenreAccordionCardMetrics.badgeRole, verbatim: true)
								.fixedSize(horizontal: true, vertical: false)
								.readHeaderFrame("badge")
						}
					}
					Track1Text("1 sous-genre", role: GenreAccordionCardMetrics.countRole).readHeaderFrame("count")
				}
				Spacer(minLength: 0)
				Track1Icon(
					.chevronDown, color: Track1Tokens.colorIconPrimary, size: GenreAccordionCard<EmptyView>.chevronSize)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.frame(width: width)
		.coordinateSpace(name: "header")
		.onPreferenceChange(HeaderFrameKey.self, perform: onFrames)
	}
}
