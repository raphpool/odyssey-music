import SwiftUI

/// Measures of the tab bar, from the Figma frame `282:889` (393 x 95, doc plan annex A.1).
enum Track1TabBarMetrics {
	static let tabWidth: CGFloat = 96
	static let tabHeight: CGFloat = 54
	static let pillPadding = Track1Tokens.spacing4
	/// One tab and the padding above and below it: 54 + 2 x 4 = 62.
	static let pillHeight: CGFloat = tabHeight + 2 * pillPadding
	static let topPadding = Track1Tokens.spacing12
	static let horizontalInset: CGFloat = 25
	static let iconSize = Track1Tokens.sizeIconMedium
	static let borderWidth: CGFloat = 1
	static let bottomPaddingWithoutHomeIndicator = Track1Tokens.spacing12

	/// Figma draws 21 pt under the buttons on a 393 x 95 frame; on a device the home indicator already
	/// provides that room, so the bar adds nothing there and keeps 12 pt on a screen without one (Q8).
	static func bottomPadding(safeAreaBottom: CGFloat) -> CGFloat {
		safeAreaBottom > 0 ? 0 : bottomPaddingWithoutHomeIndicator
	}

	/// Height of the bar above the window's safe area: what a screen reserves at its bottom so that its
	/// content, and the buttons it places in its own safe area, end where the bar starts (TRA-671). 74 pt with
	/// a home indicator, 86 pt without.
	static func reservedHeight(safeAreaBottom: CGFloat) -> CGFloat {
		topPadding + pillHeight + bottomPadding(safeAreaBottom: safeAreaBottom)
	}
}

/// Colors and tones of the tab bar, named so that tests compare them to the tokens.
enum Track1TabBarStyle {
	static let identifier = "tab-bar"
	static let pillFill = Track1Tokens.colorGlassSurface
	static let pillBorder = Track1Tokens.colorGlassBorder
	static let selectedFill = Track1Tokens.colorGlassSelected
	static let activeTone: Track1Icon.Tone = .action
	static let inactiveTone: Track1Icon.Tone = .secondary

	/// Transparent at the top, opaque at the bottom: the content that scrolls under the bar fades into the
	/// background (`from-[rgba(18,12,10,0)] to-[#120c0a]` in Figma).
	static func fadeStops() -> [Gradient.Stop] {
		[
			.init(color: Track1Tokens.colorBackgroundBase.opacity(0), location: 0),
			.init(color: Track1Tokens.colorBackgroundBase, location: 1),
		]
	}
}

/// Figma `Tab bar` (`173:108`, instance `282:889`): two tabs in a centered pill, icons only (TRA-771: the
/// round Search button is gone). The glass is deliberately quieter than the native Liquid Glass: a thin
/// material under `colorGlassSurface` and a 1 pt border, no `glassEffect`, no refraction.
///
/// The bar has no state of its own and does not know `AppTab`: the screen owns the selection and passes it
/// down. Place it with `safeAreaInset(edge: .bottom, spacing: 0)` on the `TabView`, so that the content scrolls
/// under the fade. The selection haptic stays with the screen (on `router.selectedTab`), not here.
struct Track1TabBar: View {
	struct Item: Identifiable, Equatable {
		let id: String
		let icon: Track1Icon.Asset
		let label: String
		let identifier: String
	}

	private let items: [Item]
	private let selected: String
	private let onSelect: (String) -> Void

	/// Bottom safe area handed in by the screen that mounts the bar (the window's, see `RootView`). Inside a
	/// `safeAreaInset` the bar is already placed above the home indicator, so what it measures itself can read
	/// 0 there (2026-10-24, TRA-671): it would then add the 12 pt of a screen without an indicator everywhere.
	private let injectedSafeAreaBottom: CGFloat?

	/// Fallback when nothing is injected (previews, tests): measured in a background `GeometryReader` rather
	/// than by wrapping the bar in one, which would take all the space it is offered and stretch the bar.
	@State private var measuredSafeAreaBottom: CGFloat = 0

	private var safeAreaBottom: CGFloat { injectedSafeAreaBottom ?? measuredSafeAreaBottom }

	init(
		items: [Item], selected: String, safeAreaBottom: CGFloat? = nil, onSelect: @escaping (String) -> Void
	) {
		self.injectedSafeAreaBottom = safeAreaBottom
		self.items = items
		self.selected = selected
		self.onSelect = onSelect
	}

	nonisolated static func isSelected(_ item: Item, selected: String) -> Bool {
		item.id == selected
	}

	nonisolated static func tone(for item: Item, selected: String) -> Track1Icon.Tone {
		isSelected(item, selected: selected) ? Track1TabBarStyle.activeTone : Track1TabBarStyle.inactiveTone
	}

	/// Only the selected tab carries the selected trait.
	nonisolated static func accessibilityTraits(for item: Item, selected: String) -> AccessibilityTraits {
		isSelected(item, selected: selected) ? .isSelected : []
	}

	var body: some View {
		pill
			.padding(.top, Track1TabBarMetrics.topPadding)
			.padding(.horizontal, Track1TabBarMetrics.horizontalInset)
			.padding(.bottom, Track1TabBarMetrics.bottomPadding(safeAreaBottom: safeAreaBottom))
			// The bar takes the width it is offered so that the fade runs edge to edge; the pill sits in the middle.
			.frame(maxWidth: .infinity)
			.background {
				GeometryReader { proxy in
					Color.clear.preference(key: SafeAreaBottomKey.self, value: proxy.safeAreaInsets.bottom)
				}
			}
			.onPreferenceChange(SafeAreaBottomKey.self) { measuredSafeAreaBottom = $0 }
			.background {
				LinearGradient(stops: Track1TabBarStyle.fadeStops(), startPoint: .top, endPoint: .bottom)
					.ignoresSafeArea(edges: .bottom)
			}
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier(Track1TabBarStyle.identifier)
	}

	private var pill: some View {
		HStack(spacing: 0) {
			ForEach(items) { item in
				tabButton(item)
			}
		}
		.padding(Track1TabBarMetrics.pillPadding)
		.glass(in: Capsule())
	}

	private func tabButton(_ item: Item) -> some View {
		let isSelected = Self.isSelected(item, selected: selected)
		let tone = Self.tone(for: item, selected: selected)
		return Button {
			onSelect(item.id)
		} label: {
			Track1Icon(asset: item.icon, tone: tone, size: Track1TabBarMetrics.iconSize)
				.frame(width: Track1TabBarMetrics.tabWidth, height: Track1TabBarMetrics.tabHeight)
				.background {
					if isSelected {
						Capsule().fill(Track1TabBarStyle.selectedFill)
					}
				}
				.contentShape(Capsule())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(item.label)
		.accessibilityIdentifier(item.identifier)
		.accessibilityAddTraits(Self.accessibilityTraits(for: item, selected: selected))
	}
}

private struct SafeAreaBottomKey: PreferenceKey {
	static let defaultValue: CGFloat = 0

	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
		value = nextValue()
	}
}

extension View {
	/// The tab bar glass: thin material, `colorGlassSurface` over it and a 1 pt border.
	fileprivate func glass<S: InsettableShape>(in shape: S) -> some View {
		background {
			shape.fill(.ultraThinMaterial)
			shape.fill(Track1TabBarStyle.pillFill)
		}
		.overlay {
			shape.strokeBorder(Track1TabBarStyle.pillBorder, lineWidth: Track1TabBarMetrics.borderWidth)
		}
	}
}
