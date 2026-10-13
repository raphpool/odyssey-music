import XCTest

@testable import Track1Core

final class AppConfigurationTests: XCTestCase {
	func testValidConfigurationNormalizesTheMobileAPIPath() throws {
		let result = AppConfiguration.validate(
			values: AppConfigurationValues(
				environment: " preview ",
				apiBaseURL: "https://preview.track1.example/mobile/v1///",
				segmentWriteKey: " public-key "
			)
		)

		let configuration = try XCTUnwrap(result.successValue)
		XCTAssertEqual(configuration.environment, .preview)
		XCTAssertEqual(configuration.apiBaseURL.absoluteString, "https://preview.track1.example/mobile/v1/")
		XCTAssertEqual(configuration.segmentWriteKey, "public-key")
	}

	func testMissingSegmentWriteKeyDoesNotInvalidateTheApp() throws {
		let result = AppConfiguration.validate(
			values: AppConfigurationValues(
				environment: "development",
				apiBaseURL: "https://development.track1.example/mobile/v1",
				segmentWriteKey: nil
			)
		)

		XCTAssertNil(try XCTUnwrap(result.successValue).segmentWriteKey)
	}

	func testInvalidValuesFailClosed() {
		let values = [
			AppConfigurationValues(
				environment: nil, apiBaseURL: "https://api.track1.example/mobile/v1", segmentWriteKey: nil),
			AppConfigurationValues(
				environment: "staging", apiBaseURL: "https://api.track1.example/mobile/v1", segmentWriteKey: nil),
			AppConfigurationValues(environment: "production", apiBaseURL: nil, segmentWriteKey: nil),
			AppConfigurationValues(
				environment: "production", apiBaseURL: "http://api.track1.example/mobile/v1", segmentWriteKey: nil),
			AppConfigurationValues(environment: "production", apiBaseURL: "https:///mobile/v1", segmentWriteKey: nil),
			AppConfigurationValues(
				environment: "production", apiBaseURL: "https://user:pass@api.track1.example/mobile/v1",
				segmentWriteKey: nil),
			AppConfigurationValues(
				environment: "production", apiBaseURL: "https://api.track1.example/mobile/v1?debug=true",
				segmentWriteKey: nil),
			AppConfigurationValues(
				environment: "production", apiBaseURL: "https://api.track1.example/v1", segmentWriteKey: nil),
		]

		for value in values {
			XCTAssertNil(AppConfiguration.validate(values: value).successValue)
		}
	}
}

extension Result where Success == AppConfiguration, Failure == AppConfigurationError {
	fileprivate var successValue: AppConfiguration? {
		guard case .success(let value) = self else { return nil }
		return value
	}
}
