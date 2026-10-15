import Foundation

private enum APIKeys: String, CodingKey {
	case version, revision, taxonomy, nodes, edges, identity, type, name, teaser
	case source, target, available, mode, url, title, slug, mbid, qid, year, releaseType
	case cache, catalog, subtitle, extra, code, message, retryable
}

public enum NodeType: String, CaseIterable, Codable, Sendable {
	case artist
	case project
	case track
	case genre
	case label
}

public struct NodeIdentity: RawRepresentable, Hashable, Codable, Sendable {
	public let rawValue: String

	public init?(rawValue: String) {
		let parts = rawValue.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
		guard parts.count == 2, NodeType(rawValue: String(parts[0])) != nil,
			String(parts[1]).range(
				of: "^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$", options: .regularExpression) != nil
		else { return nil }
		self.rawValue = rawValue
	}

	public var type: NodeType { NodeType(rawValue: String(rawValue.prefix(while: { $0 != ":" })))! }

	public init(from decoder: Decoder) throws {
		let value = try decoder.singleValueContainer().decode(String.self)
		guard let identity = NodeIdentity(rawValue: value) else {
			throw DecodingError.dataCorruptedError(
				in: try decoder.singleValueContainer(), debugDescription: "Invalid node identity.")
		}
		self = identity
	}

	public func encode(to encoder: Encoder) throws {
		var container = encoder.singleValueContainer()
		try container.encode(rawValue)
	}
}

public struct Catalog: Decodable, Sendable {
	public let version: String
	public let revision: String
	public let taxonomy: CatalogTaxonomy
	public let nodes: [CatalogNode]
	public let edges: [CatalogEdge]

	public init(from decoder: Decoder) throws {
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

public struct CatalogTaxonomy: Decodable, Sendable {
	public let mode: String
	public let available: Bool

	public init(from decoder: Decoder) throws {
		let values = try decoder.container(keyedBy: APIKeys.self)
		mode = try values.decode(String.self, forKey: .mode)
		available = try values.decode(Bool.self, forKey: .available)
		guard mode == "degraded" else { throw APIModelError.invalidValue }
	}
}
public struct CatalogNode: Decodable, Sendable {
	public let identity: NodeIdentity
	public let type: NodeType
	public let name: String
	public let teaser: String?
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		identity = try v.decode(NodeIdentity.self, forKey: .identity)
		type = try v.decode(NodeType.self, forKey: .type)
		name = try v.decode(String.self, forKey: .name)
		teaser = try v.decodeRequiredNullable(String.self, forKey: .teaser)
		guard identity.type == type, !name.isEmpty else { throw APIModelError.invalidValue }
	}
}
public struct CatalogEdge: Decodable, Sendable {
	public let source: NodeIdentity
	public let target: NodeIdentity
	public let type: String
}

public struct NodeResponse: Decodable, Sendable {
	public let node: NodeDetail
	public let source: String
	public let redirectedFrom: NodeIdentity?
	enum CodingKeys: String, CodingKey {
		case node, source
		case redirectedFrom = "redirected_from"
	}
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		node = try v.decode(NodeDetail.self, forKey: .node)
		source = try v.decode(String.self, forKey: .source)
		redirectedFrom = try v.decodeIfPresent(NodeIdentity.self, forKey: .redirectedFrom)
		guard source == "cache" else { throw APIModelError.invalidValue }
	}
}
public struct NodeDetail: Decodable, Sendable {
	public let id: NodeIdentity
	public let type: NodeType
	public let name: String
	public let teaser: String?
	public let article: String
	public let citations: [Citation]
	public let facts: [String: String]
	public let edges: [String: NodeEdgeValue]
	public let materializedAt: Date
	public let imageURL: URL?
	/// How the server obtained `imageURL` (for example a cover derived from a release). Never shown as text
	/// (rule 9); the hero reads it to pick its `HeroImageStyle`.
	public let imageSource: String?
	enum CodingKeys: String, CodingKey {
		case id, type, name, teaser, article, citations, facts, edges
		case materializedAt = "materialized_at"
		case imageURL = "image_url"
		case imageSource = "image_source"
	}
	public init(from decoder: Decoder) throws {
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
		imageSource = try v.decodeIfPresent(String.self, forKey: .imageSource)
		guard id.type == type, !name.isEmpty else { throw APIModelError.invalidValue }
	}
}
public struct Citation: Decodable, Sendable {
	public let url: URL
	public let title: String?
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		url = try v.decode(ValidatedPublicURL.self, forKey: .url).value
		title = try v.decodeIfPresent(String.self, forKey: .title)
		if title?.isEmpty == true { throw APIModelError.invalidValue }
	}
}
public enum NodeEdgeValue: Decodable, Sendable {
	case one(NodeEdge)
	case many([NodeEdge])
	public init(from decoder: Decoder) throws {
		if let edge = try? NodeEdge(from: decoder) {
			self = .one(edge)
		} else {
			self = .many(try [NodeEdge](from: decoder))
		}
	}
}
public struct NodeEdge: Decodable, Sendable {
	public let slug: NodeIdentity
	public let type: NodeType
	public let name: String
	public let mbid: UUID?
	public let qid: String?
	public let year: String?
	public let releaseType: String?
	public init(from decoder: Decoder) throws {
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

public struct ImageResponse: Decodable, Sendable {
	public let slug: NodeIdentity
	public let imageURL: URL?
	public let source: String
	enum CodingKeys: String, CodingKey {
		case slug, source
		case imageURL = "image_url"
	}
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		slug = try v.decode(NodeIdentity.self, forKey: .slug)
		imageURL = try v.decodeRequiredNullable(ValidatedPublicURL.self, forKey: .imageURL)?.value
		source = try v.decode(String.self, forKey: .source)
		guard !source.isEmpty else { throw APIModelError.invalidValue }
	}
}
public struct LinksResponse: Decodable, Sendable {
	public let slug: NodeIdentity
	public let spotify: URL?
	public let apple: URL?
	public let sources: [String: JSONValue]
	public let resolvedAt: Date
	enum CodingKeys: String, CodingKey {
		case slug, spotify, apple, sources
		case resolvedAt = "resolvedAt"
		case resolvedAtSnake = "resolved_at"
	}
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		slug = try v.decode(NodeIdentity.self, forKey: .slug)
		spotify = try v.decodeRequiredNullable(SpotifyURL.self, forKey: .spotify)?.value
		apple = try v.decodeRequiredNullable(AppleURL.self, forKey: .apple)?.value
		sources = try v.decode([String: JSONValue].self, forKey: .sources)
		resolvedAt =
			try v.decodeIfPresent(Date.self, forKey: .resolvedAt) ?? v.decode(Date.self, forKey: .resolvedAtSnake)
	}
}

