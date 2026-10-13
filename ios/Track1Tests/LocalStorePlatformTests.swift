import Foundation
import Track1Core
import XCTest

/// Hosted in the app on purpose: file protection classes only exist on iOS, and the Track1Core package is
/// tested on macOS, where `LocalStore` skips them. This is the only place the attribute is checked
/// (2026-10, TRA-427). No `@testable`: it exercises the public API, as the app does.
final class LocalStorePlatformTests: XCTestCase {
	func testWrittenFileAndItsDirectoryAreProtectedUntilFirstUserAuthentication() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "local-store-platform-\(UUID().uuidString.lowercased())", directoryHint: .isDirectory)
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = LocalStore(directoryURL: directory)

		let result = await store.write(Data("value".utf8), named: "platform.json")

		guard case .success = result else { return XCTFail("The write failed: \(result)") }
		let file = try FileManager.default.attributesOfItem(
			atPath: directory.appending(path: "platform.json").path)
		let folder = try FileManager.default.attributesOfItem(atPath: directory.path)
		XCTAssertEqual(file[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
		XCTAssertEqual(folder[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
	}
}
