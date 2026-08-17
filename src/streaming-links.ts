/**
 * Resolve a node to its Spotify / Apple Music pages.
 *
 * There is no external identifier anywhere in the graph — no MBID, no ISRC, no
 * stored service id on any of the ~1400 cached nodes — so every link is resolved
 * by text search against the node's name plus its first credited artist, and the
 * result is cached in a sidecar (same approach as the YouTube resolver: keeps the
 * NodePayload schema and its Zod gate untouched).
 *
 * Where each link comes from, and why:
 *
 *   artist  → Spotify: MusicBrainz url-rels (the only credential-free source of an
 *             exact Spotify entity URL; ~75% coverage on this cache).
 *             Apple:   iTunes Search (musicArtist), which is more reliable here
 *             than MB's apple rel (~33%).
 *   project → Apple:   iTunes Search (album). Spotify: search link.
 *   track   → Apple:   iTunes Search (song).  Spotify: search link.
 *   genre / label → nothing; they have no streaming counterpart.
 *
 * Spotify on albums/tracks would need the Spotify Web API (client credentials).
 * Until those exist, `spotify` is left null for those types and the UI falls back
 * to a prefilled search URL it builds itself — see spotifySearchUrl below.
 *
 * Misses are cached too. Without a negative entry every page view of an
 * unmatchable node (small labels, white labels, dub plates) re-hits both APIs
 * forever — the failure mode the JIT image path already has today.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { searchAppleEntities } from "./itunes.js";
import { logger } from "./logger.js";
import { fetchArtistStreamingLinksMb, findArtistMbidByName } from "./musicbrainz.js";
import { nameMatchScore } from "./text-match.js";
import type { NodeType } from "./types.js";

const log = logger.child({ module: "streaming-links" });

/** Node types that have a streaming counterpart worth linking. */
export const LINKABLE_TYPES: ReadonlySet<string> = new Set(["artist", "project", "track"]);

/** Re-resolve a miss after a week, so a transient upstream outage self-heals. */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SERVICE_HOSTS = { spotify: "open.spotify.com", apple: "music.apple.com" } as const;

/**
 * Accept a URL only if it is https and served by the expected service host.
 *
 * MusicBrainz relations are third-party, user-editable data: anyone can attach
 * a url-rel to an artist. A substring host test (`u.includes("open.spotify.com")`)
 * happily passes `https://evil.example/?ref=open.spotify.com` and even
 * `javascript:alert(1)//open.spotify.com`, and the client assigns the result
 * straight to an <a href>. Parse it and compare the hostname exactly.
 */
export function safeServiceUrl(
	raw: string | null | undefined,
	service: keyof typeof SERVICE_HOSTS,
): string | null {
	if (!raw) return null;
	try {
		const u = new URL(raw);
		if (u.protocol !== "https:") return null;
		return u.hostname === SERVICE_HOSTS[service] ? u.toString() : null;
	} catch {
		return null;
	}
}

export interface StreamingLinks {
	spotify: string | null;
	apple: string | null;
	/** Which resolver produced each link — useful when auditing a bad match. */
	sources: { spotify?: string; apple?: string };
	resolvedAt: string;
}

/**
 * Both halves of the slug are sanitized, not just the body: the type prefix also
 * lands in the filename, and an unsanitized `"../../etc/passwd:x"` would resolve
 * outside the cache directory. The HTTP route happens to gate this behind a
 * cache lookup that 404s first, but a path builder should not depend on its
 * callers for that.
 */
export function sidecarPath(cacheDir: string, slug: string): string {
	const safe = (s: string): string => s.replace(/[^a-z0-9_-]/gi, "_");
	const [type, ...rest] = slug.split(":");
	const body = safe(rest.join(":") || type || "");
	return join(cacheDir, "links", `${safe(type ?? "")}-${body}.json`);
}

/**
 * Prefilled search URLs. These always work — no lookup, no coverage gap — and are
 * what the UI shows when we have no exact entity link. Spotify's /search/<q> route
 * opens the native app on mobile/desktop when it is installed.
 */
export function spotifySearchUrl(name: string, artistName?: string): string {
	const q = [artistName, name].filter(Boolean).join(" ");
	return `https://open.spotify.com/search/${encodeURIComponent(q)}`;
}

export function appleSearchUrl(name: string, artistName?: string): string {
	const q = [artistName, name].filter(Boolean).join(" ");
	return `https://music.apple.com/search?term=${encodeURIComponent(q)}`;
}

