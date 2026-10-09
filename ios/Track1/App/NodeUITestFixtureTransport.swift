#if targetEnvironment(simulator)
	import Foundation
	import Observation

	enum NodeUITestFixtureTransport {
		@MainActor
		static func makeSession(arguments: [String]) -> (session: URLSession, startupNode: NodeIdentity)? {
			guard let rawIdentity = argumentValue(named: "-track1-ui-test-node", in: arguments),
				let startupNode = NodeIdentity(rawValue: rawIdentity)
			else { return nil }

			let configuration = URLSessionConfiguration.ephemeral
			configuration.protocolClasses = [NodeUITestFixtureURLProtocol.self]
			NodeUITestFixtureRequestAudit.shared.reset()
			return (URLSession(configuration: configuration), startupNode)
		}

		private static func argumentValue(named name: String, in arguments: [String]) -> String? {
			guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
			return arguments[index + 1]
		}
	}

	@MainActor
	@Observable
	final class NodeUITestFixtureRequestAudit {
		static let shared = NodeUITestFixtureRequestAudit()
		private(set) var unexpectedRequestCount = -1

		func reset() {
			unexpectedRequestCount = -1
		}

		func recordRequest(unexpected: Bool) {
			guard unexpectedRequestCount >= 0 else {
				unexpectedRequestCount = unexpected ? 1 : 0
				return
			}
			guard unexpected else { return }
			unexpectedRequestCount += 1
		}
	}

	private final class NodeUITestFixtureURLProtocol: URLProtocol, @unchecked Sendable {
		override class func canInit(with request: URLRequest) -> Bool { true }
		override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

		override func startLoading() {
			guard let url = request.url else {
				client?.urlProtocol(self, didFailWithError: URLError(.badURL))
				return
			}
			let path = url.path.removingPercentEncoding ?? url.path
			if path == "/images/fixture-artist.png" {
				recordRequest(unexpected: false)
				client?.urlProtocol(self, didFailWithError: URLError(.cannotLoadFromNetwork))
				return
			}

			let response: FixtureResponse
			switch (request.httpMethod, path) {
			case ("GET", "/mobile/v1/nodes/artist:fixture-artist"):
				response = .json(fixtureArtist)
			case ("GET", "/mobile/v1/nodes/genre:ambient"):
				response = .json(fixtureGenre)
			case ("GET", "/mobile/v1/nodes/artist:missing"):
				response = .error(status: 404, code: "not_found")
			case ("GET", "/mobile/v1/nodes/artist:unavailable"):
				response = .error(status: 503, code: "node_unavailable")
			case ("GET", "/mobile/v1/nodes/artist:fixture-artist/image"):
				response = .error(status: 503, code: "image_unavailable")
			case ("GET", "/mobile/v1/nodes/genre:ambient/image"):
				response = .json(fixtureGenreImage)
			default:
				recordRequest(unexpected: true)
				response = .error(status: 500, code: "unexpected_fixture_request")
			}
			if response.status != 500 { recordRequest(unexpected: false) }
			respond(with: response, for: url)
		}

		override func stopLoading() {}

		private func recordRequest(unexpected: Bool) {
			Task { @MainActor in
				NodeUITestFixtureRequestAudit.shared.recordRequest(unexpected: unexpected)
			}
		}

		private func respond(with fixture: FixtureResponse, for url: URL) {
			let response = HTTPURLResponse(
				url: url, statusCode: fixture.status, httpVersion: "HTTP/1.1",
				headerFields: ["Content-Type": "application/json"]
			)!
			client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
			client?.urlProtocol(self, didLoad: fixture.body)
			client?.urlProtocolDidFinishLoading(self)
		}

		private struct FixtureResponse {
			let status: Int
			let body: Data

			static func json(_ body: Data) -> Self { Self(status: 200, body: body) }
			static func error(status: Int, code: String) -> Self {
				let body = Data("{\"error\":{\"code\":\"\(code)\",\"retryable\":false}}".utf8)
				return Self(status: status, body: body)
			}
		}
	}

	private let fixtureArtist = Data(
		#"""
		{
		  "node": {
		    "id": "artist:fixture-artist",
		    "type": "artist",
		    "name": "Fixture Artist",
		    "teaser": "Une fiche déterministe pour les tests d’interface.",
		    "article": "Une introduction fiable.\n\n- Une relation vers Ambient",
		    "citations": [{"url": "https://example.com/fixture", "title": "Source fixture"}],
		    "facts": {},
		    "edges": {"genres": [{"slug": "genre:ambient", "type": "genre", "name": "Ambient"}]},
		    "materialized_at": "2026-10-08T00:00:00Z",
		    "image_url": "https://track1-ui-test.invalid/images/fixture-artist.png"
		  },
		  "source": "cache"
		}
		"""#.utf8
	)

	private let fixtureGenre = Data(
		#"""
		{
		  "node": {
		    "id": "genre:ambient",
		    "type": "genre",
		    "name": "Ambient",
		    "teaser": "Une relation de fixture.",
		    "article": "Une fiche de relation.",
		    "citations": [],
		    "facts": {},
		    "edges": {},
		    "materialized_at": "2026-10-08T00:00:00Z",
		    "image_url": null
		  },
		  "source": "cache"
		}
		"""#.utf8
	)

	private let fixtureGenreImage = Data(#"{"slug":"genre:ambient","image_url":null,"source":"fixture"}"#.utf8)
#endif
