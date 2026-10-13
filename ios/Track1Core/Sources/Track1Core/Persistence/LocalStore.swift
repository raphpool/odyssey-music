import Foundation

public enum LocalStoreError: Error, Equatable, Sendable {
	case unavailable
}

public enum LocalStoreOperation: Equatable, Sendable {
	case read
	case write
	case remove
}

public actor LocalStore {
	private let directoryURL: URL?
	private let fileManager: FileManager
	private var failingWriteName: String?
	private let afterOperation: (@Sendable (LocalStoreOperation, String) async -> Void)?

	/// `afterOperation` is a test seam, `nil` in production. It runs once an operation has been applied
	/// and before its result is returned, so a test can hold a response in flight while another caller
	/// (e.g. `ProfileStore.clear()`) runs. Added 2026-10-12: `ProfileStoreTests.swift:228` failed in CI
	/// run 38239884450 because a `Task.yield()` could not force the "commit in flight, then clear" order.
	/// It is awaited after the operation, never before: the actor serves requests in order, so holding
	/// the request itself would let a later `remove` overtake an earlier `write`, which cannot happen
	/// in production. The actor is reentrant at that await, so while a response is held, later
	/// operations are applied and return first; only the held caller's result arrives late.
	public init(
		directoryURL: URL? = nil,
		fileManager: FileManager = .default,
		failNextWriteNamed failingWriteName: String? = nil,
		afterOperation: (@Sendable (LocalStoreOperation, String) async -> Void)? = nil
	) {
		self.directoryURL = directoryURL
		self.fileManager = fileManager
		self.failingWriteName = failingWriteName
		self.afterOperation = afterOperation
	}

	public func read(named name: String) async -> Result<Data?, LocalStoreError> {
		let result = performRead(named: name)
		await afterOperation?(.read, name)
		return result
	}

	public func write(_ data: Data, named name: String) async -> Result<Void, LocalStoreError> {
		let result = performWrite(data, named: name)
		await afterOperation?(.write, name)
		return result
	}

	public func remove(named name: String) async -> Result<Void, LocalStoreError> {
		let result = performRemove(named: name)
		await afterOperation?(.remove, name)
		return result
	}

	private func performRead(named name: String) -> Result<Data?, LocalStoreError> {
		do {
			let url = try fileURL(named: name)
			guard fileManager.fileExists(atPath: url.path) else { return .success(nil) }
			return .success(try Data(contentsOf: url))
		} catch {
			return .failure(.unavailable)
		}
	}

	private func performWrite(_ data: Data, named name: String) -> Result<Void, LocalStoreError> {
		if failingWriteName == name {
			failingWriteName = nil
			return .failure(.unavailable)
		}
		do {
			let url = try fileURL(named: name)
			try data.write(to: url, options: .atomic)
			// File protection classes are an iOS concept, so the attribute is iOS-only; the package is also
			// tested on macOS. LocalStorePlatformTests checks it on the simulator. Added 2026-10 (TRA-427).
			#if os(iOS)
				try fileManager.setAttributes(
					[.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
					ofItemAtPath: url.path
				)
			#endif
			var values = URLResourceValues()
			values.isExcludedFromBackup = true
			var protectedURL = url
			try protectedURL.setResourceValues(values)
			return .success(())
		} catch {
			return .failure(.unavailable)
		}
	}

	private func performRemove(named name: String) -> Result<Void, LocalStoreError> {
		do {
			let url = try fileURL(named: name)
			guard fileManager.fileExists(atPath: url.path) else { return .success(()) }
			try fileManager.removeItem(at: url)
			return .success(())
		} catch {
			return .failure(.unavailable)
		}
	}

	private func fileURL(named name: String) throws -> URL {
		guard name.range(of: "^[a-z0-9.-]+$", options: .regularExpression) != nil,
			let directory = directoryURL
				?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
		else { throw LocalStoreError.unavailable }
		try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
		// iOS-only for the same reason as the file attribute in `performWrite` (2026-10).
		#if os(iOS)
			try fileManager.setAttributes(
				[.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
				ofItemAtPath: directory.path
			)
		#endif
		var values = URLResourceValues()
		values.isExcludedFromBackup = true
		var protectedDirectory = directory
		try protectedDirectory.setResourceValues(values)
		return directory.appending(path: name, directoryHint: .notDirectory)
	}
}
