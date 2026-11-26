import Foundation

/// The source line the reader draws under the last sentence (plan player-source-link, D1).
/// The URL comes from the network: it is checked here, at the point of use, and the domain is only ever drawn
/// with `Text(verbatim:)` by the view.
public struct PlayerSource: Equatable, Sendable {
	/// "Source\u{00A0}:" — French chrome like the rest of the app; U+00A0 keeps the colon on the line.
	public static let label = "Source\u{00A0}:"

	/// Host of `url`, lowercased, without one leading "www." when a dot remains after it
	/// ("www.pitchfork.com" → "pitchfork.com", "en.wikipedia.org" and "www.com" unchanged). Punycode as is.
	public let domain: String
	/// The citation URL as `URLValidation.publicHTTPSURL` returned it.
	public let url: URL

	/// "Source\u{00A0}: pitchfork.com": the drawn text and the accessibility label.
	public var line: String { Self.label + " " + domain }

	/// `first(urls: citations.map(\.url))`.
	public static func first(in citations: [Citation]) -> PlayerSource? {
		first(urls: citations.map(\.url))
	}

	/// The first URL that is a public HTTPS one with a host (`URLValidation.publicHTTPSURL`); nil when none.
	/// The check stays at the point of use, as `NodeArticleView.sourceRows(entries:)` does: the source never
	/// depends on how a `Citation` was built.
	public static func first(urls: [URL]) -> PlayerSource? {
		for candidate in urls {
			guard let url = URLValidation.publicHTTPSURL(from: candidate.absoluteString),
				let domain = domain(of: url)
			else { continue }
			return PlayerSource(domain: domain, url: url)
		}
		return nil
	}

	/// nil for a URL without a host, or whose host is empty once lowercased and stripped.
	/// `URLValidation.publicHTTPSURL` compares the host in lowercase but gives the URL back as written, so the
	/// case is lowered here.
	public static func domain(of url: URL) -> String? {
		guard let host = url.host?.lowercased() else { return nil }
		let prefix = "www."
		let rest = host.dropFirst(prefix.count)
		let stripped = host.hasPrefix(prefix) && rest.contains(".") ? String(rest) : host
		return stripped.isEmpty ? nil : stripped
	}
}
