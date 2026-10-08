import Foundation

enum LocalStoreError: Error, Equatable, Sendable {
	case unavailable
}

actor LocalStore {
	private let directoryURL: URL?
	private let fileManager: FileManager

	init(directoryURL: URL? = nil, fileManager: FileManager = .default) {
		self.directoryURL = directoryURL
		self.fileManager = fileManager
	}

	func read(named name: String) -> Result<Data?, LocalStoreError> {
		do {
			let url = try fileURL(named: name)
			guard fileManager.fileExists(atPath: url.path) else { return .success(nil) }
			return .success(try Data(contentsOf: url))
		} catch {
			return .failure(.unavailable)
		}
	}

	func write(_ data: Data, named name: String) -> Result<Void, LocalStoreError> {
		do {
			let url = try fileURL(named: name)
			try data.write(to: url, options: .atomic)
			try fileManager.setAttributes(
				[.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
				ofItemAtPath: url.path
			)
			var values = URLResourceValues()
			values.isExcludedFromBackup = true
			var protectedURL = url
			try protectedURL.setResourceValues(values)
			return .success(())
		} catch {
			return .failure(.unavailable)
		}
	}

	func remove(named name: String) -> Result<Void, LocalStoreError> {
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
		try fileManager.setAttributes(
			[.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
			ofItemAtPath: directory.path
		)
		var values = URLResourceValues()
		values.isExcludedFromBackup = true
		var protectedDirectory = directory
		try protectedDirectory.setResourceValues(values)
		return directory.appending(path: name, directoryHint: .notDirectory)
	}
}
