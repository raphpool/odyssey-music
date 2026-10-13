import Foundation

/// One line of the search sheet (Figma `ListItem`, `22:142`): the name, the type label shared with the edge chip,
/// and whether the line can be opened. Kept free of SwiftUI so that `swift test` covers it. The name is third-party
/// data: the caller shows it verbatim.
public struct SearchRow: Equatable, Sendable {
	/// Shown under a catalog hit that has no card yet. A card is never generated from the search (D11).
	public static let missingSubtitle = "Pas encore de fiche"

	public let title: String
	public let subtitle: String
	/// False for a catalog hit: the line stays visible, but opening it does nothing.
	public let isAvailable: Bool

	public init(title: String, subtitle: String, isAvailable: Bool) {
		self.title = title
		self.subtitle = subtitle
		self.isAvailable = isAvailable
	}

	init(hit: SearchHit) {
		let hasCard = hit.hasCard
		self.init(
			title: hit.name, subtitle: hasCard ? EdgeChipFormat.typeLabel(hit.type) : Self.missingSubtitle,
			isAvailable: hasCard)
	}

	init(recent: RecentNode) {
		self.init(title: recent.name, subtitle: EdgeChipFormat.typeLabel(recent.type), isAvailable: true)
	}
}

extension SearchHit {
	/// The card to open: only a cache hit with a slug has one. `SearchViewModel.open` and the rows share it.
	var cardSlug: NodeIdentity? {
		source == "cache" ? slug : nil
	}

	var hasCard: Bool {
		cardSlug != nil
	}
}
