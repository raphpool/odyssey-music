import Foundation
import Track1Core
import XCTest

/// Hosted in the app on purpose: file protection classes only exist on iOS, and the Track1Core package is
/// tested on macOS, where `LocalStore` skips them (`#if os(iOS)`). No `@testable`: it exercises the public
/// API, as the app does.
///
/// It checks what `LocalStore` *asks for*, not what the disk reads back. The simulator writes to the Mac
/// file system, which has no data protection: `attributesOfItem` and `URLResourceValues.fileProtection`
/// both read `nil` there (ios-check on PR #350, 2026-10-13, TRA-427). A recording `FileManager` is the
/// public injection point that sees the request.
final class LocalStorePlatformTests: XCTestCase {
	func testLocalStoreRequestsProtectionUntilFirstUserAuthenticationForFileAndDirectory() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "local-store-platform-\(UUID().uuidString.lowercased())", directoryHint: .isDirectory)
		defer { try? FileManager.default.removeItem(at: directory) }
		let recorder = ProtectionRecorder()
		// The file manager is sent into the actor and never touched again; the test reads the Sendable recorder.
		let store = LocalStore(
			directoryURL: directory, fileManager: AttributeRecordingFileManager(recorder: recorder))

		let result = await store.write(Data("value".utf8), named: "platform.json")

		guard case .success = result else { return XCTFail("The write failed: \(result)") }
		let requested = recorder.protectionByPath
		XCTAssertEqual(
			requested[directory.appending(path: "platform.json").path],
			.completeUntilFirstUserAuthentication, "file")
		XCTAssertEqual(requested[directory.path], .completeUntilFirstUserAuthentication, "directory")
	}
}

/// Thread-safe sink shared by the test and the recording file manager. Swift 6 forbids using the file manager
/// after sending it into the `LocalStore` actor ("sending value of non-Sendable type", ios-check on PR #350,
/// 2026-10-13), so the test keeps this box instead.
private final class ProtectionRecorder: @unchecked Sendable {
	private let lock = NSLock()
	private var recorded: [String: FileProtectionType] = [:]

	var protectionByPath: [String: FileProtectionType] {
		lock.lock()
		defer { lock.unlock() }
		return recorded
	}

	func record(_ protection: FileProtectionType, at path: String) {
		lock.lock()
		recorded[path] = protection
		lock.unlock()
	}
}

/// Records the protection class passed to `setAttributes(_:ofItemAtPath:)`, the only call `LocalStore` uses
/// to set it (both for the file and for its directory), then forwards to the real implementation.
private final class AttributeRecordingFileManager: FileManager, @unchecked Sendable {
	private let recorder: ProtectionRecorder

	init(recorder: ProtectionRecorder) {
		self.recorder = recorder
		super.init()
	}

	override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
		if let protection = attributes[.protectionKey] as? FileProtectionType {
			recorder.record(protection, at: path)
		}
		try super.setAttributes(attributes, ofItemAtPath: path)
	}
}
