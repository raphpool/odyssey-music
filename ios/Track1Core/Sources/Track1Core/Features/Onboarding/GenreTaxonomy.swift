import Foundation

public struct GenreChoice: Equatable, Sendable {
	public let identity: NodeIdentity
	public let name: String
	public let definition: String?

	public init(identity: NodeIdentity, name: String, definition: String?) {
		self.identity = identity
		self.name = name
		self.definition = definition
	}
}

/// The onboarding genre tree, derived from the catalog rather than hard-coded (D13): a parent is a genre
/// that has at least one subgenre and no parent of its own, so a materialization that adds or moves genres
/// changes the tiles without an app release.
public struct GenreTaxonomy: Sendable {
	public let parents: [GenreChoice]
	private let childrenByParent: [NodeIdentity: [GenreChoice]]

	public init(catalog: Catalog) {
		var genres = [NodeIdentity: GenreChoice]()
		for node in catalog.nodes where node.type == .genre && genres[node.identity] == nil {
			genres[node.identity] = GenreChoice(identity: node.identity, name: node.name, definition: node.teaser)
		}

		// The catalog can carry an edge in either direction: `subgenres` leaves the parent, `parent_genres`
		// leaves the child. Both are read in one pass with no recursion, so an A <-> B cycle stays finite.
		var children = [NodeIdentity: [NodeIdentity]]()
		var hasParent = Set<NodeIdentity>()
		for edge in catalog.edges where edge.source != edge.target {
			let parent: NodeIdentity
			let child: NodeIdentity
			switch edge.type {
			case "subgenres": (parent, child) = (edge.source, edge.target)
			case "parent_genres": (parent, child) = (edge.target, edge.source)
			default: continue
			}
			guard genres[parent] != nil, genres[child] != nil else { continue }
			hasParent.insert(child)
			if !children[parent, default: []].contains(child) { children[parent, default: []].append(child) }
		}

		childrenByParent = children.mapValues { Self.sorted($0.compactMap { genres[$0] }) }
		parents = Self.sorted(children.keys.filter { !hasParent.contains($0) }.compactMap { genres[$0] })
	}

	public func subgenres(of parent: NodeIdentity) -> [GenreChoice] {
		childrenByParent[parent] ?? []
	}

	/// The `fr` locale is explicit: the default comparison follows the device language, which would make the
	/// order (and the tests) depend on the machine.
	private static func sorted(_ choices: [GenreChoice]) -> [GenreChoice] {
		let french = Locale(identifier: "fr")
		return choices.sorted { lhs, rhs in
			switch lhs.name.compare(rhs.name, options: [], range: nil, locale: french) {
			case .orderedAscending: true
			case .orderedDescending: false
			case .orderedSame: lhs.identity.rawValue < rhs.identity.rawValue
			}
		}
	}
}
