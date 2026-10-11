#if targetEnvironment(simulator)
	import Foundation

	/// Serves deterministic, network-free `ContentReaders` to the simulator UI tests.
	///
	/// Why: the UI journeys (Today -> node, Search -> node -> relation) need stable data. Injecting it at
	/// the `ContentReaders` seam, from the process environment, keeps the production readers untouched and
	/// avoids intercepting `URLSession` traffic (plan D3). Responses are decoded with the real response
	/// types, so a fixture that the app could not decode in production fails here too.
	///
	/// `TRACK1_UI_TEST_FIXTURES_JSON` carries `{ "nodes", "unavailable", "links", "search" }`; every section
	/// is optional. `TRACK1_PROFILE_CATALOG_JSON` carries the catalog body.
	enum UITestFixtureReaders {
		static let fixturesKey = "TRACK1_UI_TEST_FIXTURES_JSON"
		static let catalogKey = "TRACK1_PROFILE_CATALOG_JSON"

		/// Returns nil when neither variable is present, so the caller keeps the live readers.
		static func make(environment: [String: String]) -> ContentReaders? {
			let catalogJSON = environment[catalogKey]
			let fixturesJSON = environment[fixturesKey]
			guard catalogJSON != nil || fixturesJSON != nil else { return nil }

			// nil means the fixtures variable is present but malformed: every fixture-backed reader then
			// answers `.invalidResponse` instead of crashing the app under test.
			let fixtures: Fixtures?
			if let fixturesJSON {
				fixtures = Fixtures(json: fixturesJSON)
			} else {
				fixtures = .empty
			}

			return ContentReaders(
				catalog: {
					guard let catalogJSON else { return .failure(.network) }
					return decode(Catalog.self, from: Data(catalogJSON.utf8))
				},
				node: { identity in
					guard let fixtures else { return .failure(.invalidResponse) }
					// `unavailable` wins over `nodes`: listing an identity there is an explicit request for a 503.
					if fixtures.unavailable.contains(identity.rawValue) {
						return .failure(
							.http(status: 503, code: "node_unavailable", retryable: true, retryAfterSeconds: nil))
					}
					guard let body = fixtures.nodes[identity.rawValue] else {
						return .failure(.http(status: 404, code: "not_found", retryable: false, retryAfterSeconds: nil))
					}
					return decode(NodeResponse.self, from: body)
				},
				image: { _ in
					.failure(.http(status: 503, code: "image_unavailable", retryable: true, retryAfterSeconds: nil))
				},
				links: { identity in
					guard let fixtures else { return .failure(.invalidResponse) }
					guard let body = fixtures.links[identity.rawValue] else { return .failure(.network) }
					return decode(LinksResponse.self, from: body)
				},
				search: { query, type in
					guard let fixtures else { return .failure(.invalidResponse) }
					let key = normalized(query)
					let body = fixtures.search[key] ?? emptySearchBody(query: key)
					switch decode(SearchResponse.self, from: body) {
					case .success(let response, let etag):
						guard let type else { return .success(response, etag: etag) }
						// A fixture holds the hits of one query, whatever their type; filtering here lets a single
						// fixture serve both the typed and the untyped search. `sources` is returned as authored.
						return .success(
							SearchResponse(
								query: response.query,
								hits: response.hits.filter { $0.type == type },
								sources: response.sources
							),
							etag: etag
						)
					case .notModified(let etag):
						return .notModified(etag: etag)
					case .failure(let error):
						return .failure(error)
					}
				}
			)
		}

		fileprivate static func normalized(_ query: String) -> String {
			query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		}

		private static func emptySearchBody(query: String) -> Data {
			let body: [String: Any] = ["q": query, "hits": [Any](), "sources": ["cache": 0, "catalog": 0]]
			return (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
		}

		private static func decode<Value: Decodable & Sendable>(_ type: Value.Type, from data: Data)
			-> APIResult<Value>
		{
			// Same date strategy as `APIClient`, otherwise a fixture could decode here and not in production.
			let decoder = JSONDecoder()
			decoder.dateDecodingStrategy = .iso8601
			do {
				return .success(try decoder.decode(Value.self, from: data), etag: nil)
			} catch {
				return .failure(.invalidResponse)
			}
		}
	}

	/// The parsed `TRACK1_UI_TEST_FIXTURES_JSON`. Bodies stay as raw JSON and are decoded per call, so one
	/// malformed entry only breaks the identity or query that uses it.
	private struct Fixtures: Sendable {
		let nodes: [String: Data]
		let unavailable: Set<String>
		let links: [String: Data]
		let search: [String: Data]

		static let empty = Fixtures(nodes: [:], unavailable: [], links: [:], search: [:])

		private init(
			nodes: [String: Data], unavailable: Set<String>, links: [String: Data], search: [String: Data]
		) {
			self.nodes = nodes
			self.unavailable = unavailable
			self.links = links
			self.search = search
		}

		/// Fails (nil) when the document is not a JSON object or a section has the wrong shape.
		init?(json: String) {
			guard let root = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
				let nodes = Self.bodies(root["nodes"]),
				let links = Self.bodies(root["links"]),
				let rawSearch = Self.bodies(root["search"]),
				let unavailable = Self.identities(root["unavailable"])
			else { return nil }
			// Keys are normalised like incoming queries, so a fixture written as "Jazz" is still found
			// instead of silently answering with zero hits.
			let search = Dictionary(
				rawSearch.map { (UITestFixtureReaders.normalized($0.key), $0.value) },
				uniquingKeysWith: { _, last in last })
			self.init(nodes: nodes, unavailable: unavailable, links: links, search: search)
		}

		private static func bodies(_ section: Any?) -> [String: Data]? {
			guard let section else { return [:] }
			guard let entries = section as? [String: Any] else { return nil }
			// An entry that cannot be re-serialised becomes empty data, which fails decoding later.
			return entries.mapValues { entry in
				guard JSONSerialization.isValidJSONObject(entry) else { return Data() }
				return (try? JSONSerialization.data(withJSONObject: entry)) ?? Data()
			}
		}

		private static func identities(_ section: Any?) -> Set<String>? {
			guard let section else { return [] }
			guard let values = section as? [String] else { return nil }
			return Set(values)
		}
	}
#endif
