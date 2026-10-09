#if targetEnvironment(simulator)
	import XCTest

	@testable import Track1

	@MainActor
	final class NodeUITestFixtureTransportTests: XCTestCase {
		func testFixtureSessionReturnsTheCanonicalNodeThroughAPIClient() async throws {
			let fixture = try XCTUnwrap(
				NodeUITestFixtureTransport.makeSession(arguments: ["-track1-ui-test-node", "artist:fixture-artist"])
			)
			let configuration = validatedConfiguration()
			let identity = try XCTUnwrap(NodeIdentity(rawValue: "artist:fixture-artist"))

			let result = await APIClient(configuration: configuration, session: fixture.session).node(identity)
			guard case .success(let response, _) = result else {
				return XCTFail("Expected the fixture node, got \(String(describing: result)).")
			}
			XCTAssertEqual(response.node.id, identity)
			XCTAssertEqual(NodeUITestFixtureRequestAudit.shared.unexpectedRequestCount, 0)
		}

		private func validatedConfiguration() -> AppConfiguration {
			let result = AppConfiguration.validate(
				values: AppConfigurationValues(
					environment: "development", apiBaseURL: "https://fixture.invalid/mobile/v1/", segmentWriteKey: nil)
			)
			guard case .success(let configuration) = result else {
				fatalError("The fixture configuration must be valid.")
			}
			return configuration
		}
	}
#endif
