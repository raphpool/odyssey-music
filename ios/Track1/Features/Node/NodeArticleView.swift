import SwiftUI
import Track1Core

enum NodeArticleBlock: Equatable, Sendable {
	case paragraph(String)
	case list([String])
}

/// Splits the API article into paragraphs and lists. It never interprets markup: every line stays
/// literal text, and only the list prefixes below are recognised.
enum NodeArticleParser {
	static func blocks(from article: String) -> [NodeArticleBlock] {
		// "\r\n" first, otherwise the lone "\r" pass would turn it into two line breaks.
		let lines = article.replacingOccurrences(of: "\r\n", with: "\n")
			.replacingOccurrences(of: "\r", with: "\n")
			.split(separator: "\n", omittingEmptySubsequences: false)
		var blocks = [NodeArticleBlock]()
		var paragraph = [String]()
		var list = [String]()

		func flushParagraph() {
			guard !paragraph.isEmpty else { return }
			blocks.append(.paragraph(paragraph.joined(separator: " ")))
			paragraph = []
		}
		func flushList() {
			guard !list.isEmpty else { return }
			blocks.append(.list(list))
			list = []
		}

		for line in lines {
			let value = line.trimmingCharacters(in: .whitespacesAndNewlines)
			guard !value.isEmpty else {
				flushParagraph()
				flushList()
				continue
			}
			if let item = listItem(in: value) {
				flushParagraph()
				list.append(item)
			} else {
				flushList()
				paragraph.append(value)
			}
		}
		flushParagraph()
		flushList()
		return blocks
	}

	private static func listItem(in value: String) -> String? {
		let prefixes = ["- ", "* ", "• "]
		if let prefix = prefixes.first(where: { value.hasPrefix($0) }) {
			return nonEmptyItem(value.dropFirst(prefix.count))
		}
		let parts = value.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
		guard parts.count == 2, let marker = parts.first,
			marker.hasSuffix(".") || marker.hasSuffix(")")
		else { return nil }
		// ASCII digits only: Character.isNumber also accepts "²" or "½", which are not list numbers.
		// At most three digits, so a wrapped paragraph line starting with a year ("1999. Their…") stays prose.
		let digits = marker.dropLast()
		guard (1...3).contains(digits.count), digits.allSatisfy({ $0.isASCII && $0.isNumber }) else {
			return nil
		}
		return nonEmptyItem(parts[1])
	}

	private static func nonEmptyItem(_ text: Substring) -> String? {
		let item = text.trimmingCharacters(in: .whitespacesAndNewlines)
		return item.isEmpty ? nil : item
	}
}

/// One source line of the page: a citation that passed `NodeArticleView.safeCitationURL(_:)`.
struct NodeSourceRow: Equatable {
	let title: String
	let subtitle: String?
	let url: URL
}

/// The two sections the page draws after the edge sections (D15), in this order.
enum NodeArticleSection: Equatable {
	case article([NodeArticleBlock])
	case sources([NodeSourceRow])
}

/// The "article" and "sources" sections of the node page (D15, the validated deviation from rule 9 of the Data
/// contract). Both are third-party text, drawn `verbatim`, and a source opens only through the OS.
struct NodeArticleView: View {
	private let sections: [NodeArticleSection]
	private let onOpenSource: (URL) -> Void

	init(article: String, citations: [Citation], onOpenSource: @escaping (URL) -> Void) {
		sections = Self.sections(article: article, citations: citations)
		self.onOpenSource = onOpenSource
	}

	/// False when the page has neither article nor valid source: the page then adds nothing, not even the
	/// 24 pt that separate two sections.
	var hasContent: Bool { !sections.isEmpty }

	/// An empty article gives no "article" section and no valid source gives no "sources" section.
	static func sections(article: String, citations: [Citation]) -> [NodeArticleSection] {
		sections(article: article, sources: sourceRows(citations))
	}

