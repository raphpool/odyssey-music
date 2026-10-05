import XCTest
@testable import Track1

@MainActor
final class AppConfigurationTests: XCTestCase {
	func testApplicationBundleDeclaresAModernLaunchScreen() {
		XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "UILaunchScreen"))
	}

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
			AppConfigurationValues(environment: nil, apiBaseURL: "https://api.track1.example/mobile/v1", segmentWriteKey: nil),
			AppConfigurationValues(environment: "staging", apiBaseURL: "https://api.track1.example/mobile/v1", segmentWriteKey: nil),
			AppConfigurationValues(environment: "production", apiBaseURL: nil, segmentWriteKey: nil),
			AppConfigurationValues(environment: "production", apiBaseURL: "http://api.track1.example/mobile/v1", segmentWriteKey: nil),
			AppConfigurationValues(environment: "production", apiBaseURL: "https:///mobile/v1", segmentWriteKey: nil),
			AppConfigurationValues(environment: "production", apiBaseURL: "https://user:pass@api.track1.example/mobile/v1", segmentWriteKey: nil),
			AppConfigurationValues(environment: "production", apiBaseURL: "https://api.track1.example/mobile/v1?debug=true", segmentWriteKey: nil),
			AppConfigurationValues(environment: "production", apiBaseURL: "https://api.track1.example/v1", segmentWriteKey: nil),
		]

		for value in values {
			XCTAssertNil(AppConfiguration.validate(values: value).successValue)
		}
	}

	func testRouterKeepsIndependentTabStacks() {
		let router = AppRouter()
		router.push(.entryStatus(.today), in: .today)
		router.selectedTab = .search
		router.push(.entryStatus(.search))
		router.selectedTab = .today

		XCTAssertEqual(router.path(for: .today), [.entryStatus(.today)])
		XCTAssertEqual(router.path(for: .search), [.entryStatus(.search)])
		router.pop()
		XCTAssertTrue(router.path(for: .today).isEmpty)
		XCTAssertEqual(router.path(for: .search), [.entryStatus(.search)])
	}
}

private extension Result where Success == AppConfiguration, Failure == AppConfigurationError {
	var successValue: AppConfiguration? {
		guard case let .success(value) = self else { return nil }
		return value
	}
}
