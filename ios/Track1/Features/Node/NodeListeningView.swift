import SwiftUI
import Track1Core

/// "Écouter" section: one button per provider, opened by the OS and never in an in-app web view.
struct NodeListeningView: View {
	let state: ListeningState
	let isOpening: Bool
	let failure: ListeningProvider?
	let open: (ListeningAction) -> Void

	var body: some View {
		switch state {
		case .hidden:
			EmptyView()
		case .loading:
			ProgressView()
				.frame(maxWidth: .infinity)
				.accessibilityIdentifier("listen-loading")
		case .ready(let actions):
			VStack(alignment: .leading, spacing: 12) {
				Text("Écouter")
					.font(.title2.bold())
					.accessibilityAddTraits(.isHeader)
				ForEach(actions, id: \.provider) { action in
					Button {
						open(action)
					} label: {
						Text(verbatim: action.title).frame(maxWidth: .infinity)
					}
					.buttonStyle(Track1PrimaryButtonStyle())
					.disabled(isOpening)
					.accessibilityIdentifier("listen-\(action.provider.rawValue)")
				}
				if let failure {
					Text(verbatim: "Impossible d’ouvrir \(Self.serviceName(failure)).")
						.font(.footnote)
						.foregroundStyle(.red)
						.accessibilityIdentifier("listen-error")
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
	}

	static func serviceName(_ provider: ListeningProvider) -> String {
		switch provider {
		case .spotify: "Spotify"
		case .appleMusic: "Apple Music"
		}
	}
}

extension OpenURLAction {
	/// `false` when the OS declines the URL (no handler, or the user cancelled), as the completion reports it.
	@MainActor
	func open(_ url: URL) async -> Bool {
		await withCheckedContinuation { continuation in
			callAsFunction(url) { continuation.resume(returning: $0) }
		}
	}
}
