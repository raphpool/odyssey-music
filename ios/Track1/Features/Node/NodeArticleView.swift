import SwiftUI

enum NodeArticleBlock: Equatable, Sendable {
	case paragraph(String)
	case list([String])
}

enum NodeArticleParser {
	static func blocks(from article: String) -> [NodeArticleBlock] {
		let lines = article.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
			.split(
				separator: "\n", omittingEmptySubsequences: false)
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
			return String(value.dropFirst(prefix.count))
		}
		let parts = value.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
		guard parts.count == 2, let marker = parts.first,
			marker.hasSuffix(".") || marker.hasSuffix(")"),
			marker.dropLast().allSatisfy(\.isNumber)
		else { return nil }
		return String(parts[1])
	}
}

struct NodeArticleView: View {
	let article: String
	let citations: [Citation]

	var body: some View {
		VStack(alignment: .leading, spacing: Track1Theme.contentSpacing) {
			Text("Article")
				.font(.title2.bold())
			ForEach(Array(NodeArticleParser.blocks(from: article).enumerated()), id: \.offset) { _, block in
				switch block {
				case .paragraph(let text):
					Text(text).font(.body)
				case .list(let items):
					VStack(alignment: .leading, spacing: 8) {
						ForEach(Array(items.enumerated()), id: \.offset) { _, item in
							Label(item, systemImage: "circle.fill")
								.font(.body)
								.symbolRenderingMode(.hierarchical)
						}
					}
				}
			}

			Text("Sources")
				.font(.title2.bold())
			if citations.isEmpty {
				Text("Aucune source disponible.")
					.foregroundStyle(.secondary)
			} else {
				ForEach(Array(citations.enumerated()), id: \.offset) { _, citation in
					citationView(citation)
				}
			}
		}
	}

	@ViewBuilder
	private func citationView(_ citation: Citation) -> some View {
		let label = citation.title ?? citation.url.absoluteString
		if let url = Self.safeCitationURL(citation.url) {
			Link(destination: url) {
				citationLabel(title: label, url: citation.url.absoluteString)
			}
			.accessibilityLabel("Ouvrir la source \(label)")
		} else {
			citationLabel(title: label, url: citation.url.absoluteString)
				.accessibilityLabel("Source non disponible : \(label)")
		}
	}

	private func citationLabel(title: String, url: String) -> some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(title).font(.headline)
			Text(url).font(.footnote).foregroundStyle(.secondary)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding()
		.background(Track1Theme.sectionSurface, in: RoundedRectangle(cornerRadius: 12))
	}

	static func safeCitationURL(_ url: URL) -> URL? {
		URLValidation.publicHTTPSURL(from: url.absoluteString)
	}
}
