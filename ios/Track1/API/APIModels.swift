import Foundation

private enum APIKeys: String, CodingKey {
	case version, revision, taxonomy, nodes, edges, identity, type, name, teaser
	case source, target, available, mode, url, title, slug, mbid, qid, year, releaseType
	case cache, catalog, subtitle, extra, code, message, retryable
}

enum NodeType: String, CaseIterable, Codable, Sendable {
	case artist
	case project
	case track
	case genre
	case label
}

struct NodeIdentity: RawRepresentable, Hashable, Codable, Sendable {
	let rawValue: String

	init?(rawValue: String) {
		let parts = rawValue.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
		guard parts.count == 2, NodeType(rawValue: String(parts[0])) != nil,
			String(parts[1]).range(
				of: "^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$", options: .regularExpression) != nil
		else { return nil }
		self.rawValue = rawValue
	}

	var type: NodeType { NodeType(rawValue: String(rawValue.prefix(while: { $0 != ":" })))! }

	init(from decoder: Decoder) throws {
		let value = try decoder.singleValueContainer().decode(String.self)
		guard let identity = NodeIdentity(rawValue: value) else {
			throw DecodingError.dataCorruptedError(
				in: try decoder.singleValueContainer(), debugDescription: "Invalid node identity.")
		}
		self = identity
	}

	func encode(to encoder: Encoder) throws {
		var container = encoder.singleValueContainer()
		try container.encode(rawValue)
	}
}

struct Catalog: Decodable, Sendable {
	let version: String
	let revision: String
	let taxonomy: CatalogTaxonomy
	let nodes: [CatalogNode]
	let edges: [CatalogEdge]

	init(from decoder: Decoder) throws {
		let values = try decoder.container(keyedBy: APIKeys.self)
		version = try values.decode(String.self, forKey: .version)
		revision = try values.decode(String.self, forKey: .revision)
		taxonomy = try values.decode(CatalogTaxonomy.self, forKey: .taxonomy)
		nodes = try values.decode([CatalogNode].self, forKey: .nodes)
		edges = try values.decode([CatalogEdge].self, forKey: .edges)
		guard version == "v1", revision.range(of: "^sha256:[a-f0-9]{64}$", options: .regularExpression) != nil
		else { throw APIModelError.invalidValue }
	}
}

struct CatalogTaxonomy: Decodable, Sendable {
	let mode: String
	let available: Bool

	init(from decoder: Decoder) throws {
		let values = try decoder.container(keyedBy: APIKeys.self)
		mode = try values.decode(String.self, forKey: .mode)
		available = try values.decode(Bool.self, forKey: .available)
		guard mode == "degraded" else { throw APIModelError.invalidValue }
	}
}
struct CatalogNode: Decodable, Sendable {
	let identity: NodeIdentity
	let type: NodeType
	let name: String
	let teaser: String?
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		identity = try v.decode(NodeIdentity.self, forKey: .identity)
		type = try v.decode(NodeType.self, forKey: .type)
		name = try v.decode(String.self, forKey: .name)
		teaser = try v.decodeRequiredNullable(String.self, forKey: .teaser)
		guard identity.type == type, !name.isEmpty else { throw APIModelError.invalidValue }
	}
}
struct CatalogEdge: Decodable, Sendable {
	let source: NodeIdentity
	let target: NodeIdentity
	let type: String
}

