import Foundation

private enum APIKeys: String, CodingKey {
	case version, revision, taxonomy, nodes, edges, identity, type, name, teaser
	case source, target, available, mode, url, title, slug, mbid, qid, year, releaseType
	case cache, catalog, subtitle, extra, code, message, retryable
	case families, genres, key, label, order, id, family, slugs, legacySelectionBySlug
	case artist
	case artistSlug = "artist_slug"
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

/// The taxonomy block of the catalog. Decoding is tolerant on purpose (plan D1): the server may serve a
/// mode or a payload this client build does not understand, and rejecting the whole catalog for that would
/// brick the app. Anything unrecognised therefore collapses to `.degraded(available: false)`; only a
/// missing `mode` is a contract error.
public enum CatalogTaxonomy: Decodable, Equatable, Sendable {
	case degraded(available: Bool)
	case editorial(EditorialTaxonomy)

	public init(from decoder: Decoder) throws {
		let values = try decoder.container(keyedBy: APIKeys.self)
		switch try values.decode(String.self, forKey: .mode) {
		case "degraded":
			self = .degraded(available: try values.decode(Bool.self, forKey: .available))
		case "editorial":
			// Any violation of the editorial contract (shape, version, slug type, dangling family) degrades.
			self =
				(try? EditorialTaxonomy(validating: values)).map(CatalogTaxonomy.editorial)
				?? .degraded(available: false)
		default:
			self = .degraded(available: false)
		}
	}
}

public struct EditorialTaxonomy: Equatable, Sendable {
	/// Served order.
	public let families: [EditorialTaxonomyFamily]
	/// Served order.
	public let genres: [EditorialTaxonomyGenre]
	public let legacySelectionBySlug: [NodeIdentity: [String]]

	fileprivate init(validating values: KeyedDecodingContainer<APIKeys>) throws {
		guard try values.decode(Int.self, forKey: .version) == 2 else { throw APIModelError.invalidValue }
		families = try values.decode([EditorialTaxonomyFamily].self, forKey: .families)
		genres = try values.decode([EditorialTaxonomyGenre].self, forKey: .genres)
		// A `[NodeIdentity: [String]]` does not decode as a keyed object (non-String keys decode as a flat
		// alternating array), so the keys are decoded as strings and converted.
		var legacy: [NodeIdentity: [String]] = [:]
		for (rawSlug, selection) in try values.decode([String: [String]].self, forKey: .legacySelectionBySlug) {
			legacy[try EditorialTaxonomy.genreIdentity(rawSlug)] = selection
		}
		legacySelectionBySlug = legacy
		let familyKeys = Set(families.map(\.key))
		guard familyKeys.count == families.count, Set(genres.map(\.id)).count == genres.count,
			genres.allSatisfy({ familyKeys.contains($0.family) })
		else { throw APIModelError.invalidValue }
	}

	fileprivate static func genreIdentity(_ rawValue: String) throws -> NodeIdentity {
		guard let identity = NodeIdentity(rawValue: rawValue), identity.type == .genre else {
			throw APIModelError.invalidValue
		}
		return identity
	}
}

public struct EditorialTaxonomyFamily: Decodable, Equatable, Sendable {
	public let key: String
	public let label: String
	public let order: Int
	public let slug: NodeIdentity?

	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		key = try v.decode(String.self, forKey: .key)
		label = try v.decode(String.self, forKey: .label)
		order = try v.decode(Int.self, forKey: .order)
		slug = try v.decodeIfPresent(NodeIdentity.self, forKey: .slug)
		guard !key.isEmpty, !label.isEmpty, slug.map({ $0.type == .genre }) ?? true else {
			throw APIModelError.invalidValue
		}
	}
}

