import Foundation
import XCTest

@testable import Track1

final class APIContractIntegrationTests: XCTestCase {
	func testReadsTheOwnedServerAndDoesNotRetryUnavailableGeneration() async throws {
		guard let baseURLValue = ProcessInfo.processInfo.environment["TRACK1_CONTRACT_BASE_URL"],
			let baseURL = URL(string: baseURLValue),
			baseURL.scheme == "http",
			baseURL.host == "127.0.0.1"
		else {
			return XCTFail("TRACK1_CONTRACT_BASE_URL must be passed to XCTest by the contract harness.")
		}

		let client = makeContractClient(proxyBaseURL: baseURL)
		let catalog = await client.catalog()
		guard case .success(let value, let etag) = catalog else {
			return XCTFail("Expected the cached catalog from the owned server, got \(String(describing: catalog)).")
		}
		XCTAssertEqual(value.version, "v1")
		let knownETag = try XCTUnwrap(etag)
		let conditionalCatalog = await client.catalog(etag: knownETag, hasCachedRepresentation: true)
		guard case .notModified(let returnedETag) = conditionalCatalog else {
			return XCTFail("Expected a conditional catalog response, got \(String(describing: conditionalCatalog)).")
		}
		XCTAssertEqual(returnedETag, knownETag)

		let identity = try XCTUnwrap(NodeIdentity(rawValue: "artist:fixture-artist"))
		guard case .success(let node, _) = await client.node(identity) else {
			return XCTFail("Expected a cached node.")
		}
		XCTAssertEqual(node.node.id, identity)

		let requestID = try XCTUnwrap(UUID(uuidString: "11111111-1111-4111-8111-111111111111"))
		let generation = await client.createGeneration(
			GenerationRequest(
				requestID: requestID, type: .artist, name: "Missing Artist", slug: nil, mbid: nil, qid: nil,
				disambiguator: nil)
		)
		guard case .failure(.http(let status, let code, let retryable, _)) = generation else {
			return XCTFail("Expected the intentionally corrupted generation store to return 503.")
		}
		XCTAssertEqual(status, 503)
		XCTAssertEqual(code, "provider_unavailable")
		XCTAssertEqual(retryable, true)
	}
}

private func makeContractClient(proxyBaseURL: URL) -> APIClient {
	ContractLoopbackURLProtocol.setProxyBaseURL(proxyBaseURL)
	let configuration = URLSessionConfiguration.ephemeral
	configuration.protocolClasses = [ContractLoopbackURLProtocol.self]
	guard
		case .success(let appConfiguration) = AppConfiguration.validate(
			values: AppConfigurationValues(
				environment: "development", apiBaseURL: "https://contract.invalid/mobile/v1/", segmentWriteKey: nil))
	else { fatalError("The XCTest-only transport requires a valid public app configuration.") }
	return APIClient(configuration: appConfiguration, session: URLSession(configuration: configuration))
}

private final class ContractLoopbackURLProtocol: URLProtocol, @unchecked Sendable {
	private static let store = ProxyBaseURLStore()

	static func setProxyBaseURL(_ url: URL) { store.set(url) }
	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		guard let proxyBaseURL = Self.store.get(), let requestedURL = request.url,
			let requestedComponents = URLComponents(url: requestedURL, resolvingAgainstBaseURL: false),
			var components = URLComponents(url: proxyBaseURL, resolvingAgainstBaseURL: false)
		else {
			client?.urlProtocol(self, didFailWithError: URLError(.badURL))
			return
		}
		components.percentEncodedPath = requestedComponents.percentEncodedPath
		components.percentEncodedQuery = requestedComponents.percentEncodedQuery
		guard let forwardedURL = components.url else {
			client?.urlProtocol(self, didFailWithError: URLError(.badURL))
			return
		}
		var forwardedRequest = URLRequest(url: forwardedURL)
		forwardedRequest.httpMethod = request.httpMethod
		forwardedRequest.httpBody = request.httpBody
		forwardedRequest.cachePolicy = request.cachePolicy
		forwardedRequest.timeoutInterval = request.timeoutInterval
		forwardedRequest.allHTTPHeaderFields = request.allHTTPHeaderFields
		URLSession.shared.dataTask(with: forwardedRequest) { [weak self] data, response, error in
			guard let self else { return }
			if let error {
				self.client?.urlProtocol(self, didFailWithError: error)
				return
			}
			guard let response else {
				self.client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
				return
			}
			self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
			if let data { self.client?.urlProtocol(self, didLoad: data) }
			self.client?.urlProtocolDidFinishLoading(self)
		}.resume()
	}
	override func stopLoading() {}
}

private final class ProxyBaseURLStore: @unchecked Sendable {
	private let lock = NSLock()
	private var value: URL?

	func set(_ value: URL) {
		lock.lock()
		self.value = value
		lock.unlock()
	}

	func get() -> URL? {
		lock.lock()
		defer { lock.unlock() }
		return value
	}
}
