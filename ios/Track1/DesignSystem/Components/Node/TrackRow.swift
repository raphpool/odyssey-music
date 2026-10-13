import SwiftUI

/// Figma `Track row` (`172:34`, doc `172:38`): a numbered line of a project tracklist. The whole row is the
/// tap target and is at least 44 pt tall (Figma draws 43 pt, 42 of content and the 1 pt border: the doc rule
/// "Whole row is the tap target (44pt)" wins). The title comes from the network: `Text(verbatim:)`.
struct TrackRow: View {
	static let minimumHeight = Track1Tokens.sizeControlMedium
	static let numberColumnWidth: CGFloat = 24

	private let number: Int
	private let title: String
	private let action: () -> Void

	init(number: Int, title: String, action: @escaping () -> Void) {
		self.number = number
		self.title = title
		self.action = action
	}

	/// The tracklist number padded to 2 digits: 1 gives "01", 100 stays "100".
	static func formattedNumber(_ number: Int) -> String {
		String(format: "%02ld", number)
	}

	/// Accessibility identifier of the row of track `number`, for example `track-row-3`.
	static func identifier(number: Int) -> String {
		"track-row-\(number)"
	}

	var body: some View {
		Button(action: action) {
			HStack(alignment: .center, spacing: Track1Tokens.spacing12) {
				Track1Text(Self.formattedNumber(number), role: .monoTag, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextTertiary)
					// Never wraps: it grows past 24 pt with Dynamic Type instead.
					.fixedSize(horizontal: true, vertical: false)
					.frame(minWidth: Self.numberColumnWidth, alignment: .leading)
				Track1Text(title, role: .bodyMedium, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextPrimary)
					.multilineTextAlignment(.leading)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			.padding(.vertical, Track1Tokens.spacing10)
			.frame(minHeight: Self.minimumHeight)
			.nodeRowDivider()
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityIdentifier(Self.identifier(number: number))
	}
}