	static func sections(article: String, sources: [NodeSourceRow]) -> [NodeArticleSection] {
		var sections = [NodeArticleSection]()
		let blocks = NodeArticleParser.blocks(from: article)
		if !blocks.isEmpty { sections.append(.article(blocks)) }
		if !sources.isEmpty { sections.append(.sources(sources)) }
		return sections
	}

	static func sourceRows(_ citations: [Citation]) -> [NodeSourceRow] {
		sourceRows(entries: citations.map { (title: $0.title, url: $0.url) })
	}

	/// Keeps the check at the point of use, like `safeCitationURL(_:)`: a row never depends on how a
	/// `Citation` was built. A `Citation` cannot hold an unsafe URL, so the tests reach this entry point to
	/// prove the exclusion. The title is the trimmed citation title or else the host (a blank title counts as
	/// none); the host is the subtitle unless it already is the title, whatever the case.
	static func sourceRows(entries: [(title: String?, url: URL)]) -> [NodeSourceRow] {
		entries.compactMap { entry in
			guard let url = safeCitationURL(entry.url), let host = url.host else { return nil }
			let given = entry.title?.trimmingCharacters(in: .whitespacesAndNewlines)
			let title = given.flatMap { $0.isEmpty ? nil : $0 } ?? host
			let isHost = title.caseInsensitiveCompare(host) == .orderedSame
			return NodeSourceRow(title: title, subtitle: isHost ? nil : host, url: url)
		}
	}

	static let articleIdentifier = SectionHeader.identifier(field: "article")
	static let sourcesIdentifier = SectionHeader.identifier(field: "sources")

	static func sourceRowIdentifier(index: Int) -> String {
		"source-row-\(index)"
	}

	var body: some View {
		VStack(alignment: .leading, spacing: Track1Tokens.spacing24) {
			ForEach(Array(sections.enumerated()), id: \.offset) { _, section in
				switch section {
				case .article(let blocks): articleSection(blocks)
				case .sources(let rows): sourcesSection(rows)
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func articleSection(_ blocks: [NodeArticleBlock]) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			SectionHeader(title: NodePageSpec.articleLabel, count: nil)
				.accessibilityIdentifier(Self.articleIdentifier)
			VStack(alignment: .leading, spacing: Track1Tokens.spacing12) {
				ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
					switch block {
					case .paragraph(let text):
						bodyText(text)
					case .list(let items):
						VStack(alignment: .leading, spacing: Track1Tokens.spacing8) {
							ForEach(Array(items.enumerated()), id: \.offset) { _, item in
								// `.top`, not a baseline: `Track1Text` is a custom layout without a text baseline,
								// and the bullet shares the line box of the first line.
								HStack(alignment: .top, spacing: Track1Tokens.spacing8) {
									bodyText("•").fixedSize().accessibilityHidden(true)
									bodyText(item)
								}
							}
						}
					}
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
	}

	private func sourcesSection(_ rows: [NodeSourceRow]) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			SectionHeader(title: NodePageSpec.sourcesLabel, count: rows.count)
				.accessibilityIdentifier(Self.sourcesIdentifier)
			VStack(spacing: Track1Tokens.spacing8) {
				ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
					Track1ListItem(title: row.title, subtitle: row.subtitle, accessory: .chevron) {
						onOpenSource(row.url)
					}
					.accessibilityAddTraits(.isLink)
					.accessibilityIdentifier(Self.sourceRowIdentifier(index: index))
				}
			}
		}
	}

	private func bodyText(_ text: String) -> some View {
		Track1Text(text, role: .bodyLarge, verbatim: true)
			.foregroundStyle(Track1Tokens.colorTextPrimary)
	}

	/// Only a public HTTPS URL may be opened; anything else is not drawn.
	/// `Citation` already validates its URL when decoded; this check stays at the point of use so the view
	/// never depends on how a `Citation` was built.
	static func safeCitationURL(_ url: URL) -> URL? {
		URLValidation.publicHTTPSURL(from: url.absoluteString)
	}
}
