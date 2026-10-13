import Foundation

/// One labelled line of the facts block under the header (Fact row), for example `BPM` / `96`.
public struct NodeFact: Equatable, Sendable {
	public let label: String
	public let value: String

	public init(label: String, value: String) {
		self.label = label
		self.value = value
	}
}

/// The header of a node page: title, subtitle line, teaser and facts (Data contract, rules 3 and 4).
/// Every string comes from the network, so it is only cleaned and reshaped here, never interpreted: the view
/// draws it with `Text(verbatim:)`, and no field of the header is ever turned into a link.
public struct NodePageHeader: Equatable, Sendable {
	public let title: String
	public let subtitle: String?
	public let teaser: String?
	public let facts: [NodeFact]

	/// `materialized_at`, the article and the citations are deliberately not read: the article and citations
	/// are drawn at the end of the page (D15) and the timestamp is never shown.
	public init(node: NodeDetail) {
		let facts = node.facts.compactMapValues(Self.clean)
		title = node.name
		subtitle = Self.subtitle(of: node, facts: facts)
		teaser = node.teaser.flatMap { Self.clean(Self.stripMarkdown($0)) }
		self.facts = (NodePageSpec.factFields[node.type] ?? []).compactMap { field, label in
			facts[field].map { NodeFact(label: label, value: $0) }
		}
	}

	// MARK: - Subtitle

	private static func subtitle(of node: NodeDetail, facts: [String: String]) -> String? {
		let segments: [String?]
		switch node.type {
		case .project:
			segments = [
				names(of: node.edges["artists"]),
				facts["release_type"].flatMap { NodePageSpec.releaseTypeLabels[$0.lowercased()] },
				facts["year"],
			]
		case .track:
			segments = [
				names(of: node.edges["artists"]),
				names(of: node.edges["project"]),
				facts["duration"].flatMap(clock),
				facts["year"],
			]
		case .artist:
			segments = [facts["origin"], facts["active_years"]]
		case .genre:
			segments = [facts["era"], facts["origin"]]
		case .label:
			segments = [facts["founded"].map { "\(NodePageSpec.foundedLabel) \($0)" }, facts["location"]]
		}
		let line = segments.compactMap { $0 }.joined(separator: " · ")
		return line.isEmpty ? nil : line
	}

	private static func names(of value: NodeEdgeValue?) -> String? {
		let edges: [NodeEdge]
		switch value {
		case .one(let edge): edges = [edge]
		case .many(let list): edges = list
		case nil: return nil
		}
		return clean(edges.compactMap { clean($0.name) }.joined(separator: ", "))
	}

	/// `"261"` becomes `"4:21"`; a value already written as `m:ss` or `h:mm:ss` is kept; anything else is dropped,
	/// because a duration the page cannot read is better absent than shown wrong. A bare number is read as seconds
	/// (the contract's example), which is also what the pipeline would write if it ever stored one.
	private static func clock(_ duration: String) -> String? {
		if duration.range(of: "^[0-9]+$", options: .regularExpression) != nil {
			// Interpolation, not `String(format:)`: `%d` would truncate a 64-bit value.
			return Int(duration).map { "\($0 / 60):" + ($0 % 60 < 10 ? "0" : "") + "\($0 % 60)" }
		}
		let written = "^[0-9]+(:[0-5][0-9]){1,2}$"
		return duration.range(of: written, options: .regularExpression) == nil ? nil : duration
	}

	// MARK: - Teaser

	/// Removes the inline markdown a teaser may carry. Links and images go first (a target may hold one level of
	/// parentheses, as Wikipedia URLs do) so emphasis inside a label survives. Single `*` and `_` only count at
	/// the edge of a word: `2 * 3`, `5*3` and `snake_case` stay as written.
	private static func stripMarkdown(_ text: String) -> String {
		let word = #"\p{L}\p{N}"#
		let rules: [(pattern: String, template: String)] = [
			(#"!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)"#, "$1"),
			(#"`([^`\n]+)`"#, "$1"),
			(#"\*\*(?=\S)(.+?)(?<=\S)\*\*"#, "$1"),
			(#"(?<![\#(word)_])__(?=\S)(.+?)(?<=\S)__(?![\#(word)_])"#, "$1"),
			(#"(?<![\#(word)*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\#(word)*])"#, "$1"),
			(#"(?<![\#(word)_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\#(word)_])"#, "$1"),
		]
		return rules.reduce(text) { text, rule in
			text.replacingOccurrences(of: rule.pattern, with: rule.template, options: .regularExpression)
		}
	}

	/// Trims a network string and makes it fit one line: control characters (newlines, tabs) become a space, runs
	/// of spaces collapse, and the bidirectional controls that could reorder the surrounding text are dropped. Empty means absent.
	private static func clean(_ text: String) -> String? {
		let scalars = text.unicodeScalars.compactMap { scalar -> Unicode.Scalar? in
			if bidiControls.contains(scalar) { return nil }
			return scalar.properties.generalCategory == .control ? " " : scalar
		}
		let line = String(String.UnicodeScalarView(scalars)).split(separator: " ").joined(separator: " ")
		return line.isEmpty ? nil : line
	}

	private static let bidiControls: Set<Unicode.Scalar> = [
		"\u{061C}", "\u{200E}", "\u{200F}", "\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}",
		"\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}",
	]
}

/// Data labels of the header (decision Q1: English, as the Data contract writes them). They sit with the other
/// labels of `NodePageSpec`, outside the parity block: they are copy, not part of `src/node-spec.ts`.
extension NodePageSpec {
	/// Facts shown under the header, in display order; field names are those of `OPTIONAL_TEXT_FIELDS`. A track's
	/// `duration` is a subtitle segment and is deliberately not listed.
	static let factFields: [NodeType: [(field: String, label: String)]] = [
		.project: projectFacts,
		.track: projectFacts,
		.genre: [("sonic_markers", "SONIC MARKERS")],
		.label: [("founders", "FOUNDERS"), ("active_years", "ACTIVE")],
		.artist: [],
	]

	private static let projectFacts: [(field: String, label: String)] = [
		("bpm", "BPM"), ("musical_key", "KEY"), ("vocals", "VOCALS"), ("samples_notes", "SAMPLES"),
		("inspirations", "INSPIRATIONS"),
	]

	static let releaseTypeLabels = ["album": "Album", "ep": "EP", "single": "Single"]

	static let foundedLabel = "Founded"
}