public struct EditorialTaxonomyGenre: Decodable, Equatable, Sendable {
	public let id: String
	public let name: String
	public let family: String
	public let slugs: [NodeIdentity]

	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		id = try v.decode(String.self, forKey: .id)
		name = try v.decode(String.self, forKey: .name)
		family = try v.decode(String.self, forKey: .family)
		slugs = try v.decode([NodeIdentity].self, forKey: .slugs)
		guard !id.isEmpty, !name.isEmpty, !family.isEmpty, slugs.allSatisfy({ $0.type == .genre }) else {
			throw APIModelError.invalidValue
		}
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
/// The language the text of a node page (`teaser`, `article` and `facts`) is written in.
public enum ContentLanguage: String, Sendable {
	case en, fr
}

extension CodingUserInfoKey {
	/// Replaces `Locale.preferredLanguages` while a `NodeDetail` is decoded. Tests set it to pin the device
	/// language; the app leaves it unset, so `APIClient` needs no language parameter (TRA-814, 2026-11-23).
	public static var preferredLanguages: CodingUserInfoKey {
		CodingUserInfoKey(rawValue: "track1.preferred-languages")!
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
	/// Language of `teaser`, `article` and `facts` as decoded.
	public let contentLanguage: ContentLanguage
	enum CodingKeys: String, CodingKey {
		case id, type, name, teaser, article, citations, facts, edges, l10n
		case materializedAt = "materialized_at"
		case imageURL = "image_url"
		case imageSource = "image_source"
	}
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		id = try v.decode(NodeIdentity.self, forKey: .id)
		type = try v.decode(NodeType.self, forKey: .type)
		name = try v.decode(String.self, forKey: .name)
		let englishTeaser = try v.decodeRequiredNullable(String.self, forKey: .teaser)
		let englishArticle = try v.decode(String.self, forKey: .article)
		var mergedFacts = try v.decode([String: String].self, forKey: .facts)
		// The French block replaces the English text as a whole or not at all: a device that is not French, or
		// a block that is missing, malformed or incomplete, leaves the page in English, never half and half.
		let french = Self.deviceLanguage(of: decoder) == .fr ? Self.frenchContent(in: v) : nil
		for (key, value) in french?.facts ?? [:] where mergedFacts[key] != nil {
			// A blank French value would erase a real English one and drop the fact from the header.
			if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { mergedFacts[key] = value }
		}
		teaser = french?.teaser ?? englishTeaser
		article = french?.article ?? englishArticle
		facts = mergedFacts
		contentLanguage = french != nil ? .fr : .en
		citations = try v.decode([Citation].self, forKey: .citations)
		edges = try v.decode([String: NodeEdgeValue].self, forKey: .edges)
		materializedAt = try v.decode(Date.self, forKey: .materializedAt)
		imageURL = try v.decodeIfPresent(ValidatedPublicURL.self, forKey: .imageURL)?.value
		imageSource = try v.decodeIfPresent(String.self, forKey: .imageSource)
		guard id.type == type, !name.isEmpty else { throw APIModelError.invalidValue }
	}

	/// The language the content is shown in: French when the first preferred language is French, English
	/// otherwise. The only place that decides it, so the readers of `teaser` and `article` stay unchanged.
	public static func preferredContentLanguage(preferredLanguages: [String]) -> ContentLanguage {
		guard let first = preferredLanguages.first?.lowercased() else { return .en }
		return first == "fr" || first.hasPrefix("fr-") || first.hasPrefix("fr_") ? .fr : .en
	}

	/// The only read of the device's languages; `CodingUserInfoKey.preferredLanguages` overrides it in tests.
	private static func deviceLanguage(of decoder: Decoder) -> ContentLanguage {
		let languages = decoder.userInfo[.preferredLanguages] as? [String] ?? Locale.preferredLanguages
		return preferredContentLanguage(preferredLanguages: languages)
	}

