import Foundation

enum ListeningProvider: String, CaseIterable, Sendable {
	case spotify
	case appleMusic = "apple_music"

	/// Exact host a link must have to be handed to the OS. Keep in sync with `SpotifyURL` / `AppleURL` in
	/// `APIModels.swift`, which hardcode the same hosts when decoding `/links`.
	fileprivate var host: String {
		switch self {
		case .spotify: "open.spotify.com"
		case .appleMusic: "music.apple.com"
		}
	}

	fileprivate var displayName: String {
		switch self {
		case .spotify: "Spotify"
		case .appleMusic: "Apple Music"
		}
	}
}

enum ListeningLinkKind: String, Sendable {
	case exact
	case search
}

struct ListeningAction: Equatable, Sendable {
	let provider: ListeningProvider
	let url: URL
	let linkKind: ListeningLinkKind
	let title: String
}

enum ListeningOutcome: Equatable, Sendable {
	case opened
	case unsafeURL
	case openFailed
}

enum ListeningActions {
	/// Same unreserved set as JavaScript's `encodeURIComponent`, so iOS and the React Native client build the
	/// same search URLs. `.urlQueryAllowed` would leave `&`, `+`, `=` and `/` unescaped and corrupt the query.
	private static let unreservedCharacters = CharacterSet(
		charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

	/// Close to JavaScript's `trim()`, which also strips the byte-order mark that `.whitespacesAndNewlines` keeps.
	private static let trimmedCharacters = CharacterSet.whitespacesAndNewlines.union(
		CharacterSet(charactersIn: "\u{FEFF}"))

	static func actions(for type: NodeType, name: String, links: LinksResponse?) -> [ListeningAction] {
		switch type {
		case .genre, .label:
			return []
		case .artist, .project, .track:
			return ListeningProvider.allCases.compactMap { provider in
				if let exact = exactURL(for: provider, links: links) {
					return ListeningAction(
						provider: provider, url: exact, linkKind: .exact, title: "Écouter sur \(provider.displayName)")
				}
				guard let search = searchURL(for: provider, name: name) else { return nil }
				return ListeningAction(
					provider: provider, url: search, linkKind: .search, title: "Rechercher sur \(provider.displayName)")
			}
		}
	}

	static func searchURL(for provider: ListeningProvider, name: String) -> URL? {
		let trimmed = name.trimmingCharacters(in: trimmedCharacters)
		guard !trimmed.isEmpty,
			let query = trimmed.addingPercentEncoding(withAllowedCharacters: unreservedCharacters)
		else { return nil }
		switch provider {
		case .spotify: return URL(string: "https://open.spotify.com/search/\(query)")
		case .appleMusic: return URL(string: "https://music.apple.com/search?term=\(query)")
		}
	}

	static func isSafe(_ url: URL, for provider: ListeningProvider) -> Bool {
		URLValidation.providerURL(from: url.absoluteString, host: provider.host) != nil
	}

	@MainActor
	static func open(
		_ action: ListeningAction,
		node: NodeIdentity,
		context: NavigationContext,
		openURL: @MainActor (URL) async -> Bool,
		recordEvent: NodeEventRecorder?
	) async -> ListeningOutcome {
		// Re-checked here, not only at decoding: an action can be built from any URL, and the OS is the
		// boundary where an untrusted host would actually be reached.
		guard isSafe(action.url, for: action.provider) else {
			recordEvent?(event(.externalListeningFailed, action, node, context, errorCode: "unsafe_url"))
			return .unsafeURL
		}
		guard await openURL(action.url) else {
			recordEvent?(event(.externalListeningFailed, action, node, context, errorCode: "open_failed"))
			return .openFailed
		}
		recordEvent?(event(.externalListeningOpened, action, node, context, errorCode: nil))
		return .opened
	}

	private static func exactURL(for provider: ListeningProvider, links: LinksResponse?) -> URL? {
		switch provider {
		case .spotify: links?.spotify
		case .appleMusic: links?.apple
		}
	}

	private static func event(
		_ name: AnalyticsEventName,
		_ action: ListeningAction,
		_ node: NodeIdentity,
		_ context: NavigationContext,
		errorCode: String?
	) -> AnalyticsEvent {
		var properties: [String: AnalyticsValue] = [
			"node_id": .string(node.rawValue),
			"node_type": .string(node.type.rawValue),
			"provider": .string(action.provider.rawValue),
			"link_kind": .string(action.linkKind.rawValue),
		]
		for (key, value) in context.attributionProperties { properties[key] = value }
		if let errorCode { properties["error_code"] = .string(errorCode) }
		return AnalyticsEvent(name: name, properties: properties, source: context.source)
	}
}
