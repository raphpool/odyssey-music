import SwiftUI

@main
struct Track1App: App {
	@State private var container = AppContainer()

	var body: some Scene {
		WindowGroup {
			RootView(container: container)
				.tint(Track1Tokens.colorTextAction)
		}
	}
}
// TRA-785 probe: makes ios-check compile main; removed before merge.
