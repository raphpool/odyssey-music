#if targetEnvironment(simulator)
	import XCTest

	@testable import Track1

	@MainActor
	final class NodeUITestFixtureRequestAuditTests: XCTestCase {
		func testUnexpectedRequestCannotBeClearedByLaterExpectedRequest() {
			let audit = NodeUITestFixtureRequestAudit.shared
			audit.reset()
			audit.recordRequest(unexpected: true)
			audit.recordRequest(unexpected: false)

			XCTAssertEqual(audit.unexpectedRequestCount, 1)
		}
	}
#endif
