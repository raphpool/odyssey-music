import Foundation
import Observation

@MainActor
@Observable
final class AppContainer {
	let configurationResult: Result<AppConfiguration, AppConfigurationError>
	let router: AppRouter
	let apiClient: APIClient?
	let analytics: AnalyticsClient?
	let profileStore: ProfileStore
	let onboardingCatalog: (@Sendable () async -> APIResult<Catalog>)?

	init(configurationResult: Result<AppConfiguration, AppConfigurationError> = AppConfiguration.load()) {
		self.configurationResult = configurationResult
		router = AppRouter()
		profileStore = ProfileStore(
			resetBeforeUse: ProcessInfo.processInfo.arguments.contains("-track1-reset-profile"),
			seedCorruptProfileBeforeUse: ProcessInfo.processInfo.arguments.contains("-track1-seed-corrupt-profile")
		)
		if let fixture = ProcessInfo.processInfo.environment["TRACK1_PROFILE_CATALOG_JSON"] {
			let result: APIResult<Catalog>
			do {
				result = .success(try JSONDecoder().decode(Catalog.self, from: Data(fixture.utf8)), etag: nil)
			} catch {
				result = .failure(.invalidResponse)
			}
			onboardingCatalog = { result }
		} else {
			onboardingCatalog = nil
		}
		switch configurationResult {
		case .success(let configuration):
			apiClient = APIClient(configuration: configuration)
			analytics = AnalyticsClient(
				configuration: AnalyticsConfiguration(
					writeKey: configuration.segmentWriteKey,
					environment: configuration.environment,
					appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
					buildNumber: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
				)
			)
		case .failure:
			apiClient = nil
			analytics = nil
		}
		Task { await analytics?.initialize() }
	}
}
