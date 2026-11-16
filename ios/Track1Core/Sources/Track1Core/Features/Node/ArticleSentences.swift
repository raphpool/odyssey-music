import Foundation

/// Cuts the article of a node into the sentences the reader draws, one paragraph per sentence (D3).
/// The article comes from the network: it is only cleaned and cut here, never interpreted. A link keeps its
/// label and loses its target, so nothing in the output can become a tappable link; the view draws each
/// sentence with `Text(verbatim:)`.
public enum ArticleSentences {
	/// Rules, in this order: `\r\n` becomes `\n`; per line, the heading or list marker goes, then the inline
	/// markup, then the bracketed note calls; each line is cut with Foundation's sentence segmentation;
	/// sentences are trimmed and empty ones dropped; a fragment under `minimumLength` is glued to its neighbour.
	public static func split(_ article: String) -> [String] {
		let normalised = article.replacingOccurrences(of: "\r\n", with: "\n")
		var sentences: [String] = []
		for line in normalised.split(separator: "\n") {
			let text = clean(String(line))
			let whole = text.startIndex..<text.endIndex
			text.enumerateSubstrings(in: whole, options: .bySentences) { piece, _, _, _ in
				let sentence = piece?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
				if !sentence.isEmpty { sentences.append(sentence) }
			}
		}
		return glueShortFragments(sentences)
	}

	/// Under this length a fragment is not a sentence worth a paragraph of its own: it is what a cut after
	/// `feat.` or a note call left behind.
	private static let minimumLength = 25

	// MARK: - Fragments

	/// A short fragment goes to the sentence before it, with a space; one that opens the article goes to the one
	/// after it. An article made of a single short fragment is returned as it is rather than emptied.
	private static func glueShortFragments(_ sentences: [String]) -> [String] {
		var glued: [String] = []
		var leading: String?
		for sentence in sentences {
			let text = leading.map { "\($0) \(sentence)" } ?? sentence
			leading = nil
			if text.count >= minimumLength {
				glued.append(text)
			} else if glued.isEmpty {
				leading = text
			} else {
				glued[glued.count - 1] += " " + text
			}
		}
		if let leading { glued.append(leading) }
		return glued
	}

	// MARK: - Cleaning

	private static func clean(_ line: String) -> String {
		let text = line.replacingOccurrences(of: lineMarker, with: "", options: .regularExpression)
		let plain = markdownRules.reduce(text) { text, rule in
			text.replacingOccurrences(of: rule.pattern, with: rule.template, options: .regularExpression)
		}
		return plain.replacingOccurrences(of: noteCall, with: "", options: .regularExpression)
	}

	/// `#`, `##`…, `-`, `*` or `1.` at the start of a line, indented or not, followed by a space or by nothing.
	/// The number is capped at three digits and needs the space after its dot, so a line that opens with a year
	/// or with `2.5` keeps its text.
	private static let lineMarker = #"^[ \t]*(?:#+|[-*]|[0-9]{1,3}\.)(?:[ \t]+|$)"#

	/// `[1]`, `[12]`, with the spaces before it: `"See also [3]."` must become `"See also."`, never
	/// `"See also ."`.
	private static let noteCall = #"[ \t]*\[[0-9]+\]"#

	/// The inline markup rules of `NodePageHeader.stripMarkdown` (the teaser), copied because that function is
	/// private to its file and outside the scope of the ticket that introduced this one. TRA-751 merges the two.
	/// Links and images go first (a target may hold one level of parentheses, as Wikipedia URLs do) so emphasis
	/// inside a label survives. Single `*` and `_` only count at the edge of a word: `2 * 3`, `5*3` and
	/// `snake_case` stay as written.
	private static let markdownRules: [(pattern: String, template: String)] = {
		let word = #"\p{L}\p{N}"#
		return [
			(#"!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)"#, "$1"),
			(#"`([^`\n]+)`"#, "$1"),
			(#"\*\*(?=\S)(.+?)(?<=\S)\*\*"#, "$1"),
			(#"(?<![\#(word)_])__(?=\S)(.+?)(?<=\S)__(?![\#(word)_])"#, "$1"),
			(#"(?<![\#(word)*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\#(word)*])"#, "$1"),
			(#"(?<![\#(word)_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\#(word)_])"#, "$1"),
		]
	}()
}