	private static func frenchContent(in v: KeyedDecodingContainer<CodingKeys>) -> FrenchContent? {
		let block = (try? v.decodeIfPresent(LocalizedContent.self, forKey: .l10n)) ?? nil
		return block?.fr
	}
}
/// The `l10n.fr` block of a node. Decoding throws unless `teaser` and `article` are filled, so an incomplete
/// block is read as absent (2026-11-23: a French teaser over an English article must never reach the reader).
private struct FrenchContent: Decodable {
	let teaser: String
	let article: String
	let facts: [String: String]
	enum CodingKeys: String, CodingKey { case teaser, article, facts }
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		teaser = try v.decode(String.self, forKey: .teaser)
		article = try v.decode(String.self, forKey: .article)
		facts = try v.decodeIfPresent([String: String].self, forKey: .facts) ?? [:]
		let blank = CharacterSet.whitespacesAndNewlines
		if teaser.trimmingCharacters(in: blank).isEmpty { throw APIModelError.invalidValue }
		if article.trimmingCharacters(in: blank).isEmpty { throw APIModelError.invalidValue }
	}
}
/// The additive `l10n` object of a node. Only `fr` is read: the app never shows another language.
private struct LocalizedContent: Decodable {
	let fr: FrenchContent?
	enum CodingKeys: String, CodingKey { case fr }
	init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		// Additive, optional field: a malformed value is read as absent instead of failing the whole node page.
		fr = (try? v.decodeIfPresent(FrenchContent.self, forKey: .fr)) ?? nil
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
	/// Primary credited artist, set by the server on project and track targets (TRA-477). Absent on other
	/// edges and on nodes written before the field existed; `GenerationRequestBuilder` is its only reader.
	public let artist: String?
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		slug = try v.decode(NodeIdentity.self, forKey: .slug)
		type = try v.decode(NodeType.self, forKey: .type)
		name = try v.decode(String.self, forKey: .name)
		mbid = try v.decodeIfPresent(UUID.self, forKey: .mbid)
		qid = try v.decodeIfPresent(String.self, forKey: .qid)
		year = try v.decodeIfPresent(String.self, forKey: .year)
		releaseType = try v.decodeIfPresent(String.self, forKey: .releaseType)
		// Additive, optional field: a malformed value is read as absent instead of failing the whole node page.
		artist = (try? v.decodeIfPresent(String.self, forKey: .artist)) ?? nil
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
	/// "found", "pending" or "none". `nil` for a server that predates the 202 contract (TRA-586).
	public let state: String?
	/// Server hint for the next attempt while `state` is "pending".
	public let retryAfterSeconds: Int?
	/// The server is still resolving the image in the background: this is "not yet", not a failure.
	public var isPending: Bool { state == "pending" }
	enum CodingKeys: String, CodingKey {
		case slug, source, state
		case imageURL = "image_url"
		case retryAfterSeconds = "retry_after_seconds"
	}
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: CodingKeys.self)
		slug = try v.decode(NodeIdentity.self, forKey: .slug)
		imageURL = try v.decodeRequiredNullable(ValidatedPublicURL.self, forKey: .imageURL)?.value
		source = try v.decode(String.self, forKey: .source)
		guard !source.isEmpty else { throw APIModelError.invalidValue }
		// Additive, optional fields: a malformed value is read as absent instead of failing the response.
		state = (try? v.decodeIfPresent(String.self, forKey: .state)) ?? nil
		retryAfterSeconds = (try? v.decodeIfPresent(Int.self, forKey: .retryAfterSeconds)) ?? nil
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
	/// First credited artist of a project or track hit (TRA-547): the artist context of a generation. Never
	/// derived from `subtitle`, which is a joined display credit.
	public let artist: String?
	/// The card of `artist` when the cache already has it: opens that artist, never builds a work slug.
	public let artistSlug: NodeIdentity?
	public init(from decoder: Decoder) throws {
		let v = try decoder.container(keyedBy: APIKeys.self)
		source = try v.decode(String.self, forKey: .source)
		type = try v.decode(NodeType.self, forKey: .type)
		name = try v.decode(String.self, forKey: .name)
		slug = try v.decodeIfPresent(NodeIdentity.self, forKey: .slug)
		mbid = try v.decodeIfPresent(UUID.self, forKey: .mbid)
		subtitle = try v.decodeIfPresent(String.self, forKey: .subtitle)
		extra = try v.decodeIfPresent(String.self, forKey: .extra)
		// Additive, optional fields: a malformed value is read as absent instead of failing the whole search.
		artist = (try? v.decodeIfPresent(String.self, forKey: .artist)) ?? nil
		let rawArtistSlug = (try? v.decodeIfPresent(NodeIdentity.self, forKey: .artistSlug)) ?? nil
		artistSlug = rawArtistSlug.flatMap { $0.type == .artist ? $0 : nil }
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
/// The edge a generation was asked from (TRA-477): the server repoints it when the node it creates lives
/// under another slug. `field` is the snake_case edge field of the source node's type.
public struct GenerationSource: Encodable, Equatable, Sendable {
	public let slug: NodeIdentity
	public let field: String

	public init(slug: NodeIdentity, field: String) {
		self.slug = slug
		self.field = field
	}
}
public struct GenerationRequest: Encodable, Equatable, Sendable {
	public let requestID: UUID
	public let type: NodeType
	public let name: String
	public let slug: NodeIdentity?
	public let mbid: UUID?
	public let qid: String?
	public let disambiguator: String?
	/// Artist of the screen the tap came from. Always sent for a project or a track: an `mbid` alone only finds
	/// a work that is already cached.
	public let artist: String?
	public let source: GenerationSource?
	enum CodingKeys: String, CodingKey {
		case requestID = "request_id"
		case type, name, slug, mbid, qid, disambiguator, artist, source
	}

	public init(
		requestID: UUID, type: NodeType, name: String, slug: NodeIdentity?, mbid: UUID?, qid: String?,
		disambiguator: String?, artist: String? = nil, source: GenerationSource? = nil
	) {
		self.artist = artist
		self.source = source
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
