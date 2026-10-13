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

	func testPublicHTTPSURLRefusesDecimalIntegerIPv4() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://2130706433/"))
	}

	func testPublicHTTPSURLRefusesHexadecimalIPv4() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://0x7f000001/"))
	}

	func testPublicHTTPSURLRefusesShortenedIPv4() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://127.1/"))
	}

	func testPublicHTTPSURLRefusesOctalIPv4() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://0177.0.0.1/"))
	}

	func testPublicHTTPSURLRefusesUniqueLocalIPv6Literal() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://[fd00::1]/"))
	}

	func testPublicHTTPSURLRefusesLinkLocalIPv6Literal() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://[fe80::1]/"))
	}

	func testPublicHTTPSURLRefusesNonCanonicalPrivateRanges() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://0xa000001/"))  // 10.0.0.1
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://3232235777/"))  // 192.168.1.1
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://2852039166/"))  // 169.254.169.254
	}

	func testPublicHTTPSURLRefusesUppercaseHexadecimalIPv4() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://0X7F000001/"))
	}

	func testPublicHTTPSURLRefusesTrailingDotLoopback() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://127.0.0.1./"))
	}

	func testPublicHTTPSURLRefusesFullWidthDigitsLoopback() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://１２７.０.０.１/"))
	}

	func testPublicHTTPSURLRefusesNumericHostThatIsNotAValidIPv4() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://08.8.8.8/"))
	}

	func testPublicHTTPSURLRefusesMappedIPv6WithDottedIPv4() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://[::ffff:127.0.0.1]/"))
	}

	func testPublicHTTPSURLAcceptsDomainsStartingWithIPv6Prefixes() {
		XCTAssertNotNil(URLValidation.publicHTTPSURL(from: "https://fdroid.org/"))
		XCTAssertNotNil(URLValidation.publicHTTPSURL(from: "https://fcbayern.com/"))
		XCTAssertNotNil(URLValidation.publicHTTPSURL(from: "https://feb.example/"))
	}

	func testPublicHTTPSURLAcceptsPublicIPv4() {
		XCTAssertNotNil(URLValidation.publicHTTPSURL(from: "https://8.8.8.8/"))
	}

	func testPublicHTTPSURLRefusesExplicitPort() {
		XCTAssertNil(URLValidation.publicHTTPSURL(from: "https://example.com:8443/"))
	}

	func testProviderURLAcceptsItsHostAndRefusesAForeignOne() {
		let host = "open.spotify.com"
		XCTAssertNotNil(URLValidation.providerURL(from: "https://open.spotify.com/track/1", host: host))
		XCTAssertNil(URLValidation.providerURL(from: "https://evil.example/track/1", host: host))
	}
}
