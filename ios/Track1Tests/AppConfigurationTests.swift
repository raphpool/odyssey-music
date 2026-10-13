import XCTest

@testable import Track1

@MainActor
final class AppConfigurationTests: XCTestCase {
	func testApplicationBundleDeclaresAModernLaunchScreen() {
		XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "UILaunchScreen"))
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
