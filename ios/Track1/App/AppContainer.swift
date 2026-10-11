import Foundation
import Observation

@MainActor
@Observable
final class AppContainer {
	let configurationResult: Result<AppConfiguration, AppConfigurationError>
	let router: AppRouter
	let apiClient: APIClient?
	let readers: ContentReaders?
	let analytics: AnalyticsClient?
	let profileStore: ProfileStore
	let onboardingCatalog: (@Sendable () async -> APIResult<Catalog>)?

	init(configurationResult: Result<AppConfiguration, AppConfigurationError> = AppConfiguration.load()) {
		self.configurationResult = configurationResult
		router = AppRouter()
		#if targetEnvironment(simulator)
			let processInfo = ProcessInfo.processInfo
			let localStore = LocalStore(
				failNextWriteNamed: processInfo.arguments.contains("-track1-fail-next-profile-write")
					? "profile.v1.json" : nil
			)
			let resetProfile = processInfo.arguments.contains("-track1-reset-profile")
			let seedCorruptProfile = processInfo.arguments.contains("-track1-seed-corrupt-profile")
			if let fixture = processInfo.environment["TRACK1_PROFILE_CATALOG_JSON"] {
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
		#else
			let localStore = LocalStore()
			let resetProfile = false
			let seedCorruptProfile = false
			onboardingCatalog = nil
		#endif
		profileStore = ProfileStore(
			localStore: localStore,
			resetBeforeUse: resetProfile,
			seedCorruptProfileBeforeUse: seedCorruptProfile
		)
		switch configurationResult {
		case .success(let configuration):
			let client = APIClient(configuration: configuration)
			apiClient = client
			#if targetEnvironment(simulator)
				readers = UITestFixtureReaders.make(environment: ProcessInfo.processInfo.environment) ?? .live(client)
			#else
				readers = .live(client)
			#endif
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
			readers = nil
			analytics = nil
		}
		Task { await analytics?.initialize() }
	}
}
