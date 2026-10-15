import type { NodeCache } from "../cache.js";
import { isNotFoundError } from "../errors.js";
import { type GenreRedirects, resolveReadSlug } from "../genre-registry.js";
import { toVizNode, type VizNode } from "../graph.js";
import type { Citation, Slug } from "../types.js";

const MOBILE_SLUG_PATTERN =
	/^(artist|project|track|genre|label):[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export class MobileNodeInputError extends Error {
	constructor() {
		super("invalid node slug");
		this.name = "MobileNodeInputError";
	}
}

export interface MobileNodeResult {
	node: VizNode;
	source: "cache";
	redirected_from?: Slug;
}

export interface MobileNodeReader {
	read(slug: string): Promise<MobileNodeResult | null>;
}

export interface MobileNodeDependencies {
	cache: NodeCache;
	redirects: GenreRedirects;
}

// Mobile reads intentionally bypass node-service: a stale cache entry remains readable here,
// because opening a screen must never trigger a paid materialization run (TRA-292).
export function createMobileNodeReader(dependencies: MobileNodeDependencies): MobileNodeReader {
	return {
		async read(rawSlug: string): Promise<MobileNodeResult | null> {
			if (!MOBILE_SLUG_PATTERN.test(rawSlug)) throw new MobileNodeInputError();
			const slug = rawSlug as Slug;
			const lookupSlug = await resolveReadSlug(slug, dependencies.redirects, dependencies.cache);
			const node = await dependencies.cache.get(lookupSlug).catch((error: unknown) => {
				if (isNotFoundError(error)) return null;
				throw error;
			});
			if (!node) return null;
			const vizNode = toVizNode(node);
			return {
				node: sanitizeNodeImage({ ...vizNode, citations: sanitizeCitations(vizNode.citations) }),
				source: "cache",
				...(lookupSlug === slug ? {} : { redirected_from: slug }),
			};
		},
	};
}

// Citation URLs are cache data, including older entries that predate the HTTPS-only policy.
// Keep the node readable while dropping only links that a mobile client must never open.
function sanitizeCitations(citations: Citation[]): Citation[] {
	return citations.flatMap((citation) => {
		const url = safePublicHttpsUrl(citation.url);
		return url ? [{ ...citation, url }] : [];
	});
}

// image_url falls back to photo_url / cover_url, which accept http:// and ports; iOS decodes
// image_url as a validated public URL and fails the WHOLE node response on a refusal (review of
// TRA-455: artist:giorgio-moroder). A refused image is dropped with its image_source, not the node.
function sanitizeNodeImage(node: VizNode): VizNode {
	if (node.image_url === undefined) return node;
	const safe = safePublicHttpsUrl(node.image_url);
	if (safe) return { ...node, image_url: safe };
	const { image_url: _url, image_source: _source, ...rest } = node;
	return rest;
}

export function safePublicHttpsUrl(raw: string | null, expectedHost?: string): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.port ||
			(expectedHost !== undefined && url.hostname !== expectedHost) ||
			isPrivateHost(url.hostname)
		) {
			return null;
		}
		return url.toString();
	} catch {
		return null;
	}
}

function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::") return true;
	if (
		host.startsWith("fc") ||
		host.startsWith("fd") ||
		host.startsWith("fe8") ||
		host.startsWith("fe9") ||
		host.startsWith("fea") ||
		host.startsWith("feb")
	) {
		return true;
	}
	const ipv4 = parseIpv4(host) ?? parseMappedIpv4(host);
	if (!ipv4) return false;
	return (
		ipv4[0] === 0 ||
		ipv4[0] === 10 ||
		ipv4[0] === 127 ||
		(ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127) ||
		(ipv4[0] === 169 && ipv4[1] === 254) ||
		(ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
		(ipv4[0] === 192 && ipv4[1] === 168) ||
		(ipv4[0] === 198 && (ipv4[1] === 18 || ipv4[1] === 19))
	);
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
	const parts = hostname.split(".");
	if (parts.length !== 4) return null;
	const values = parts.map((part) => Number(part));
	if (values.some((value, index) => !/^\d+$/.test(parts[index] ?? "") || value < 0 || value > 255))
		return null;
	return values as [number, number, number, number];
}

function parseMappedIpv4(hostname: string): [number, number, number, number] | null {
	if (!hostname.startsWith("::ffff:")) return null;
	const mapped = hostname.slice("::ffff:".length);
	const dotted = parseIpv4(mapped);
	if (dotted) return dotted;
	const words = mapped.split(":");
	if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
	const first = Number.parseInt(words[0] ?? "", 16);
	const second = Number.parseInt(words[1] ?? "", 16);
	return [first >> 8, first & 0xff, second >> 8, second & 0xff];
}
