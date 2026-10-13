import XCTest

@testable import Track1

@MainActor
final class AppConfigurationTests: XCTestCase {
	func testApplicationBundleDeclaresAModernLaunchScreen() {
		XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "UILaunchScreen"))
	}

	// TRA-437: `AppIcon.icon` is compiled by actool. If it leaves the Resources phase or the app icon name
	// setting is lost, the build still succeeds and the app ships without an icon, so the compiled
	// Info.plist is the only honest witness. The setting lives in Base.xcconfig, shared by every scheme,
	// which is why this test needs no place in the Track1Preview list of ios/scripts/check.sh.
	func testCompiledInfoPlistDeclaresAppIconAsPrimaryIcon() throws {
		let icons = try XCTUnwrap(Bundle.main.infoDictionary?["CFBundleIcons"] as? [String: Any])
		let primary = try XCTUnwrap(icons["CFBundlePrimaryIcon"] as? [String: Any])

		XCTAssertEqual(primary["CFBundleIconName"] as? String, "AppIcon")
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