/** Best Apple Music page for this entity, or null when nothing matches confidently. */
async function resolveApple(
	entity: "musicArtist" | "album" | "song",
	name: string,
	artistName: string | undefined,
): Promise<string | null> {
	const term = [name, artistName].filter(Boolean).join(" ");
	const candidates = await searchAppleEntities(entity, term);
	let best: { url: string; score: number } | null = null;
	for (const c of candidates) {
		// For musicArtist the candidate title IS the artist name, so there is no
		// separate artist to cross-check — compare the name against itself only.
		const score =
			entity === "musicArtist"
				? nameMatchScore(c.title, name, undefined)
				: nameMatchScore(`${c.title} ${c.artistName ?? ""}`, name, artistName);
		if (score === null) continue;
		if (!best || score > best.score) best = { url: c.url, score };
	}
	return best?.url ?? null;
}

export interface ResolveLinksInput {
	slug: string;
	type: NodeType;
	name: string;
	/** First credited artist, when the node has one (projects and tracks). */
	artistName?: string;
	cacheDir: string;
	/** Bypass and overwrite an existing sidecar. */
	force?: boolean;
}

export async function resolveStreamingLinks(input: ResolveLinksInput): Promise<StreamingLinks> {
	if (!LINKABLE_TYPES.has(input.type)) {
		return { spotify: null, apple: null, sources: {}, resolvedAt: new Date().toISOString() };
	}
	if (!input.force) {
		const cached = await readSidecar(input.cacheDir, input.slug);
		if (cached && !isStaleMiss(cached)) return cached;
	}

	const links: StreamingLinks = {
		spotify: null,
		apple: null,
		sources: {},
		resolvedAt: new Date().toISOString(),
	};

	if (input.type === "artist") {
		const mbid = await findArtistMbidByName(input.name);
		if (mbid) {
			const mb = await fetchArtistStreamingLinksMb(mbid);
			const spotify = safeServiceUrl(mb.spotify, "spotify");
			const apple = safeServiceUrl(mb.apple, "apple");
			if (spotify) {
				links.spotify = spotify;
				links.sources.spotify = "musicbrainz";
			}
			if (apple) {
				links.apple = apple;
				links.sources.apple = "musicbrainz";
			}
		}
		if (!links.apple) {
			const apple = await resolveApple("musicArtist", input.name, undefined);
			if (apple) {
				links.apple = apple;
				links.sources.apple = "itunes";
			}
		}
	} else {
		const entity = input.type === "project" ? "album" : "song";
		const apple = await resolveApple(entity, input.name, input.artistName);
		if (apple) {
			links.apple = apple;
			links.sources.apple = "itunes";
		}
	}

	await writeSidecar(input.cacheDir, input.slug, links).catch((e: unknown) => {
		log.warn("sidecar write failed", { slug: input.slug, error: e instanceof Error ? e.message : String(e) });
	});
	return links;
}

/**
 * A cached miss older than MISS_TTL_MS is treated as absent so it gets retried.
 *
 * Neither upstream distinguishes "no such record" from "we were rate-limited or
 * timed out" — searchAppleEntities returns [] for both, mbFetch returns null for
 * both — so without an expiry a single iTunes 429 or MusicBrainz 503 would pin a
 * node to "no links" permanently. Hits never expire: a resolved page URL is stable.
 */
function isStaleMiss(cached: StreamingLinks): boolean {
	if (cached.spotify || cached.apple) return false;
	const at = Date.parse(cached.resolvedAt);
	if (Number.isNaN(at)) return true;
	return Date.now() - at > MISS_TTL_MS;
}

export async function readSidecar(cacheDir: string, slug: string): Promise<StreamingLinks | null> {
	try {
		const text = await readFile(sidecarPath(cacheDir, slug), "utf8");
		const parsed = JSON.parse(text) as StreamingLinks;
		// Guard against a hand-edited or truncated sidecar reaching the client.
		if (typeof parsed !== "object" || parsed === null) return null;
		return {
			spotify: typeof parsed.spotify === "string" ? parsed.spotify : null,
			apple: typeof parsed.apple === "string" ? parsed.apple : null,
			sources: typeof parsed.sources === "object" && parsed.sources ? parsed.sources : {},
			resolvedAt: typeof parsed.resolvedAt === "string" ? parsed.resolvedAt : new Date().toISOString(),
		};
	} catch {
		return null;
	}
}

async function writeSidecar(cacheDir: string, slug: string, data: StreamingLinks): Promise<void> {
	const file = sidecarPath(cacheDir, slug);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function invalidateSidecar(cacheDir: string, slug: string): Promise<void> {
	await unlink(sidecarPath(cacheDir, slug)).catch(() => {});
}