public struct SearchResponse: Decodable, Sendable {
	public let query: String
	public let hits: [SearchHit]
	public let sources: SearchSources
	enum CodingKeys: String, CodingKey {
		case query = "q"
		case hits, sources
	}

	public init(query: String, hits: [SearchHit], sources: SearchSources) {
		self.query = query
		self.hits = hits
		self.sources = sources
	}
}
public struct SearchSources: Decodable, Sendable {
	public let cache: Int
	public let catalog: Int
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		cache = try v.decode(Int.self, forKey: .cache)
		catalog = try v.decode(Int.self, forKey: .catalog)
		guard cache >= 0, catalog >= 0 else { throw APIModelError.invalidValue }
	}
}
public struct SearchHit: Decodable, Sendable {
	public let source: String
	public let type: NodeType
	public let name: String
	public let slug: NodeIdentity?
	public let mbid: UUID?
	public let subtitle: String?
	public let extra: String?
	public init(from decoder: Decoder) throws {
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

public enum GenerationStatus: String, Decodable, Sendable {
	case queued, running, succeeded, failed, interrupted
}
public struct Generation: Decodable, Sendable {
	public let requestID: UUID
	public let status: GenerationStatus
	public let createdAt: Date
	public let updatedAt: Date
	public let nodeID: NodeIdentity?
	public let error: GenerationError?
	enum CodingKeys: String, CodingKey {
		case requestID = "request_id"
		case status
		case createdAt = "created_at"
		case updatedAt = "updated_at"
		case nodeID = "node_id"
		case error
	}
	public init(from decoder: Decoder) throws {
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
public struct GenerationError: Decodable, Sendable {
	public let code: String
	public let message: String
	public let retryable: Bool
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		code = try v.decode(String.self, forKey: .code)
		message = try v.decode(String.self, forKey: .message)
		retryable = try v.decode(Bool.self, forKey: .retryable)
		guard !code.isEmpty else { throw APIModelError.invalidValue }
	}
}
public struct GenerationRequest: Encodable, Sendable {
	public let requestID: UUID
	public let type: NodeType
	public let name: String
	public let slug: NodeIdentity?
	public let mbid: UUID?
	public let qid: String?
	public let disambiguator: String?
	enum CodingKeys: String, CodingKey {
		case requestID = "request_id"
		case type, name, slug, mbid, qid, disambiguator
	}

	public init(
		requestID: UUID, type: NodeType, name: String, slug: NodeIdentity?, mbid: UUID?, qid: String?,
		disambiguator: String?
	) {
		self.requestID = requestID
		self.type = type
		self.name = name
		self.slug = slug
		self.mbid = mbid
		self.qid = qid
		self.disambiguator = disambiguator
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
public enum JSONValue: Decodable, Sendable {
	case string(String)
	case number(Double)
	case boolean(Bool)
	case null
	case array([JSONValue])
	case object([String: JSONValue])
	public init(from decoder: Decoder) throws {
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
