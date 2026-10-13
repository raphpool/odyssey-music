import SwiftUI

/// Figma `Section header` (`171:62`, doc `171:66`): the lowercase label of one edge section and, when
/// there is one, its total count (`Mono/Section` then `Mono/Tag`, 8 pt apart). The header owns the 12 pt
/// that separate it from its content; the 24 pt between sections belong to the page.
struct SectionHeader: View {
	/// Space between the header and the content under it (doc `171:66`, rule "12pt above its content").
	static let contentSpacing = Track1Tokens.spacing12

	private let title: String
	private let count: Int?

	init(title: String, count: Int?) {
		self.title = title
		self.count = count
	}

	/// Labels are lowercase, as in the web front (`KIND_LABEL`).
	static func displayTitle(_ title: String) -> String {
		title.lowercased()
	}

	/// The count to draw, or `nil` for a section that has none (single edges and the article).
	static func countText(_ count: Int?) -> String? {
		count.map { String($0) }
	}

	/// Accessibility identifier of the header of the edge `field`, for example `section-tracklist`.
	static func identifier(field: String) -> String {
		"section-\(field)"
	}

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: Track1Tokens.spacing8) {
			Track1Text(Self.displayTitle(title), role: .monoSection, verbatim: true)
				.foregroundStyle(Track1Tokens.colorTextPrimary)
			if let countText = Self.countText(count) {
				Track1Text(countText, role: .monoTag, verbatim: true)
					.foregroundStyle(Track1Tokens.colorTextTertiary)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.bottom, Self.contentSpacing)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}
}
