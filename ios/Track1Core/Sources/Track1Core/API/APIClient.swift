import Foundation

public struct APIClient: Sendable {
	private let baseURL: URL
	private let session: URLSession
	private let decoder: JSONDecoder
	private let encoder: JSONEncoder

	public init(configuration: AppConfiguration, session: URLSession = .shared) {
		baseURL = configuration.apiBaseURL
		self.session = session
		decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
	}

	public func catalog(etag: String? = nil, hasCachedRepresentation: Bool = false) async -> APIResult<Catalog> {
		let headers = etag != nil && hasCachedRepresentation ? ["If-None-Match": etag!] : [:]
		let result: APIResult<Catalog> = await request(
			method: "GET", path: ["catalog"], headers: headers, body: Optional<EmptyBody>.none)
		guard case .notModified(let responseETag) = result else { return result }
		guard hasCachedRepresentation, let etag else { return .failure(.invalidResponse) }
		return .notModified(etag: responseETag.isEmpty ? etag : responseETag)
	}

	public func node(_ identity: NodeIdentity) async -> APIResult<NodeResponse> {
		await read(path: ["nodes", identity.rawValue])
	}
	public func image(_ identity: NodeIdentity) async -> APIResult<ImageResponse> {
		await read(path: ["nodes", identity.rawValue, "image"])
	}
	public func links(_ identity: NodeIdentity) async -> APIResult<LinksResponse> {
		await read(path: ["nodes", identity.rawValue, "links"])
	}
	public func generation(requestID: UUID) async -> APIResult<Generation> {
		await read(path: ["generations", requestID.uuidString.lowercased()])
	}

	public func search(query: String, type: NodeType? = nil, limit: Int? = nil) async -> APIResult<
		SearchResponse
	> {
		var items = [URLQueryItem(name: "q", value: query)]
		if let type { items.append(URLQueryItem(name: "type", value: type.rawValue)) }
		if let limit { items.append(URLQueryItem(name: "limit", value: String(limit))) }
		return await request(
			method: "GET", path: ["search"], queryItems: items, headers: [:], body: Optional<EmptyBody>.none)
	}

	public func createGeneration(_ input: GenerationRequest) async -> APIResult<Generation> {
		guard !input.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
			input.slug.map({ $0.type == input.type }) ?? true,
			input.qid.map({ $0.range(of: "^Q[1-9][0-9]*$", options: .regularExpression) != nil }) ?? true,
			// The server's own rule for the edge field of `source` (TRA-477); the check by node type is its job.
			input.source.map({
				$0.field.count <= 40 && $0.field.range(of: "^[a-z]+(?:_[a-z]+)*$", options: .regularExpression) != nil
			}) ?? true
		else { return .failure(.invalidRequest) }
		return await request(method: "POST", path: ["generations"], headers: [:], body: input)
	}

	private func read<Value: Decodable & Sendable>(path: [String]) async -> APIResult<Value> {
		let result: APIResult<Value> = await request(
			method: "GET", path: path, headers: [:], body: Optional<EmptyBody>.none)
		if case .notModified = result { return .failure(.invalidResponse) }
		return result
	}

	private func request<Value: Decodable & Sendable, Body: Encodable>(
		method: String, path: [String], queryItems: [URLQueryItem] = [], headers: [String: String], body: Body?
	) async -> APIResult<Value> {
		guard !Task.isCancelled else { return .failure(.cancelled) }
		guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
			return .failure(.invalidRequest)
		}
		let encodedPath = path.map {
			$0.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~")))
				?? ""
		}.joined(separator: "/")
		let basePath =
			components.percentEncodedPath.hasSuffix("/")
			? components.percentEncodedPath : "\(components.percentEncodedPath)/"
		components.percentEncodedPath = basePath + encodedPath
		components.queryItems = queryItems
		guard let url = components.url, url.scheme == baseURL.scheme, url.host == baseURL.host else {
			return .failure(.invalidRequest)
		}
		var request = URLRequest(url: url)
		request.httpMethod = method
		request.cachePolicy = .reloadIgnoringLocalCacheData
		request.timeoutInterval = 15
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
		do {
			if let body {
				request.httpBody = try encoder.encode(body)
				request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			}
			let (data, response) = try await session.data(for: request, delegate: RejectRedirectDelegate.shared)
			guard !Task.isCancelled else { return .failure(.cancelled) }
			guard let response = response as? HTTPURLResponse else { return .failure(.invalidResponse) }
			if response.statusCode == 304 {
				return .notModified(etag: response.value(forHTTPHeaderField: "ETag") ?? "")
			}
			guard (200...299).contains(response.statusCode) else {
				return .failure(apiError(from: data, response: response))
			}
			do {
				let value = try decoder.decode(Value.self, from: data)
				guard !Task.isCancelled else { return .failure(.cancelled) }
				return .success(value, etag: response.value(forHTTPHeaderField: "ETag"))
			} catch { return .failure(.invalidResponse) }
		} catch is CancellationError { return .failure(.cancelled) } catch let error as URLError {
			switch error.code {
			case .cancelled: return .failure(.cancelled)
			case .timedOut: return .failure(.timeout)
			default: return .failure(.network)
			}
		} catch { return .failure(.network) }
	}

	private func apiError(from data: Data, response: HTTPURLResponse) -> APIError {
		struct Envelope: Decodable { let error: Detail }
		struct Detail: Decodable {
			let code: String
			let retryable: Bool?
		}
		let envelope = try? decoder.decode(Envelope.self, from: data)
		let retryAfter = response.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init)
		return .http(
			status: response.statusCode, code: envelope?.error.code, retryable: envelope?.error.retryable,
			retryAfterSeconds: retryAfter)
	}
}

private struct EmptyBody: Encodable {}

final class RejectRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
	static let shared = RejectRedirectDelegate()

	func urlSession(
		_ session: URLSession,
		task: URLSessionTask,
		willPerformHTTPRedirection response: HTTPURLResponse,
		newRequest request: URLRequest,
		completionHandler: @escaping (URLRequest?) -> Void
	) {
		completionHandler(nil)
	}
}
