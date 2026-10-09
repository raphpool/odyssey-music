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
	let nodeImageSession: URLSession
	#if targetEnvironment(simulator)
		private var uiTestStartupNode: NodeIdentity?
	#endif

	init(configurationResult: Result<AppConfiguration, AppConfigurationError> = AppConfiguration.load()) {
		self.configurationResult = configurationResult
		router = AppRouter()
		let apiSession: URLSession
		#if targetEnvironment(simulator)
			let processInfo = ProcessInfo.processInfo
			let uiTestFixture = NodeUITestFixtureTransport.makeSession(arguments: processInfo.arguments)
			apiSession = uiTestFixture?.session ?? .shared
			nodeImageSession = apiSession
			uiTestStartupNode = uiTestFixture?.startupNode
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
			apiSession = .shared
			nodeImageSession = .shared
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
			apiClient = APIClient(configuration: configuration, session: apiSession)
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

	#if targetEnvironment(simulator)
		func consumeUITestStartupNode() -> NodeIdentity? {
			defer { uiTestStartupNode = nil }
			return uiTestStartupNode
		}
	#endif
}
