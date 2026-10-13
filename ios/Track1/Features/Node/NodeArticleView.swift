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

struct NodeArticleView: View {
	let article: String
	let citations: [Citation]

	var body: some View {
		let blocks = NodeArticleParser.blocks(from: article)
		VStack(alignment: .leading, spacing: Track1Theme.contentSpacing) {
			if !blocks.isEmpty {
				Text("Article")
					.font(.title2.bold())
					.accessibilityAddTraits(.isHeader)
				// verbatim everywhere below: article text and citation titles come from the API and a
				// plain Text("…") would render them as Markdown (links included).
				ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
					switch block {
					case .paragraph(let text):
						Text(verbatim: text).font(.body)
					case .list(let items):
						VStack(alignment: .leading, spacing: 8) {
							ForEach(Array(items.enumerated()), id: \.offset) { _, item in
								HStack(alignment: .firstTextBaseline, spacing: 8) {
									Text(verbatim: "•").accessibilityHidden(true)
									Text(verbatim: item)
								}
								.font(.body)
							}
						}
					}
				}
			}

			Text("Sources")
				.font(.title2.bold())
				.accessibilityAddTraits(.isHeader)
			if citations.isEmpty {
				Text("Aucune source disponible.")
					.foregroundStyle(.secondary)
			} else {
				ForEach(Array(citations.enumerated()), id: \.offset) { _, citation in
					citationView(citation)
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	@ViewBuilder
	private func citationView(_ citation: Citation) -> some View {
		let address = citation.url.absoluteString
		let label = citation.title ?? address
		if let url = Self.safeCitationURL(citation.url) {
			Link(destination: url) {
				citationLabel(title: citation.title, address: address)
			}
			.accessibilityLabel(Text(verbatim: "Ouvrir la source \(label)"))
		} else {
			citationLabel(title: citation.title, address: address)
				.accessibilityLabel(Text(verbatim: "Source non disponible : \(label)"))
		}
	}

	private func citationLabel(title: String?, address: String) -> some View {
		VStack(alignment: .leading, spacing: 4) {
			if let title {
				Text(verbatim: title).font(.headline)
				Text(verbatim: address).font(.footnote).foregroundStyle(.secondary)
			} else {
				Text(verbatim: address).font(.headline)
			}
		}
		.multilineTextAlignment(.leading)
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding()
		.background(Track1Theme.sectionSurface, in: RoundedRectangle(cornerRadius: 12))
	}

	/// Only a public HTTPS URL may be handed to `Link`; anything else is shown as inert text.
	/// `Citation` already validates its URL when decoded; this check stays at the point of use so the view
	/// never depends on how a `Citation` was built.
	static func safeCitationURL(_ url: URL) -> URL? {
		URLValidation.publicHTTPSURL(from: url.absoluteString)
	}
}
