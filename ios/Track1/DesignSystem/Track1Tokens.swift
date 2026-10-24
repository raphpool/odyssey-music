import SwiftUI
import Track1Core

/// Semantic design tokens of the Nocturne theme (dark only, D4bis). Names follow the Figma variables:
/// `theme.color.text.primary` becomes `colorTextPrimary`. Colors were read from the Foundations frames
/// (`4:3`) of the Figma file with `get_variable_defs` on 2026-10-13 (TRA-383).
///
/// Screens outside `DesignSystem/` use these constants and never raw values. Spacing, radius, size and
/// motion values are not bound Figma variables (`get_variable_defs` returns none for them): they are the
/// labels of the Foundations frames `180:479` and `180:581`, which is why `Track1TokensTests` spells every
/// one of them out again.
enum Track1Tokens {
	// MARK: Colors

	/// `0xRRGGBBAA`: the Figma exports 8 hex digits when the alpha is not 1, so we keep that form.
	private static func rgba(_ value: UInt32) -> Color {
		Color(
			.sRGB,
			red: Double((value >> 24) & 0xFF) / 255,
			green: Double((value >> 16) & 0xFF) / 255,
			blue: Double((value >> 8) & 0xFF) / 255,
			opacity: Double(value & 0xFF) / 255)
	}

	/// `0xRRGGBB`, opaque.
	private static func rgb(_ value: UInt32) -> Color {
		precondition(value <= 0xFF_FFFF, "An 8-digit value belongs to rgba(_:), it would lose its first byte here")
		return rgba(value << 8 | 0xFF)
	}

	// Text

	static let colorTextPrimary = rgb(0xF6E9D8)
	static let colorTextSecondary = rgb(0xC8B6A3)
	static let colorTextTertiary = rgb(0x8D7A6D)
	static let colorTextInverse = rgb(0x0B0706)
	static let colorTextAction = rgb(0x5D7FA8)
	static let colorTextDanger = rgb(0xE56E5A)
	static let colorTextDisabled = rgb(0x5B4A41)

	// Background

	static let colorBackgroundBase = rgb(0x120C0A)
	static let colorBackgroundElevated = rgb(0x1A110E)
	static let colorBackgroundSubtle = rgb(0x1A110E)

	// Surface

	static let colorSurfaceDefault = rgb(0x241713)
	static let colorSurfacePressed = rgb(0x302019)
	static let colorSurfaceSelected = rgb(0x3F432D)

	// Icon

	static let colorIconPrimary = rgb(0xF6E9D8)
	static let colorIconSecondary = rgb(0xC8B6A3)
	static let colorIconInverse = rgb(0x0B0706)
	static let colorIconAction = rgb(0xF0642D)
	static let colorIconDisabled = rgb(0x5B4A41)

	// Border

	static let colorBorderDefault = rgb(0x443027)
	static let colorBorderStrong = rgb(0x6A4938)
	static let colorBorderFocus = rgb(0x5D7FA8)
	static let colorBorderContrast = rgba(0xFFFF_FF85)
	/// Border of the relation chips, `rgba(125, 100, 89, 0.2)` in the "UI Refresh" revision (TRA-657).
	static let colorBorderChip = rgba(0x7D64_5933)

	// Action

	static let colorActionPrimary = rgb(0xF6E9D8)
	static let colorActionPrimaryPressed = rgb(0xC8B6A3)
	static let colorActionSecondary = rgb(0xE6A23A)
	static let colorActionSecondaryPressed = rgb(0xBC7722)
	static let colorActionDisabled = rgb(0x241713)
	static let colorActionGhost = rgba(0x0000_0000)
	static let colorActionGhostPressed = rgb(0x1A110E)

	// Status

	static let colorStatusDangerBackground = rgb(0x3C1E1A)
	static let colorStatusDangerContent = rgb(0xE56E5A)
	static let colorStatusSuccessBackground = rgb(0x26301F)
	static let colorStatusSuccessContent = rgb(0x8DA66B)

	// Overlay

	static let colorOverlayScrim = rgba(0x0000_008A)

	// Glass

	static let colorGlassSurface = rgba(0x090A_0EAD)
	static let colorGlassBorder = rgba(0xFFFF_FF42)
	static let colorGlassSelected = rgba(0xFFFF_FF42)

	// Node

	static let colorNodeArtist = rgb(0x5D7FA8)
	static let colorNodeProject = rgb(0xE6A23A)
	static let colorNodeTrack = rgb(0xF0642D)
	static let colorNodeGenre = rgb(0x8DA66B)
	static let colorNodeLabel = rgb(0xC8B6A3)