struct NodeResponse: Decodable, Sendable {
	let node: NodeDetail
	let source: String
	let redirectedFrom: NodeIdentity?
	enum CodingKeys: String, CodingKey {
		case node, source
		case redirectedFrom = "redirected_from"
	}
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		node = try v.decode(NodeDetail.self, forKey: .node)
		source = try v.decode(String.self, forKey: .source)
		redirectedFrom = try v.decodeIfPresent(NodeIdentity.self, forKey: .redirectedFrom)
		guard source == "cache" else { throw APIModelError.invalidValue }
	}
}
struct NodeDetail: Decodable, Sendable {
	let id: NodeIdentity
	let type: NodeType
	let name: String
	let teaser: String?
	let article: String
	let citations: [Citation]
	let facts: [String: String]
	let edges: [String: NodeEdgeValue]
	let materializedAt: Date
	let imageURL: URL?
	enum CodingKeys: String, CodingKey {
		case id, type, name, teaser, article, citations, facts, edges
		case materializedAt = "materialized_at"
		case imageURL = "image_url"
	}
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		id = try v.decode(NodeIdentity.self, forKey: .id)
		type = try v.decode(NodeType.self, forKey: .type)
		name = try v.decode(String.self, forKey: .name)
		teaser = try v.decodeRequiredNullable(String.self, forKey: .teaser)
		article = try v.decode(String.self, forKey: .article)
		citations = try v.decode([Citation].self, forKey: .citations)
		facts = try v.decode([String: String].self, forKey: .facts)
		edges = try v.decode([String: NodeEdgeValue].self, forKey: .edges)
		materializedAt = try v.decode(Date.self, forKey: .materializedAt)
		imageURL = try v.decodeIfPresent(ValidatedPublicURL.self, forKey: .imageURL)?.value
		guard id.type == type, !name.isEmpty else { throw APIModelError.invalidValue }
	}
}
struct Citation: Decodable, Sendable {
	let url: URL
	let title: String?
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		url = try v.decode(ValidatedPublicURL.self, forKey: .url).value
		title = try v.decodeIfPresent(String.self, forKey: .title)
		if title?.isEmpty == true { throw APIModelError.invalidValue }
	}
}
enum NodeEdgeValue: Decodable, Sendable {
	case one(NodeEdge)
	case many([NodeEdge])
	init(from decoder: Decoder) throws {
		if let edge = try? NodeEdge(from: decoder) {
			self = .one(edge)
		} else {
			self = .many(try [NodeEdge](from: decoder))
		}
	}
}
struct NodeEdge: Decodable, Sendable {
	let slug: NodeIdentity
	let type: NodeType
	let name: String
	let mbid: UUID?
	let qid: String?
	let year: String?
	let releaseType: String?
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		slug = try v.decode(NodeIdentity.self, forKey: .slug)
		type = try v.decode(NodeType.self, forKey: .type)
		name = try v.decode(String.self, forKey: .name)
		mbid = try v.decodeIfPresent(UUID.self, forKey: .mbid)
		qid = try v.decodeIfPresent(String.self, forKey: .qid)
		year = try v.decodeIfPresent(String.self, forKey: .year)
		releaseType = try v.decodeIfPresent(String.self, forKey: .releaseType)
		guard slug.type == type, !name.isEmpty,
			qid.map({ $0.range(of: "^Q[1-9][0-9]*$", options: .regularExpression) != nil }) ?? true,
			releaseType.map({ ["album", "ep", "single"].contains($0) }) ?? true
		else { throw APIModelError.invalidValue }
	}
}

struct ImageResponse: Decodable, Sendable {
	let slug: NodeIdentity
	let imageURL: URL?
	let source: String
	enum CodingKeys: String, CodingKey {
		case slug, source
		case imageURL = "image_url"
	}
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		slug = try v.decode(NodeIdentity.self, forKey: .slug)
		imageURL = try v.decodeRequiredNullable(ValidatedPublicURL.self, forKey: .imageURL)?.value
		source = try v.decode(String.self, forKey: .source)
		guard !source.isEmpty else { throw APIModelError.invalidValue }
	}
}
struct LinksResponse: Decodable, Sendable {
	let slug: NodeIdentity
	let spotify: URL?
	let apple: URL?
	let sources: [String: JSONValue]
	let resolvedAt: Date
	enum CodingKeys: String, CodingKey {
		case slug, spotify, apple, sources
		case resolvedAt = "resolvedAt"
		case resolvedAtSnake = "resolved_at"
	}
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		slug = try v.decode(NodeIdentity.self, forKey: .slug)
		spotify = try v.decodeRequiredNullable(SpotifyURL.self, forKey: .spotify)?.value
		apple = try v.decodeRequiredNullable(AppleURL.self, forKey: .apple)?.value
		sources = try v.decode([String: JSONValue].self, forKey: .sources)
		resolvedAt =
			try v.decodeIfPresent(Date.self, forKey: .resolvedAt) ?? v.decode(Date.self, forKey: .resolvedAtSnake)
	}
}

struct SearchResponse: Decodable, Sendable {
	let query: String
	let hits: [SearchHit]
	let sources: SearchSources
	enum CodingKeys: String, CodingKey {
		case query = "q"
		case hits, sources
	}
}
struct SearchSources: Decodable, Sendable {
	let cache: Int
	let catalog: Int
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		cache = try v.decode(Int.self, forKey: .cache)
		catalog = try v.decode(Int.self, forKey: .catalog)
		guard cache >= 0, catalog >= 0 else { throw APIModelError.invalidValue }
	}
}
struct SearchHit: Decodable, Sendable {
	let source: String
	let type: NodeType
	let name: String
	let slug: NodeIdentity?
	let mbid: UUID?
	let subtitle: String?
	let extra: String?
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		source = try v.decode(String.self, forKey: .source)
		type = try v.decode(NodeType.self, forKey: .type)
		name = try v.decode(String.self, forKey: .name)
		slug = try v.decodeIfPresent(NodeIdentity.self, forKey: .slug)
		mbid = try v.decodeIfPresent(UUID.self, forKey: .mbid)
		subtitle = try v.decodeIfPresent(String.self, forKey: .subtitle)
		extra = try v.decodeIfPresent(String.self, forKey: .extra)
		guard ["cache", "catalog"].contains(source), !name.isEmpty, source != "cache" || slug != nil else {
			throw APIModelError.invalidValue
		}
	}
}

