import Foundation

@MainActor
final class AppContainer {
	let configurationResult: Result<AppConfiguration, AppConfigurationError>
	let router: AppRouter
	let apiClient: APIClient?

	init(configurationResult: Result<AppConfiguration, AppConfigurationError> = AppConfiguration.load()) {
		self.configurationResult = configurationResult
		router = AppRouter()
		switch configurationResult {
		case let .success(configuration):
			apiClient = APIClient(configuration: configuration)
		case .failure:
			apiClient = nil
		}
	}
}
