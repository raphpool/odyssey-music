import Foundation

/// The texts of the Today home (Figma `324:1788`): the date on two lines, up to three genres, the type, the title
/// and an "artist · year" line of the recommended work. They are computed here, apart from the view, so that
/// `swift test` covers them (H.2). Every string comes from the network, so it is cleaned with the rule of
/// `NodePageHeader` and never interpreted.
public struct TodayHome: Equatable, Sendable {
	/// Day of the month without a leading zero.
	public let day: String
	/// Three letters of a fixed French table, whatever the device language is.
	public let month: String
	/// Genres of the recommended node (decision Q9), not those ticked in the profile.
	public let genres: [String]
	public let type: NodeType
	public let title: String
	public let subtitle: String?

	/// Day and month are read in `timeZone`, not in the device's: a date taken in UTC late in the evening is
	/// already tomorrow in Paris, and the home must show the day the person is living.
	public init(node: NodeDetail, date: Date, timeZone: TimeZone) {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = timeZone
		let parts = calendar.dateComponents([.day, .month], from: date)
		day = parts.day.map { String($0) } ?? ""
		month = parts.month.flatMap { Self.months.indices.contains($0 - 1) ? Self.months[$0 - 1] : nil } ?? ""
		genres = Self.genres(of: node.edges["genres"])
		type = node.type
		title = NodePageHeader.clean(node.name) ?? ""
		subtitle = Self.subtitle(of: node)
	}

	static let maxGenres = 3

	/// A fixed table: `DateFormatter` would follow the device's language and would not give these abbreviations.
	private static let months = [
		"JAN", "FÉV", "MAR", "AVR", "MAI", "JUN", "JUL", "AOÛ", "SEP", "OCT", "NOV", "DÉC",
	]

	/// Duplicates are removed after cleaning (two spellings that differ only by a control character are one
	/// genre) and before the cut, so that a repeated genre never takes the place of a third distinct one.
	private static func genres(of value: NodeEdgeValue?) -> [String] {
		let edges: [NodeEdge]
		switch value {
		case .one(let edge): edges = [edge]
		case .many(let list): edges = list
		case nil: return []
		}
		var seen = Set<String>()
		let names = edges.compactMap { NodePageHeader.clean($0.name) }.filter { seen.insert($0).inserted }
		return Array(names.prefix(maxGenres))
	}

	private static func subtitle(of node: NodeDetail) -> String? {
		let year = node.facts["year"].flatMap(NodePageHeader.clean)
		let segments = [NodePageHeader.names(of: node.edges["artists"]), year]
		let line = segments.compactMap { $0 }.joined(separator: " · ")
		return line.isEmpty ? nil : line
	}
}
