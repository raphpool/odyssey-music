import Foundation

enum URLValidation {
	static func publicHTTPSURL(from value: String) -> URL? {
		guard let components = URLComponents(string: value),
			components.scheme?.lowercased() == "https",
			let hostname = components.host?.lowercased(),
			!hostname.isEmpty,
			components.user == nil,
			components.password == nil,
			components.port == nil,
			!isPrivateHost(hostname)
		else {
			return nil
		}
		return components.url
	}

	static func providerURL(from value: String, host: String) -> URL? {
		guard let url = publicHTTPSURL(from: value), url.host?.lowercased() == host else { return nil }
		return url
	}

	private static func isPrivateHost(_ hostname: String) -> Bool {
		let host = hostname.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
			.trimmingCharacters(in: CharacterSet(charactersIn: "."))
		if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "::" { return true }
		if let ipv4 = parseIPv4(host) { return isPrivate(ipv4) }
		if let mappedIPv4 = mappedIPv4(host) { return isPrivate(mappedIPv4) }
		if host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe8") || host.hasPrefix("fe9")
			|| host.hasPrefix("fea") || host.hasPrefix("feb")
		{
			return true
		}
		return false
	}

	private static func parseIPv4(_ value: String) -> [Int]? {
		let pieces = value.split(separator: ".", omittingEmptySubsequences: false)
		guard pieces.count == 4 else { return nil }
		let values = pieces.compactMap { Int($0) }
		guard values.count == 4, values.allSatisfy({ (0...255).contains($0) }) else { return nil }
		return values
	}

	private static func mappedIPv4(_ value: String) -> [Int]? {
		guard value.hasPrefix("::ffff:") else { return nil }
		let mapped = String(value.dropFirst("::ffff:".count))
		if let dotted = parseIPv4(mapped) { return dotted }
		let words = mapped.split(separator: ":", omittingEmptySubsequences: false)
		guard words.count == 2,
			words.allSatisfy({ $0.range(of: "^[0-9a-fA-F]{1,4}$", options: .regularExpression) != nil }),
			let first = Int(words[0], radix: 16),
			let second = Int(words[1], radix: 16)
		else { return nil }
		return [first >> 8, first & 0xff, second >> 8, second & 0xff]
	}

	private static func isPrivate(_ octets: [Int]) -> Bool {
		guard octets.count == 4 else { return true }
		return octets[0] == 0 || octets[0] == 10 || octets[0] == 127
			|| (octets[0] == 100 && (64...127).contains(octets[1]))
			|| (octets[0] == 169 && octets[1] == 254)
			|| (octets[0] == 172 && (16...31).contains(octets[1]))
			|| (octets[0] == 192 && octets[1] == 168)
			|| (octets[0] == 198 && (18...19).contains(octets[1]))
	}
}