	// Selection

	static let colorSelectionContent = rgb(0xBC7722)
	static let colorSelectionBorder = rgb(0xBC7722)
	static let colorSelectionSurface = rgb(0x302019)

	// Progress

	static let colorProgressTrack = rgb(0x8D7A6D)
	static let colorProgressIndicator = rgb(0x8D7A6D)

	// MARK: Spacing (4 pt grid)

	static let spacing0: CGFloat = 0
	static let spacing2: CGFloat = 2
	static let spacing4: CGFloat = 4
	static let spacing6: CGFloat = 6
	static let spacing8: CGFloat = 8
	static let spacing10: CGFloat = 10
	static let spacing12: CGFloat = 12
	static let spacing16: CGFloat = 16
	static let spacing20: CGFloat = 20
	static let spacing24: CGFloat = 24
	static let spacing32: CGFloat = 32
	static let spacing40: CGFloat = 40
	static let spacing48: CGFloat = 48
	static let spacing64: CGFloat = 64

	// MARK: Radius

	static let radius0: CGFloat = 0
	static let radius6: CGFloat = 6
	static let radius8: CGFloat = 8
	static let radius12: CGFloat = 12
	static let radius16: CGFloat = 16
	static let radius20: CGFloat = 20
	static let radiusFull: CGFloat = 999

	// MARK: Sizes

	static let sizeControlMedium: CGFloat = 44
	static let sizeControlLarge: CGFloat = 52
	static let sizeIconSmall: CGFloat = 16
	static let sizeIconMedium: CGFloat = 20
	static let sizeIconLarge: CGFloat = 24
	static let sizeArtworkSmall: CGFloat = 48
	static let sizeArtworkMedium: CGFloat = 64
	static let sizeArtworkLarge: CGFloat = 96
	static let sizeHeroArtwork: CGFloat = 164
	static let sizeReleaseCard: CGFloat = 120
	static let sizeGenreTile: CGFloat = 176

	// MARK: Local tokens (not Figma)

	// Everything above is a Figma variable or a label of the Foundations frames. These two are not: the
	// Figma file draws the Large Artwork glyph (`18:2`) and the SearchField icon (`30:21`) at these sizes
	// without any token for them. Added on 2026-10-13 (TRA-443) after the decision "defaults + add missing
	// tokens", so the components match the Figma exactly. `Track1TokensTests` lists them apart from the
	// Figma ones, so a local token can never hide a Figma variable that is missing. Move one up if the
	// designer ever binds a variable to it.

	/// Glyph of a Large Artwork (Title/1, 28 pt).
	static let sizeIconXLarge: CGFloat = 28
	/// Leading icon of the SearchField, drawn in a 22 pt frame.
	static let sizeIconSearch: CGFloat = 22

	// MARK: Node types

	/// Graph color of a node type, shared by chips, markers and artwork placeholders.
	static func colorNode(_ type: NodeType) -> Color {
		switch type {
		case .artist: colorNodeArtist
		case .project: colorNodeProject
		case .track: colorNodeTrack
		case .genre: colorNodeGenre
		case .label: colorNodeLabel
		}
	}
}

/// Motion tokens (`motion/duration/*` and `motion/easing/*`, Figma `180:581`).
enum Track1Motion: CaseIterable, Sendable {
	/// Taps and toggles.
	case fast
	/// Most transitions.
	case standard
	/// Sheet and hero entrances.
	case slow

	var duration: TimeInterval {
		switch self {
		case .fast: 0.12
		case .standard: 0.2
		case .slow: 0.35
		}
	}

	/// `nil` under Reduce Motion: `withAnimation(nil)` and `.animation(nil, value:)` apply the change at
	/// once. Callers pass `@Environment(\.accessibilityReduceMotion)`. `emphasized` is the overshooting
	/// entrance curve, `cubic-bezier(0.2, 0, 0, 1.2)`; the default is `cubic-bezier(0.2, 0, 0, 1)`.
	static func animation(_ motion: Track1Motion, emphasized: Bool = false, reduceMotion: Bool) -> Animation? {
		guard !reduceMotion else { return nil }
		return .timingCurve(0.2, 0, 0, emphasized ? 1.2 : 1, duration: motion.duration)
	}

	/// Unfolding of an accordion card (TRA-636): the screen wraps its toggle in `withAnimation` with this.
	/// `nil` under Reduce Motion, like `animation`.
	static func spring(reduceMotion: Bool) -> Animation? {
		guard !reduceMotion else { return nil }
		return .spring(duration: 0.35, bounce: 0.2)
	}
}
