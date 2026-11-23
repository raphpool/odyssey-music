import Foundation

/// Cuts the article of a node into the sentences the reader draws, one paragraph per sentence (D3).
/// The article comes from the network: it is only cleaned and cut here, never interpreted. A link keeps its
/// label and loses its target, so nothing in the output can become a tappable link; the view draws each
/// sentence with `Text(verbatim:)`.
public enum ArticleSentences {
	/// Rules, in this order: `\r\n` becomes `\n`; per line, the heading or list marker goes, then the inline
	/// markup, then the bracketed note calls; each line is cut with Foundation's sentence segmentation;
	/// sentences are trimmed and empty ones dropped; a sentence that ends with a known abbreviation, or that is
	/// followed by one opening with a closing sign, is joined to its neighbour; a fragment under
	/// `minimumLength` is glued to its neighbour.
	public static func split(_ article: String) -> [String] {
		let normalised = article.replacingOccurrences(of: "\r\n", with: "\n")
		var sentences: [String] = []
		for line in normalised.split(separator: "\n") {
			let text = clean(String(line))
			let ranges = joinNeighbours(sentenceRanges(in: text), in: text)
			sentences += ranges.map { String(text[$0]) }
		}
		return glueShortFragments(sentences)
	}

	/// Under this length a fragment is not a sentence worth a paragraph of its own: it is what a cut after
	/// `feat.` or a note call left behind.
	private static let minimumLength = 25

	// MARK: - Segmentation

	private typealias TextRange = Range<String.Index>

	/// The trimmed range of every sentence Foundation finds in `text`. Ranges, not strings: a join below must
	/// give back the text as it was written, and `trimmingCharacters(in: .whitespacesAndNewlines)` also strips
	/// U+00A0, so joining trimmed strings would lose the no-break space of `«~Where Is My Mind~?~»`.
	private static func sentenceRanges(in text: String) -> [TextRange] {
		var ranges: [TextRange] = []
		text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .bySentences) { _, range, _, _ in
			if let trimmed = trim(range, in: text) { ranges.append(trimmed) }
		}
		return ranges
	}

	private static func trim(_ range: TextRange, in text: String) -> TextRange? {
		var lower = range.lowerBound
		var upper = range.upperBound
		while lower < upper, isBlank(text[lower]) { lower = text.index(after: lower) }
		while lower < upper, isBlank(text[text.index(before: upper)]) { upper = text.index(before: upper) }
		return lower < upper ? lower..<upper : nil
	}

	private static func isBlank(_ character: Character) -> Bool {
		character.unicodeScalars.allSatisfy { CharacterSet.whitespacesAndNewlines.contains($0) }
	}

	// MARK: - Joins

	/// Abbreviations that never end a sentence of their own, compared without case. Closed list on purpose
	/// (2026-11-23): `etc.` often ends a sentence, and initials are left out because "Kid A." or "face B."
	/// do too. Added for French, where `feat.`, `Dr. Dre` or `Vol. II` followed by a capital are frequent;
	/// Foundation may cut there, and the 25-character floor below would glue the tail to the wrong side,
	/// the sentence before.
	private static let abbreviations: Set<String> = [
		"feat.",
		"ft.",
		"vs.",
		"prod.",
		"vol.",
		"dr.",
		"st.",
		"no.",
	]

	/// A sentence cannot open with one of these. ICU cuts before the `»` of `«~Where Is My Mind~?~»` because
	/// a space follows the `?` (2026-11-23, seen with `Intl.Segmenter` in Node on the French sentences of the
	/// plan, not confirmed against Foundation). The other signs are the closed list of the ticket; if Foundation
	/// never cuts before them, the join does nothing.
	private static let closingSigns: Set<Character> = ["»", "”", ")", ",", ";", ":"]

	/// Joins neighbouring sentences of one line. The joined sentence is the span of `text` covering both, so no
	/// space is invented or lost between them. Runs before `glueShortFragments`, which would otherwise glue the
	/// tail of a cut after an abbreviation to the previous sentence. It never relies on where Foundation cut:
	/// when it did not cut, there is nothing to join.
	private static func joinNeighbours(_ ranges: [TextRange], in text: String) -> [TextRange] {
		var joined: [TextRange] = []
		for range in ranges {
			if let previous = joined.last, shouldJoin(text[previous], text[range]) {
				joined[joined.count - 1] = previous.lowerBound..<range.upperBound
			} else {
				joined.append(range)
			}
		}
		return joined
	}

	private static func shouldJoin(_ previous: Substring, _ next: Substring) -> Bool {
		endsWithAbbreviation(previous) || opensWithClosingSign(next, after: previous)
	}

	private static func endsWithAbbreviation(_ sentence: Substring) -> Bool {
		guard let word = sentence.split(whereSeparator: \.isWhitespace).last else { return false }
		return abbreviations.contains(word.lowercased())
	}

	/// A straight `"` is the same character opening or closing a quote, and an English sentence may well open
	/// with one: it only closes when the sentence before it holds an odd number of them.
	private static func opensWithClosingSign(_ sentence: Substring, after previous: Substring) -> Bool {
		guard let first = sentence.first else { return false }
		if first == "\"" { return previous.filter { $0 == "\"" }.count % 2 == 1 }
		return closingSigns.contains(first)
	}

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
	/// `"See also ."`. Capped at two digits because a longer number is part of a title, not a note call:
	/// `cache/nodes/project/syro--aphex-twin.json` names a track `XMAS_EVET10 [120]`, a tempo.
	private static let noteCall = #"[ \t]*\[[0-9]{1,2}\]"#

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
