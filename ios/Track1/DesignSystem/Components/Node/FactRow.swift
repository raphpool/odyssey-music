import SwiftUI

/// Figma `Fact row` (`172:2`, doc `172:6`): an uppercase mono label in a fixed 104 pt column, and its value
/// in `Body/Medium`. Both strings come from the network and are drawn with `Text(verbatim:)`.
struct FactRow: View {
	static let labelColumnWidth: CGFloat = 104

	private let label: String
	private let value: String

	init(label: String, value: String) {
		self.label = label
		self.value = value
	}

	static func displayLabel(_ label: String) -> String {
		label.uppercased()
	}

	var body: some View {
		HStack(alignment: .top, spacing: Track1Tokens.spacing12) {
			Track1Text(Self.displayLabel(label), role: .monoLabel, verbatim: true)
				.foregroundStyle(Track1Tokens.colorTextTertiary)
				.frame(width: Self.labelColumnWidth, alignment: .leading)
			Track1Text(value, role: .bodyMedium, verbatim: true)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.multilineTextAlignment(.leading)
		.padding(.vertical, Track1Tokens.spacing10)
		.nodeRowDivider()
	}
}

/// The facts under the header of a node page. It draws nothing when there is no fact, so that the page can
/// place it without testing for emptiness itself.
struct FactsBlock: View {
	typealias Row = (label: String, value: String)

	static let identifier = "facts"

	private let rows: [Row]

	init(rows: [Row]) {
		self.rows = rows
	}

	static func isEmpty(_ rows: [Row]) -> Bool {
		rows.isEmpty
	}

	var body: some View {
		if !Self.isEmpty(rows) {
			VStack(spacing: 0) {
				ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
					FactRow(label: row.label, value: row.value)
				}
			}
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier(Self.identifier)
		}
	}
}

extension View {
	/// The 1 pt `colorBorderDefault` line under a Fact row or a Track row. Figma gives these rows a bottom
	/// border of 1 px and the tokens carry no border width, so the thickness is a constant here (TRA-391).
	func nodeRowDivider() -> some View {
		overlay(alignment: .bottom) {
			Rectangle().fill(Track1Tokens.colorBorderDefault).frame(height: 1)
		}
	}
}
