import Foundation

/// The only network surface screens may use in V1.
///
/// Why: the V1 is read-only by construction (plan D2). Screens receive these closures instead of
/// `APIClient`, so `createGeneration` stays on the client type but cannot be reached from any screen.
/// Adding a write member here would reverse that decision; it is not a convenience.
struct ContentReaders: Sendable {
	let catalog: @Sendable () async -> APIResult<Catalog>
	let node: NodeReader
	let image: @Sendable (NodeIdentity) async -> APIResult<ImageResponse>
	let links: @Sendable (NodeIdentity) async -> APIResult<LinksResponse>
	let search: @Sendable (_ query: String, _ type: NodeType?) async -> APIResult<SearchResponse>

	static func live(_ client: APIClient) -> ContentReaders {
		ContentReaders(
			catalog: { await client.catalog() },
			node: { await client.node($0) },
			image: { await client.image($0) },
			links: { await client.links($0) },
			search: { query, type in await client.search(query: query, type: type) }
		)
	}
}
