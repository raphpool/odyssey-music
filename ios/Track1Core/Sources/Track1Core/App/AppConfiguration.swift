import Foundation

public struct AppConfiguration: Equatable, Sendable {
	public enum Environment: String, CaseIterable, Sendable {
		case development
		case preview
		case production
	}

	public let environment: Environment
	public let apiBaseURL: URL
	public let segmentWriteKey: String?

	public static func load(from bundle: Bundle = .main) -> Result<AppConfiguration, AppConfigurationError> {
		validate(
			values: AppConfigurationValues(
				environment: bundle.object(forInfoDictionaryKey: "Track1Environment") as? String,
				apiBaseURL: bundle.object(forInfoDictionaryKey: "Track1APIBaseURL") as? String,
				segmentWriteKey: bundle.object(forInfoDictionaryKey: "Track1SegmentWriteKey") as? String
			)
		)
	}

	public static func validate(values: AppConfigurationValues) -> Result<
		AppConfiguration, AppConfigurationError
	> {
		guard let environmentValue = normalized(values.environment) else {
			return .failure(.missingEnvironment)
		}
		guard let environment = Environment(rawValue: environmentValue) else {
			return .failure(.unsupportedEnvironment)
		}
		guard let apiBaseURLValue = normalized(values.apiBaseURL) else {
			return .failure(.missingAPIBaseURL)
		}
		guard let apiBaseURL = safeAPIBaseURL(from: apiBaseURLValue) else {
			return .failure(.unsafeAPIBaseURL)
		}

		return .success(
			AppConfiguration(
				environment: environment,
				apiBaseURL: apiBaseURL,
				segmentWriteKey: normalized(values.segmentWriteKey)
			)
		)
	}

	private static func normalized(_ value: String?) -> String? {
		guard let value else { return nil }
		let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
		return trimmed.isEmpty ? nil : trimmed
	}

	private static func safeAPIBaseURL(from value: String) -> URL? {
		guard var components = URLComponents(string: value),
			components.scheme?.lowercased() == "https",
			components.host?.isEmpty == false,
			components.user == nil,
			components.password == nil,
			components.query == nil,
			components.fragment == nil
		else {
			return nil
		}

		let normalizedPath = components.path.replacing(/\/+$/, with: "")
		guard normalizedPath.hasSuffix("/mobile/v1") else { return nil }
		components.path = "\(normalizedPath)/"
		return components.url
	}
}

public struct AppConfigurationValues: Equatable, Sendable {
	public let environment: String?
	public let apiBaseURL: String?
	public let segmentWriteKey: String?

	public init(environment: String?, apiBaseURL: String?, segmentWriteKey: String?) {
		self.environment = environment
		self.apiBaseURL = apiBaseURL
		self.segmentWriteKey = segmentWriteKey
	}
}

public enum AppConfigurationError: Error, Equatable, Sendable {
	case missingEnvironment
	case unsupportedEnvironment
	case missingAPIBaseURL
	case unsafeAPIBaseURL

	public var userMessage: String {
		switch self {
		case .missingEnvironment, .unsupportedEnvironment:
			return "L’environnement de l’application est invalide."
		case .missingAPIBaseURL, .unsafeAPIBaseURL:
			return "L’adresse du service n’est pas sûre."
		}
	}
}
