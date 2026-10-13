import XCTest

@testable import Track1Core

final class URLValidationTests: XCTestCase {
	func testPublicHTTPSURLRefusesPlainHTTP() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "http://example.com/"))
	}

	func testPublicHTTPSURLRefusesLoopbackIPv4() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://127.0.0.1/"))
	}

	func testPublicHTTPSURLRefusesIPv4MappedLoopback() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://[::ffff:7f00:1]/"))
	}

	func testProviderURLAcceptsItsHostAndRefusesAForeignOne() {
		let host = "open.spotify.com"
		XCTAssertNotNil(URLValidation.providerURL(from: "https://open.spotify.com/track/1", host: host))
		XCTAssertNil(URLValidation.providerURL(from: "https://evil.example/track/1", host: host))
	}
}
