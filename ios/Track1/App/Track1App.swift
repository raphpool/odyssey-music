import SwiftUI

@main
struct Track1App: App {
	@State private var container = AppContainer()

	var body: some Scene {
		WindowGroup {
			RootView(container: container)
		}
	}
}
