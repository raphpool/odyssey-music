import AudioToolbox
import SwiftUI
import Track1Core

/// The tick the onboarding lists play when a row passes under the top of the pinned action bar.
enum OnboardingScrollTick {
	/// The tick sound of the scroll (spec `176:219`): the system "Tock" click. A system sound, so the silent
	/// switch mutes it, as drawn.
	static let sound: SystemSoundID = 1104
}

/// The scroll measurements and the offset they were last compared at.
@MainActor
final class ScrollTracker {
	private var rowMaxYs = [String: CGFloat]()
	/// Top of the bar in the viewport space; nil until the first layout pass.
	private var barTop: CGFloat?
	private var lastOffset: CGFloat?

	/// A new layout is not a scroll: the offset that follows only sets the reference again, so a row that
	/// moved because the content was re-laid out (Dynamic Type, rotation, the safe area settling) never ticks.
	func layoutChanged(rowMaxYs: [String: CGFloat]) {
		self.rowMaxYs = rowMaxYs
		lastOffset = nil
	}

	func layoutChanged(barTop: CGFloat?) {
		self.barTop = barTop
		lastOffset = nil
	}

	/// The number of rows that passed the top of the bar since the previous offset. The first offset after a
	/// layout only sets the reference.
	func scrolled(toOffset offset: CGFloat) -> Int {
		defer { lastOffset = offset }
		guard let lastOffset, let barTop else { return 0 }
		return ScrollTickDetector.crossings(
			rowMaxYs: Array(rowMaxYs.values), previousOffset: lastOffset, newOffset: offset, threshold: barTop)
	}
}

struct RowEdgeKey: PreferenceKey {
	static let defaultValue = [String: CGFloat]()

	static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
		value.merge(nextValue()) { _, new in new }
	}
}

struct BarTopKey: PreferenceKey {
	static let defaultValue: CGFloat? = nil

	static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
		value = nextValue() ?? value
	}
}

struct ContentMinYKey: PreferenceKey {
	static let defaultValue: CGFloat = 0

	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
		value = nextValue()
	}
}

/// Reports the bottom edge of the row it sits behind, in the content space.
struct RowEdgeReader: View {
	let id: String
	let space: String

	var body: some View {
		GeometryReader { proxy in
			Color.clear.preference(
				key: RowEdgeKey.self, value: [id: proxy.frame(in: .named(space)).maxY])
		}
	}
}

/// Reports where the scrolled content starts in the viewport: its opposite is how far the list has scrolled.
struct ContentOffsetReader: View {
	let space: String

	var body: some View {
		GeometryReader { proxy in
			Color.clear.preference(key: ContentMinYKey.self, value: proxy.frame(in: .named(space)).minY)
		}
	}
}

/// Reports the top edge of the action bar in the viewport.
struct BarTopReader: View {
	let space: String

	var body: some View {
		GeometryReader { proxy in
			Color.clear.preference(key: BarTopKey.self, value: proxy.frame(in: .named(space)).minY)
		}
	}
}
