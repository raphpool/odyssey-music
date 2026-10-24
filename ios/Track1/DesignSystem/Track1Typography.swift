import SwiftUI
import UIKit

/// The six embedded font files (`Resources/Fonts`, registered in `Info.plist`). The raw value is the
/// PostScript name that `Font.custom` and `UIFont(name:size:)` look up, not the file name:
/// `test/ios-fonts.test.ts` keeps both in line with the files.
enum Track1FontFace: String, CaseIterable {
	case jetBrainsMonoRegular = "JetBrainsMono-Regular"
	case jetBrainsMonoMedium = "JetBrainsMono-Medium"
	case jetBrainsMonoBold = "JetBrainsMono-Bold"
	case robotoRegular = "Roboto-Regular"
	case robotoSemiBold = "Roboto-SemiBold"
	case robotoCondensedMedium = "RobotoCondensed-Medium"
}

/// The 20 text styles of the Figma Typography frame (`180:376`, read 2026-10-13, TRA-384), plus
/// `monoHeadline`, which only the Top bar date uses (`I282:838;173:15`, read 2026-10-23, TRA-660). Sizes and
/// line heights are in points at the default content size; `textStyle` is the system style that Dynamic Type
/// scales each role against (D4bis).
enum Track1TextRole: CaseIterable {
	case displayHero, display, title1, title2, title3, headline
	case bodyLarge, bodyMedium, bodySmall
	case labelLarge, labelMedium, labelSmall, labelTab, eyebrow, caption
	case monoHeadline, monoSection, monoItem, monoTag, monoLabel, monoMicro

	private typealias Spec = (
		face: Track1FontFace, size: CGFloat, lineHeight: CGFloat, textStyle: Font.TextStyle
	)

	private var spec: Spec {
		switch self {
		case .displayHero: (.jetBrainsMonoBold, 56, 64, .largeTitle)
		case .display: (.jetBrainsMonoBold, 34, 41, .largeTitle)
		case .title1: (.jetBrainsMonoBold, 28, 34, .title)
		case .title2: (.jetBrainsMonoBold, 22, 28, .title2)
		case .title3: (.jetBrainsMonoBold, 20, 25, .title3)
		case .headline: (.jetBrainsMonoBold, 18, 24, .headline)
		case .monoHeadline: (.jetBrainsMonoBold, 18, 24, .callout)
		case .monoSection: (.jetBrainsMonoBold, 15, 20, .subheadline)
		case .monoItem: (.jetBrainsMonoRegular, 18, 22, .body)
		case .monoTag: (.jetBrainsMonoRegular, 13, 16, .footnote)
		case .monoLabel: (.jetBrainsMonoRegular, 12, 16, .caption)
		case .monoMicro: (.jetBrainsMonoMedium, 11, 14, .caption2)
		case .bodyLarge: (.robotoRegular, 17, 25, .body)
		case .bodyMedium: (.robotoRegular, 15, 22, .subheadline)
		case .bodySmall: (.robotoRegular, 13, 18, .footnote)
		case .labelLarge: (.robotoSemiBold, 17, 22, .headline)
		case .labelMedium: (.robotoSemiBold, 15, 20, .subheadline)
		case .labelSmall: (.robotoSemiBold, 13, 16, .footnote)
		case .labelTab: (.robotoSemiBold, 10, 12, .caption2)
		case .eyebrow: (.robotoCondensedMedium, 16, 20, .callout)
		case .caption: (.robotoRegular, 12, 16, .caption)
		}
	}

	var face: Track1FontFace { spec.face }
	var size: CGFloat { spec.size }
	var lineHeight: CGFloat { spec.lineHeight }
	var textStyle: Font.TextStyle { spec.textStyle }

	/// Letter spacing in points. Not in the plan's table: the Figma tokens give -1 px to `displayHero`
	/// (`theme.font.letterSpacing.display`), -0.4 px to `display` (`tight`) and 0 to the 18 other roles.
	var tracking: CGFloat {
		switch self {
		case .displayHero: -1
		case .display: -0.4
		default: 0
		}
	}

	/// Scales with Dynamic Type against `textStyle`.
	var font: Font {
		Font.custom(face.rawValue, size: size, relativeTo: textStyle)
	}

	/// `size` scaled for a content size category, `nil` meaning the current one.
	func scaledSize(compatibleWith traits: UITraitCollection? = nil) -> CGFloat {
		UIFontMetrics(forTextStyle: uiTextStyle).scaledValue(for: size, compatibleWith: traits)
	}

	/// Extra space between lines: `lineHeight` minus the natural line height of the font, scaled like the
	/// font. It is negative where the natural line is taller than the Figma one (`displayHero` is -9.9 pt).
	/// `Text.lineSpacing` only applies between two lines: a single line keeps its natural height, so the
	/// Figma line height holds for wrapped text only. Components that need it on one line (tab bar, chips)
	/// must set a frame height from `lineHeight` (TRA-384 review, 2026-10-13).
	func lineSpacing(compatibleWith traits: UITraitCollection? = nil) -> CGFloat {
		let natural = (UIFont(name: face.rawValue, size: size) ?? .systemFont(ofSize: size)).lineHeight
		let extra = lineHeight - natural
		return UIFontMetrics(forTextStyle: uiTextStyle).scaledValue(for: extra, compatibleWith: traits)
	}

	var uiTextStyle: UIFont.TextStyle {
		switch textStyle {
		case .largeTitle: .largeTitle
		case .title: .title1
		case .title2: .title2
		case .title3: .title3
		case .headline: .headline
		case .subheadline: .subheadline
		case .callout: .callout
		case .footnote: .footnote
		case .caption: .caption1
		case .caption2: .caption2
		default: .body
		}
	}
}

extension View {
	/// Applies the font, the line spacing and the letter spacing of a role. Use it instead of `.font`.
	func track1Text(_ role: Track1TextRole) -> some View {
		modifier(Track1TextModifier(role: role))
	}
}

private struct Track1TextModifier: ViewModifier {
	let role: Track1TextRole
	// SwiftUI scales it with the environment's Dynamic Type through `UIFontMetrics`, like
	// `lineSpacing(compatibleWith:)` does, and follows a `dynamicTypeSize` override up the view tree.
	@ScaledMetric private var lineSpacing: CGFloat

	init(role: Track1TextRole) {
		self.role = role
		_lineSpacing = ScaledMetric(
			wrappedValue: role.lineSpacing(compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)),
			relativeTo: role.textStyle)
	}

	func body(content: Content) -> some View {
		content
			.font(role.font)
			.lineSpacing(lineSpacing)
			.tracking(role.tracking)
	}
}
