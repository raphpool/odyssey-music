import Foundation

@MainActor
final class AppContainer {
	let configurationResult: Result<AppConfiguration, AppConfigurationError>
	let router: AppRouter

	init(configurationResult: Result<AppConfiguration, AppConfigurationError> = AppConfiguration.load()) {
		self.configurationResult = configurationResult
		router = AppRouter()
	}
}