enum GenerationStatus: String, Decodable, Sendable { case queued, running, succeeded, failed, interrupted }
struct Generation: Decodable, Sendable {
	let requestID: UUID
	let status: GenerationStatus
	let createdAt: Date
	let updatedAt: Date
	let nodeID: NodeIdentity?
	let error: GenerationError?
	enum CodingKeys: String, CodingKey {
		case requestID = "request_id"
		case status
		case createdAt = "created_at"
		case updatedAt = "updated_at"
		case nodeID = "node_id"
		case error
	}
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		requestID = try v.decode(UUID.self, forKey: .requestID)
		status = try v.decode(GenerationStatus.self, forKey: .status)
		createdAt = try v.decode(Date.self, forKey: .createdAt)
		updatedAt = try v.decode(Date.self, forKey: .updatedAt)
		nodeID = try v.decodeIfPresent(NodeIdentity.self, forKey: .nodeID)
		error = try v.decodeIfPresent(GenerationError.self, forKey: .error)
		guard status != .succeeded || nodeID != nil, ![.failed, .interrupted].contains(status) || error != nil
		else { throw APIModelError.invalidValue }
	}
}
struct GenerationError: Decodable, Sendable {
	let code: String
	let message: String
	let retryable: Bool
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		code = try v.decode(String.self, forKey: .code)
		message = try v.decode(String.self, forKey: .message)
		retryable = try v.decode(Bool.self, forKey: .retryable)
		guard !code.isEmpty else { throw APIModelError.invalidValue }
	}
}
struct GenerationRequest: Encodable, Sendable {
	let requestID: UUID
	let type: NodeType
	let name: String
	let slug: NodeIdentity?
	let mbid: UUID?
	let qid: String?
	let disambiguator: String?
	enum CodingKeys: String, CodingKey {
		case requestID = "request_id"
		case type, name, slug, mbid, qid, disambiguator
	}
}

private enum APIModelError: Error { case invalidValue }
extension KeyedDecodingContainer {
	fileprivate func decodeRequiredNullable<Value: Decodable>(_ type: Value.Type, forKey key: Key) throws
		-> Value?
	{
		guard contains(key) else {
			throw DecodingError.keyNotFound(
				key, .init(codingPath: codingPath, debugDescription: "Required nullable field is missing."))
		}
		return try decodeNil(forKey: key) ? nil : decode(Value.self, forKey: key)
	}
}
private struct ValidatedPublicURL: Decodable {
	let value: URL
	init(from decoder: Decoder) throws {
		let value = try decoder.singleValueContainer().decode(String.self)
		guard let url = URLValidation.publicHTTPSURL(from: value) else { throw APIModelError.invalidValue }
		self.value = url
	}
}
private struct SpotifyURL: Decodable {
	let value: URL
	init(from decoder: Decoder) throws {
		let value = try decoder.singleValueContainer().decode(String.self)
		guard let url = URLValidation.providerURL(from: value, host: "open.spotify.com") else {
			throw APIModelError.invalidValue
		}
		self.value = url
	}
}
private struct AppleURL: Decodable {
	let value: URL
	init(from decoder: Decoder) throws {
		let value = try decoder.singleValueContainer().decode(String.self)
		guard let url = URLValidation.providerURL(from: value, host: "music.apple.com") else {
			throw APIModelError.invalidValue
		}
		self.value = url
	}
}
enum JSONValue: Decodable, Sendable {
	case string(String)
	case number(Double)
	case boolean(Bool)
	case null
	case array([JSONValue])
	case object([String: JSONValue])
	init(from decoder: Decoder) throws {
		let c = try decoder.singleValueContainer()
		if c.decodeNil() {
			self = .null
		} else if let v = try? c.decode(Bool.self) {
			self = .boolean(v)
		} else if let v = try? c.decode(Double.self) {
			self = .number(v)
		} else if let v = try? c.decode(String.self) {
			self = .string(v)
		} else if let v = try? c.decode([JSONValue].self) {
			self = .array(v)
		} else {
			self = .object(try c.decode([String: JSONValue].self))
		}
	}
}
