import Foundation

#if canImport(Darwin)
	import Darwin
#elseif canImport(Glibc)
	import Glibc
#endif

public enum URLValidation {
	public static func publicHTTPSURL(from value: String) -> URL? {
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

	public static func providerURL(from value: String, host: String) -> URL? {
		guard let url = publicHTTPSURL(from: value), url.host?.lowercased() == host else { return nil }
		return url
	}

	private static func isPrivateHost(_ hostname: String) -> Bool {
		let host = hostname.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
			.trimmingCharacters(in: CharacterSet(charactersIn: "."))
		if host == "localhost" || host.hasSuffix(".localhost") { return true }
		// 2026-10-13: the IPv6 prefix checks used to run on every host, so public domains such as
		// fdroid.org or fcbayern.com were refused. They now only apply to IPv6 literals (which contain ":").
		if host.contains(":") { return isPrivateIPv6Literal(host) }
		// 2026-10-13: IPv4 was only recognised in dotted-quad form, so https://2130706433/ (and the hex,
		// octal and shortened spellings of 127.0.0.1) was accepted as a public host. `inet_aton` is the
		// parser the system resolver applies, so we classify the address the connection would really reach.
		// A host whose last label is numeric is an IPv4 spelling, never a DNS name. If it does not parse
		// (for example "08.8.8.8", an invalid octal), refuse it rather than let another stack reinterpret it.
		if endsInNumber(host) { return parseIPv4(host).map(isPrivate) ?? true }
		return false
	}

	private static func endsInNumber(_ host: String) -> Bool {
		let labels = host.split(separator: ".", omittingEmptySubsequences: false)
		guard let lastLabel = labels.last else { return false }
		if !lastLabel.isEmpty && lastLabel.allSatisfy({ $0.isASCII && $0.isNumber }) { return true }
		return lastLabel.hasPrefix("0x") && lastLabel.dropFirst(2).allSatisfy { $0.isASCII && $0.isHexDigit }
	}

	private static func isPrivateIPv6Literal(_ host: String) -> Bool {
		if host == "::1" || host == "::" { return true }
		if let mappedIPv4 = mappedIPv4(host) { return isPrivate(mappedIPv4) }
		return host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe8") || host.hasPrefix("fe9")
			|| host.hasPrefix("fea") || host.hasPrefix("feb")
	}

	/// Parses every IPv4 spelling `inet_aton` accepts: dotted quad, shortened (`127.1`), decimal integer,
	/// hexadecimal (`0x7f000001`) and octal (`0177.0.0.1`) parts.
	private static func parseIPv4(_ value: String) -> [Int]? {
		// `inet_aton` ignores anything after the first whitespace, so restrict the input to the characters
		// an IPv4 spelling can contain before handing it over.
		guard !value.isEmpty, value.allSatisfy({ $0.isASCII && ($0.isHexDigit || $0 == "." || $0 == "x") })
		else { return nil }
		var address = in_addr()
		guard inet_aton(value, &address) != 0 else { return nil }
		let packed = UInt32(bigEndian: address.s_addr)
		return [Int(packed >> 24), Int((packed >> 16) & 0xff), Int((packed >> 8) & 0xff), Int(packed & 0xff)]
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
