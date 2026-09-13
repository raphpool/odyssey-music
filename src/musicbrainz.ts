/**
 * MusicBrainz catalog adapter — runtime HTTP API.
 *
 * Queries https://musicbrainz.org/ws/2/{artist,release-group,recording}?query=... at runtime
 * instead of holding the dump locally. Trade-off: +150-250ms latency per autocomplete vs zero
 * memory/disk footprint on the droplet (vs ~2.5 GB SQLite that this used to load).
 *
 * Rate limit etiquette: MB asks for a User-Agent identifying the app and contact email so they
 * can throttle us specifically rather than blanket-banning the IP. The autocomplete debounce
 * (150ms) plus the natural typing cadence keeps us well under the published 50 req/s ceiling
 * for properly-UA'd clients.
 */
import { musicBrainzConfig } from "./config.js";
import { logger } from "./logger.js";
import type { NodeType } from "./types.js";

export interface CatalogResult {
	type: "artist" | "project" | "track";
	mbid: string;
	name: string;
	subtitle: string;
	extra?: string;
}

export interface CatalogIndex {
	search(query: string, limit?: number): Promise<CatalogResult[]>;
	searchByType(type: NodeType, query: string, limit?: number): Promise<CatalogResult[]>;
	close(): void;
}

const MB_BASE = musicBrainzConfig.baseUrl;
const USER_AGENT = musicBrainzConfig.userAgent;
const FETCH_TIMEOUT_MS = musicBrainzConfig.fetchTimeoutMs;
const log = logger.child({ module: "musicbrainz" });

interface MbArtist {
	id: string;
	name: string;
	"sort-name"?: string;
	country?: string;
	disambiguation?: string;
}
interface MbReleaseGroup {
	id: string;
	title: string;
	"primary-type"?: string;
	"first-release-date"?: string;
	"artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
}
interface MbRecording {
	id: string;
	title: string;
	length?: number;
	"artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
}

function joinArtistCredit(ac: MbReleaseGroup["artist-credit"]): string {
	if (!ac || !ac.length) return "";
	return ac
		.map((c) => c.name ?? c.artist?.name ?? "")
		.filter(Boolean)
		.join(", ");
}

function fmtLength(ms: number | undefined): string | undefined {
	if (!ms || ms <= 0) return undefined;
	const sec = Math.round(ms / 1000);
	return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
}

/**
 * Build an MB Lucene query for the search-server endpoint. The earlier version wrapped
 * every token in double quotes then suffixed `*` to the last, producing `"central" "cee"*`
 * which is invalid Lucene (you can't wildcard a phrase) — MB silently returned 0 hits for
 * "central cee", "drake", and most multi-word real-world queries.
 *
 * Current shape: strip Lucene metachars, lowercase, then return the raw whitespace-joined
 * tokens. MB's Lucene already does its own fuzzy + relevance scoring against the artist/
 * release-group/recording default field; we don't need (and shouldn't try) to out-clever
 * it with prefix wildcards.
 */
function buildMbQuery(q: string): string {
	return q
		.replace(/[+\-!(){}[\]^"~*?:\\/]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// "[unknown]" / "[no artist]" etc are MB's SpecialPurpose Artist entries used as
// placeholders for releases without a real credit. Drop them from autocomplete.
const SPECIAL_PURPOSE_MBIDS = new Set([
	"125ec42a-7229-4250-afc5-e057484327fe", // [unknown]
	"f731ccc4-e22a-43af-a747-64213329e088", // [anonymous]
	"33cf029c-63b0-41a0-9855-be2a3665fb3b", // [data]
	"314e1c25-dde7-4e4d-b2f4-0a7b9f7c56dc", // [dialogue]
	"eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61", // [no artist]
	"9be7f096-97ec-4615-8957-8d40b5dcbc41", // [traditional]
	"f0a0a6bf-da0a-4dc2-aa50-fe4d97ce7748", // [theatre]
	"89ad4ac3-39f7-470e-963a-56509c546377", // Various Artists
]);

// In-memory result cache keyed by `${path}?${sorted-params}`. TTL is 5 min — long enough
// that a user typing+correcting their query re-hits the cache, short enough that a fresh
// release shows up within the same session. Capped at 500 entries with FIFO eviction.
const mbCache = new Map<string, { at: number; data: unknown }>();
const MB_CACHE_TTL_MS = musicBrainzConfig.cacheTtlMs;
const MB_CACHE_MAX = musicBrainzConfig.cacheMaxEntries;
const MB_MAX_ATTEMPTS = 3;
const MB_RETRY_DELAY_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
let retryQueue = Promise.resolve();

function retryAfterDelayMs(retryAfter: string | null, now: number): number | null {
	if (!retryAfter) return null;
	const seconds = Number(retryAfter.trim());
	const delay = Math.ceil(seconds * 1_000);
	if (Number.isSafeInteger(delay) && delay >= 0) return delay;
	const retryAt = Date.parse(retryAfter);
	if (Number.isNaN(retryAt)) return null;
	return Math.max(0, retryAt - now);
}

async function sleep(delayMs: number): Promise<void> {
	for (let remaining = delayMs; remaining > 0; remaining -= MAX_TIMER_DELAY_MS) {
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, MAX_TIMER_DELAY_MS)));
	}
}

function queueRetry(delayMs: number): Promise<void> {
	const queued = retryQueue.then(() => sleep(delayMs));
	retryQueue = queued.catch(() => undefined);
	return queued;
}

async function mbFetch<T>(path: string, params: Record<string, string>): Promise<T | null> {
	const key = `${path}?${Object.entries(params)
		.sort()
		.map(([k, v]) => `${k}=${v}`)
		.join("&")}`;
	const hit = mbCache.get(key);
	if (hit && Date.now() - hit.at < MB_CACHE_TTL_MS) {
		return hit.data as T;
	}

	const url = new URL(`${MB_BASE}${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	url.searchParams.set("fmt", "json");

	// MusicBrainz returns 503 or 429 when its rate limit is exceeded. Queue retries globally
	// and wait at least one second so concurrent callers cannot create a recovery burst.
	for (let attempt = 0; attempt < MB_MAX_ATTEMPTS; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
		try {
			const r = await fetch(url, {
				headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
				signal: ctrl.signal,
			});
			if ((r.status === 503 || r.status === 429) && attempt < MB_MAX_ATTEMPTS - 1) {
				const retryAfter = retryAfterDelayMs(r.headers.get("Retry-After"), Date.now());
				const wait = Math.max(MB_RETRY_DELAY_MS, retryAfter ?? 0);
				await queueRetry(wait);
				continue;
			}
			if (!r.ok) {
				log.warn("request failed", { status: r.status, path: url.pathname });
				return null;
			}
			const data = (await r.json()) as T;
			// Cache successful responses only — don't poison the cache with throttled empties.
			if (mbCache.size >= MB_CACHE_MAX) {
				const firstKey = mbCache.keys().next().value;
				if (firstKey) mbCache.delete(firstKey);
			}
			mbCache.set(key, { at: Date.now(), data });
			return data;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (attempt === MB_MAX_ATTEMPTS - 1) log.warn("fetch failed", { path: url.pathname, error: msg });
		} finally {
			clearTimeout(timer);
		}
	}
	return null;
}

async function searchArtists(q: string, limit: number): Promise<CatalogResult[]> {
	const query = buildMbQuery(q);
	if (!query) return [];
	const body = await mbFetch<{ artists: MbArtist[] }>("/artist", { query, limit: String(limit) });
	if (!body?.artists) return [];
	return body.artists
		.filter((a) => !SPECIAL_PURPOSE_MBIDS.has(a.id) && a.name !== "[unknown]")
		.map((a) => {
			const r: CatalogResult = {
				type: "artist",
				mbid: a.id,
				name: a.name,
				subtitle: a["sort-name"] ?? "",
			};
			const extra = a.country || a.disambiguation;
			if (extra) r.extra = extra;
			return r;
		});
}

async function searchReleaseGroups(q: string, limit: number): Promise<CatalogResult[]> {
	const query = buildMbQuery(q);
	if (!query) return [];
	// Lucene filter: only Album / Single / EP (matches our original SQLite filter).
	const filtered = `(${query}) AND (primarytype:Album OR primarytype:Single OR primarytype:EP)`;
	const body = await mbFetch<{ "release-groups": MbReleaseGroup[] }>("/release-group", {
		query: filtered,
		limit: String(limit),
	});
	if (!body?.["release-groups"]) return [];
	return body["release-groups"].map((rg) => {
		const r: CatalogResult = {
			type: "project",
			mbid: rg.id,
			name: rg.title,
			subtitle: joinArtistCredit(rg["artist-credit"]),
		};
		if (rg["primary-type"]) r.extra = rg["primary-type"];
		return r;
	});
}

async function searchRecordings(q: string, limit: number): Promise<CatalogResult[]> {
	const query = buildMbQuery(q);
	if (!query) return [];
	const body = await mbFetch<{ recordings: MbRecording[] }>("/recording", {
		query,
		limit: String(limit),
	});
	if (!body?.recordings) return [];
	return body.recordings.map((rec) => {
		const r: CatalogResult = {
			type: "track",
			mbid: rec.id,
			name: rec.title,
			subtitle: joinArtistCredit(rec["artist-credit"]),
		};
		const len = fmtLength(rec.length);
		if (len) r.extra = len;
		return r;
	});
}

function interleave<T>(lists: T[][]): T[] {
	const out: T[] = [];
	const max = Math.max(...lists.map((l) => l.length));
	for (let i = 0; i < max; i++) {
		for (const l of lists) {
			const item = l[i];
			if (item !== undefined) out.push(item);
		}
	}
	return out;
}

/**
 * Construct a runtime catalog index. Despite the name, no local index is built — we just
 * close over the fetch helpers. The same shape as the old SQLite-backed wrapper so the
 * /search handler doesn't need to change.
 */
/**
 * MusicBrainz-backed discography for an artist (2026-05-19 Raph feedback): Wikipedia
 * extraction misses recent releases, MB has them within hours of announcement. We use
 * this to OVERRIDE the LLM's discography edge with canonical MB data.
 */
export interface MbReleaseGroupSummary {
	mbid: string;
	title: string;
	firstReleaseDate: string;
	primaryType: string;
	secondaryTypes: string[];
}

export async function fetchArtistDiscographyMb(
	artistMbid: string,
	opts: { limit?: number } = {},
): Promise<MbReleaseGroupSummary[]> {
	const limit = opts.limit ?? 100;
	interface RGResp {
		"release-group-count"?: number;
		"release-groups"?: {
			id: string;
			title: string;
			"first-release-date"?: string;
			"primary-type"?: string;
			"secondary-types"?: string[];
		}[];
	}
	// Raph 2026-05-24: pull Albums + EPs + Singles. MB browse caps at 100 per call and
	// returns release-groups in id (UUID) order, so for prolific artists (Stones: 318
	// singles incl. "In the Stars" 2026-05-05) a single call misses the most recent
	// releases. Strategy: one call per primary type, paginate via offset up to MAX_PAGES
	// pages when the total count exceeds 100. All pagination calls per type run in
	// parallel, all types run in parallel. Newest items are then surfaced via client-side
	// date sort downstream in pipeline.ts.
	const TYPES = ["album", "ep", "single"] as const;
	const MAX_PAGES = 4; // 4 × 100 = up to 400 RGs per type — covers Stones-scale catalogs
	async function fetchTypePaged(t: string): Promise<RGResp["release-groups"]> {
		const first = await mbFetch<RGResp>(`/release-group`, {
			artist: artistMbid,
			type: t,
			limit: String(limit),
			offset: "0",
		}).catch(() => null);
		if (!first) return [];
		const all = [...(first["release-groups"] ?? [])];
		const total = first["release-group-count"] ?? all.length;
		if (total > limit && limit > 0) {
			const pages = Math.min(MAX_PAGES, Math.ceil(total / limit));
			const more = await Promise.all(
				Array.from({ length: pages - 1 }, (_, i) =>
					mbFetch<RGResp>(`/release-group`, {
						artist: artistMbid,
						type: t,
						limit: String(limit),
						offset: String(limit * (i + 1)),
					}).catch(() => null),
				),
			);
			for (const page of more) {
				if (page?.["release-groups"]) all.push(...page["release-groups"]);
			}
		}
		return all;
	}
	const perType = await Promise.all(TYPES.map((t) => fetchTypePaged(t)));
	const merged: MbReleaseGroupSummary[] = [];
	const seen = new Set<string>();
	for (const list of perType) {
		if (!list) continue;
		for (const g of list) {
			if (seen.has(g.id)) continue;
			seen.add(g.id);
			merged.push({
				mbid: g.id,
				title: g.title,
				firstReleaseDate: g["first-release-date"] ?? "",
				primaryType: g["primary-type"] ?? "",
				secondaryTypes: g["secondary-types"] ?? [],
			});
		}
	}
	// Newest first.
	merged.sort((a, b) => (b.firstReleaseDate || "").localeCompare(a.firstReleaseDate || ""));
	return merged;
}

/** Resolve an artist name to its MBID via MB search. Returns the best match or null. */
export async function findArtistMbidByName(name: string, disambig?: string): Promise<string | null> {
	const q = disambig ? `${name} ${disambig}` : name;
	const results = await searchArtists(q, 3);
	return results[0]?.mbid ?? null;
}

interface MbUrlRelation {
	type?: string;
	url?: { resource?: string };
}

export interface MbStreamingLinks {
	spotify: string | null;
	apple: string | null;
}

/**
 * Read an artist's streaming-service links from MusicBrainz url-rels.
 *
 * MB curates "streaming"/"free streaming" relationships on ARTIST entities, which
 * is the one place we can get an exact Spotify entity URL without Spotify API
 * credentials (measured 2026-08-17: 9/12 sampled cache artists had one). The
 * same relationships do NOT exist on release-groups or recordings — albums and
 * tracks have to go through iTunes/Apple or fall back to a search link.
 */
export async function fetchArtistStreamingLinksMb(artistMbid: string): Promise<MbStreamingLinks> {
	const data = await mbFetch<{ relations?: MbUrlRelation[] }>(`/artist/${artistMbid}`, {
		inc: "url-rels",
	});
	const resources = (data?.relations ?? []).map((r) => r.url?.resource).filter((u): u is string => !!u);
	const find = (host: string): string | null => resources.find((u) => u.includes(host)) ?? null;
	return { spotify: find("open.spotify.com"), apple: find("music.apple.com") };
}

/** Extract candidate artist-name tokens (>=3 chars) from a disambiguator string. */
function disambigTokens(disambig: string | undefined): string[] {
	if (!disambig) return [];
	return disambig
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length >= 3 && !/^(20\d{2}|19\d{2})$/.test(t));
}

/**
 * Resolve a recording (track) name to its MBID via MB recording search.
 * MB's free-text search loves to surface covers and metal-tribute albums for common track
 * names (caught 2026-05-19 on "Get Lucky" → returned Walt Ribeiro + Charlie Parra covers).
 * Require the matched recording's artist-credit subtitle to contain >=1 token from the
 * user-supplied disambiguator (which is the most reliable signal we have). If no candidate
 * matches, return null rather than overriding with a cover.
 */
/**
 * Fetch the genre tags for an entity (artist/release-group/recording) from MB.
 * MB exposes both "genres" (a curated subset of tags promoted to genre status) and "tags"
 * (free-text user submissions). Both carry a `count` of upvotes. We prefer genres when
 * present, fall back to tags filtered by count >= minCount. Returns lowercased names.
 *
 * 2026-05-19 Raph caught: the infobox-derived Wikipedia genre is much coarser than what
 * MB users actually tag. For Drake, MB has 9 distinct genres with vote counts; Wiki
 * usually surfaces 2-3 broad ones.
 */
export type MbGenreEntity = "artist" | "release-group" | "recording";

export interface MbGenreTag {
	/** Lowercased, trimmed genre name — identical to what the function returned before. */
	name: string;
	/** MusicBrainz genre MBID. Absent for entries coming from the `data.tags` fallback. */
	mbid?: string;
}

export async function fetchEntityGenresMb(
	entity: MbGenreEntity,
	mbid: string,
	opts: { minCount?: number; max?: number } = {},
): Promise<MbGenreTag[]> {
	const minCount = opts.minCount ?? 2;
	const max = opts.max ?? 8;
	interface Resp {
		genres?: { name: string; count?: number; id?: string }[];
		tags?: { name: string; count?: number; id?: string }[];
	}
	const data = await mbFetch<Resp>(`/${entity}/${mbid}`, { inc: "genres+tags" });
	if (!data) return [];
	const source = data.genres && data.genres.length > 0 ? data.genres : (data.tags ?? []);
	const filtered = source
		.filter((t) => (t.count ?? 0) >= minCount)
		.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
		.map((t) => ({ name: t.name.toLowerCase().trim(), id: t.id }))
		.filter((t) => t.name.length > 0);
	// De-dup on name (not mbid), preserving order. First occurrence wins.
	const seen = new Set<string>();
	const out: MbGenreTag[] = [];
	for (const t of filtered) {
		if (seen.has(t.name)) continue;
		seen.add(t.name);
		// exactOptionalPropertyTypes: only set mbid when it's a non-empty string, never `undefined`.
		out.push(t.id ? { name: t.name, mbid: t.id } : { name: t.name });
		if (out.length >= max) break;
	}
	return out;
}

/** Resolve a label name to its MBID via MB label search. */
export async function findLabelMbidByName(name: string, disambig?: string): Promise<string | null> {
	interface LabelHit {
		id: string;
		name: string;
		country?: string;
		disambiguation?: string;
	}
	const q = disambig ? `${name} ${disambig}` : name;
	const query = buildMbQuery(q);
	if (!query) return null;
	const body = await mbFetch<{ labels?: LabelHit[] }>("/label", { query, limit: "5" });
	if (!body?.labels?.length) return null;
	const tokens = disambigTokens(disambig);
	if (tokens.length === 0) return body.labels[0]?.id ?? null;
	const matched = body.labels.find((l) => {
		const blob = `${l.name} ${l.country ?? ""} ${l.disambiguation ?? ""}`.toLowerCase();
		return tokens.some((t) => blob.includes(t));
	});
	return matched?.id ?? body.labels[0]?.id ?? null;
}

export interface MbLabelMeta {
	roster: { mbid: string; name: string }[];
	notableReleases: { mbid: string; title: string; firstReleaseDate: string }[];
}

/**
 * Fetch the label entity itself — name, country, founded year, disambiguation. Used by
 * the JIT pipeline to pin Tavily searches to the exact label MB resolved (the chip
 * ships an MBID; without context the LLM picks the wrong "Decca" / "Columbia" / etc.).
 * Returns null on lookup failure — caller treats as soft (non-fatal).
 */
export interface MbLabelEntity {
	mbid: string;
	name: string;
	country: string | null;
	founded: string | null; // ISO date or year
	disambiguation: string | null;
}
export async function fetchLabelEntityMb(labelMbid: string): Promise<MbLabelEntity | null> {
	interface LabelResp {
		id: string;
		name: string;
		country?: string;
		"life-span"?: { begin?: string };
		disambiguation?: string;
	}
	const data = await mbFetch<LabelResp>(`/label/${labelMbid}`, {});
	if (!data?.id) return null;
	return {
		mbid: data.id,
		name: data.name,
		country: data.country ?? null,
		founded: data["life-span"]?.begin ?? null,
		disambiguation: data.disambiguation ?? null,
	};
}

/**
 * Browse artists released on a label and release-groups under that label.
 * /artist?label= and /release-group?label= each paginate at limit=100.
 */
export async function fetchLabelMetaMb(labelMbid: string): Promise<MbLabelMeta> {
	const out: MbLabelMeta = { roster: [], notableReleases: [] };
	interface ArtistBrowseResp {
		artists?: { id: string; name: string }[];
	}
	interface RGBrowseResp {
		"release-groups"?: {
			id: string;
			title: string;
			"first-release-date"?: string;
			"primary-type"?: string;
			"secondary-types"?: string[];
		}[];
	}
	const [artistResp, rgResp] = await Promise.all([
		mbFetch<ArtistBrowseResp>("/artist", { label: labelMbid, limit: "100" }),
		mbFetch<RGBrowseResp>("/release-group", { label: labelMbid, limit: "100" }),
	]);
	const seen = new Set<string>();
	for (const a of artistResp?.artists ?? []) {
		if (!a.id || seen.has(a.id)) continue;
		seen.add(a.id);
		out.roster.push({ mbid: a.id, name: a.name });
	}
	const rgs = (rgResp?.["release-groups"] ?? []).filter((rg) => (rg["secondary-types"] ?? []).length === 0);
	rgs.sort((a, b) => (b["first-release-date"] ?? "").localeCompare(a["first-release-date"] ?? ""));
	const seenRg = new Set<string>();
	for (const rg of rgs) {
		if (!rg.id || seenRg.has(rg.id)) continue;
		seenRg.add(rg.id);
		out.notableReleases.push({
			mbid: rg.id,
			title: rg.title,
			firstReleaseDate: rg["first-release-date"] ?? "",
		});
	}
	return out;
}

export async function findRecordingMbidByName(name: string, disambig?: string): Promise<string | null> {
	// Phrase-quoted recording: field bypasses buildMbQuery (which strips quotes) and goes
	// straight to mbFetch. Without this MB ranks "Get Lucky (Daft Punk remix)" and various
	// covers above the canonical recording for common track names (Raph 2026-05-19).
	const safeName = name.replace(/["\\]/g, "");
	const safeDisambig = (disambig ?? "").replace(/["\\]/g, "");
	const query = safeDisambig ? `recording:"${safeName}" AND ${safeDisambig}` : `recording:"${safeName}"`;
	interface RecRespHit {
		id: string;
		title: string;
		length?: number;
		"artist-credit"?: { artist?: { id: string; name: string } }[];
	}
	const body = await mbFetch<{ recordings?: RecRespHit[] }>("/recording", {
		query,
		limit: "10",
	});
	const results = (body?.recordings ?? []).map((rec) => ({
		mbid: rec.id,
		name: rec.title,
		type: "track" as const,
		subtitle: (rec["artist-credit"] ?? [])
			.map((a) => a.artist?.name ?? "")
			.filter(Boolean)
			.join(" "),
		extra: undefined as string | undefined,
	}));
	if (results.length === 0) return null;
	const tokens = disambigTokens(disambig);
	if (tokens.length === 0) return results[0]?.mbid ?? null;
	const wantedTitle = name.toLowerCase().trim();
	// First pass: match disambig tokens against the artist-credit subtitle.
	let candidates = results.filter((r) => {
		const sub = (r.subtitle ?? "").toLowerCase();
		return tokens.some((t) => sub.includes(t));
	});
	if (candidates.length === 0) return null;
	// Prefer recordings whose TITLE exactly equals the input name. Without this, "Get Lucky"
	// matched the 10:33 "Get Lucky (Daft Punk remix)" recording on Random Access Memories
	// instead of the 4:08 album version (Raph caught 2026-05-19).
	const exactTitleMatches = candidates.filter((r) => r.name.toLowerCase().trim() === wantedTitle);
	if (exactTitleMatches.length > 0) candidates = exactTitleMatches;
	// Second pass (canonical-album fit): walk each candidate's releases and prefer the
	// recording whose earliest release sits on an Album-primary release-group with no
	// secondary-types. Avoids the "Get Lucky → 10:33 long-mix single" trap (Raph 2026-05-19).
	let bestMbid: string | null = null;
	let bestScore = 99;
	for (const c of candidates.slice(0, 5)) {
		interface RecResp {
			releases?: {
				date?: string;
				"release-events"?: { date?: string }[];
				"release-group"?: { "primary-type"?: string; "secondary-types"?: string[] };
			}[];
		}
		const r = await mbFetch<RecResp>(`/recording/${c.mbid}`, { inc: "releases+release-groups" });
		const rels = (r?.releases ?? []).slice().sort((a, b) => {
			const sa = rgScore(a["release-group"]);
			const sb = rgScore(b["release-group"]);
			if (sa !== sb) return sa - sb;
			const ad = a.date ?? a["release-events"]?.[0]?.date ?? "9999";
			const bd = b.date ?? b["release-events"]?.[0]?.date ?? "9999";
			return ad.localeCompare(bd);
		});
		const score = rgScore(rels[0]?.["release-group"]);
		if (score < bestScore) {
			bestScore = score;
			bestMbid = c.mbid;
		}
	}
	return bestMbid ?? candidates[0]?.mbid ?? null;
}

/**
 * Resolve a project (album/EP) name to its MBID via MB release-group search.
 * Same disambiguator-token guard as findRecordingMbidByName.
 */
export async function findReleaseGroupMbidByName(name: string, disambig?: string): Promise<string | null> {
	const q = disambig ? `${name} ${disambig}` : name;
	const results = await searchReleaseGroups(q, 8);
	if (results.length === 0) return null;
	const tokens = disambigTokens(disambig);
	if (tokens.length === 0) return results[0]?.mbid ?? null;
	const matched = results.find((r) => {
		const sub = (r.subtitle ?? "").toLowerCase();
		return tokens.some((t) => sub.includes(t));
	});
	return matched?.mbid ?? null;
}

/**
 * Fetch the canonical tracklist for a release-group. Picks the first release in the
 * release-group, walks its media[].tracks[] and returns just the recording titles
 * (which we use as track edge names). Returns [] on any error.
 */
export interface MbTrackSummary {
	mbid: string;
	title: string;
	length?: number;
}

export interface MbCredit {
	mbid: string;
	name: string;
}

export interface MbTrackMeta {
	project: { mbid: string; name: string } | null;
	label: { mbid: string; name: string } | null;
	artists: { mbid: string; name: string }[];
	year: string | null;
	duration: string | null;
	producers: MbCredit[];
	personnel: MbCredit[];
}

/**
 * Bucket an MB artist-relation type into producer | personnel | skip.
 * Producer-ish: any rel whose type matches /producer/i (producer, co-producer, executive
 * producer, additional producer, vocal producer). Skip remixer (separate concept), composer,
 * lyricist, arranger (we don't surface songwriting credits here). Everything else artist-
 * targeted → personnel (engineer, mix, mastering, recording, vocal, instrument, performance,
 * featured, programming, etc.).
 *
 * Why: the LLM emits producer/personnel by raw name ("40", "Boi-1da") which `artist:<slug>`
 * then resolves via MB free-text search; short or ambiguous tokens land on the wrong artist
 * (E-40 instead of Noah "40" Shebib — Raph 2026-05-20). MB relations are MBID-canonical, so
 * stamping the MBID at edge-emit time pins the click target via the existing JIT mbid path.
 */
function bucketArtistRel(relType: string): "producer" | "personnel" | "skip" {
	const t = relType.toLowerCase();
	if (/producer/.test(t)) return "producer";
	if (t === "remixer" || t === "composer" || t === "lyricist" || t === "arranger" || t === "writer") {
		return "skip";
	}
	return "personnel";
}

interface MbArtistRel {
	type?: string;
	"target-type"?: string;
	direction?: string;
	artist?: { id: string; name: string };
}

function collectArtistRels(
	rels: MbArtistRel[] | undefined,
	producers: Map<string, MbCredit>,
	personnel: Map<string, MbCredit>,
): void {
	if (!Array.isArray(rels)) return;
	for (const r of rels) {
		if (r["target-type"] && r["target-type"] !== "artist") continue;
		const a = r.artist;
		if (!a?.id || !a.name) continue;
		const bucket = bucketArtistRel(r.type ?? "");
		if (bucket === "skip") continue;
		const map = bucket === "producer" ? producers : personnel;
		if (!map.has(a.id)) map.set(a.id, { mbid: a.id, name: a.name });
	}
}

/**
 * Score a release-group for "is this the canonical album home for this track?".
 * Lower = better. Album with no secondary-types is the gold standard; Single is last resort.
 */
function rgScore(rg: { "primary-type"?: string; "secondary-types"?: string[] } | undefined): number {
	if (!rg) return 99;
	const sec = rg["secondary-types"] ?? [];
	if (sec.length > 0) return 50; // compilation/live/mixtape — deprioritize
	const primary = (rg["primary-type"] ?? "").toLowerCase();
	if (primary === "album") return 0;
	if (primary === "ep") return 10;
	if (primary === "single") return 20;
	if (primary === "broadcast") return 30;
	return 40;
}

/**
 * Fetch track-level metadata via MB. Given a recording MBID, find the earliest release-
 * group it appears on (canonical "original" album), pull that release's label + artists.
 */
export async function fetchTrackMetaMb(recordingMbid: string): Promise<MbTrackMeta> {
	const empty: MbTrackMeta = {
		project: null,
		label: null,
		artists: [],
		year: null,
		duration: null,
		producers: [],
		personnel: [],
	};
	interface RecordingResp {
		length?: number;
		"artist-credit"?: { artist?: { id: string; name: string } }[];
		relations?: MbArtistRel[];
		releases?: {
			id: string;
			date?: string;
			"release-events"?: { date?: string }[];
			"release-group"?: {
				id: string;
				title: string;
				"first-release-date"?: string;
				"primary-type"?: string;
				"secondary-types"?: string[];
			};
		}[];
	}
	const rec = await mbFetch<RecordingResp>(`/recording/${recordingMbid}`, {
		inc: "releases+release-groups+artist-credits+artist-rels",
	});
	if (!rec) return empty;
	const out: MbTrackMeta = {
		project: null,
		label: null,
		artists: [],
		year: null,
		duration: null,
		producers: [],
		personnel: [],
	};
	const producersMap = new Map<string, MbCredit>();
	const personnelMap = new Map<string, MbCredit>();
	collectArtistRels(rec.relations, producersMap, personnelMap);
	if (typeof rec.length === "number") {
		const totalSec = Math.round(rec.length / 1000);
		const m = Math.floor(totalSec / 60);
		const s = String(totalSec % 60).padStart(2, "0");
		out.duration = `${m}:${s}`;
	}
	const seenArtist = new Set<string>();
	for (const ac of rec["artist-credit"] ?? []) {
		const a = ac.artist;
		if (!a || !a.id || seenArtist.has(a.id)) continue;
		seenArtist.add(a.id);
		out.artists.push({ mbid: a.id, name: a.name });
	}
	// Prefer the earliest release whose release-group is an Album with no secondary-types
	// (i.e. the canonical studio album), then EP, then Single. This avoids picking a
	// "Get Lucky" single release-group when the canonical project is Random Access Memories.
	const releases = (rec.releases ?? []).slice().sort((a, b) => {
		const rgA = a["release-group"];
		const rgB = b["release-group"];
		const scoreA = rgScore(rgA);
		const scoreB = rgScore(rgB);
		if (scoreA !== scoreB) return scoreA - scoreB; // lower is better
		const ad = a.date ?? a["release-events"]?.[0]?.date ?? "9999";
		const bd = b.date ?? b["release-events"]?.[0]?.date ?? "9999";
		return ad.localeCompare(bd);
	});
	const earliest = releases[0];
	if (earliest?.["release-group"]) {
		out.project = { mbid: earliest["release-group"].id, name: earliest["release-group"].title };
		const d = earliest["release-group"]["first-release-date"] ?? earliest.date;
		if (typeof d === "string" && /^\d{4}/.test(d)) out.year = d.slice(0, 4);
	}
	// Fetch label info from the earliest release.
	if (earliest) {
		interface ReleaseLabelResp {
			"label-info"?: { label?: { id: string; name: string } | null }[];
		}
		const rel = await mbFetch<ReleaseLabelResp>(`/release/${earliest.id}`, { inc: "labels" });
		const firstLabel = (rel?.["label-info"] ?? []).find((li) => li.label && li.label.name)?.label;
		if (firstLabel) out.label = { mbid: firstLabel.id, name: firstLabel.name };
	}
	out.producers = [...producersMap.values()];
	const prodIdsT = new Set(out.producers.map((p) => p.mbid));
	out.personnel = [...personnelMap.values()].filter((p) => !prodIdsT.has(p.mbid));
	return out;
}

export interface MbProjectMeta {
	tracks: MbTrackSummary[];
	label: { mbid: string; name: string } | null;
	artists: { mbid: string; name: string }[];
	year: string | null;
	producers: MbCredit[];
	personnel: MbCredit[];
	/** Release-group primary-type from MusicBrainz (e.g. "Album", "EP", "Single",
	 * "Compilation"). The pipeline narrows this to album/ep/single before
	 * persisting to the project node — values outside that set become undefined. */
	primaryType: string | null;
}

/**
 * Fetch tracklist + label + artist-credit + release year for a release-group. Uses the
 * earliest release in the group (canonical "original" pressing) so the data matches what
 * fans recognize as "the album" rather than a deluxe reissue.
 */
export async function fetchProjectMetaMb(rgMbid: string): Promise<MbProjectMeta> {
	const empty: MbProjectMeta = {
		tracks: [],
		label: null,
		artists: [],
		year: null,
		producers: [],
		personnel: [],
		primaryType: null,
	};
	interface ReleaseGroupResp {
		"first-release-date"?: string;
		"primary-type"?: string;
		relations?: MbArtistRel[];
		releases?: { id: string; "release-events"?: { date?: string }[]; date?: string }[];
	}
	const rg = await mbFetch<ReleaseGroupResp>(`/release-group/${rgMbid}`, {
		inc: "releases+artist-rels",
	});
	if (!rg || !Array.isArray(rg.releases) || rg.releases.length === 0) return empty;
	const releases = [...rg.releases].sort((a, b) => {
		const ad = a.date ?? a["release-events"]?.[0]?.date ?? "9999";
		const bd = b.date ?? b["release-events"]?.[0]?.date ?? "9999";
		return ad.localeCompare(bd);
	});
	const releaseId = releases[0]?.id;
	if (!releaseId) return empty;
	interface ReleaseResp {
		date?: string;
		"label-info"?: { label?: { id: string; name: string } | null }[];
		"artist-credit"?: { name?: string; artist?: { id: string; name: string } }[];
		relations?: MbArtistRel[];
		media?: {
			tracks?: {
				id: string;
				recording?: {
					id: string;
					title: string;
					length?: number;
					relations?: MbArtistRel[];
				};
			}[];
		}[];
	}
	const rel = await mbFetch<ReleaseResp>(`/release/${releaseId}`, {
		inc: "recordings+labels+artist-credits+artist-rels+recording-level-rels",
	});
	if (!rel) return empty;
	const out: MbProjectMeta = {
		tracks: [],
		label: null,
		artists: [],
		year: null,
		producers: [],
		personnel: [],
		primaryType: null,
	};
	const producersMap = new Map<string, MbCredit>();
	const personnelMap = new Map<string, MbCredit>();
	collectArtistRels(rg.relations, producersMap, personnelMap);
	collectArtistRels(rel.relations, producersMap, personnelMap);
	const seen = new Set<string>();
	for (const m of rel.media ?? []) {
		for (const t of m.tracks ?? []) {
			const r = t.recording;
			if (!r || typeof r.title !== "string") continue;
			const key = r.title.toLowerCase().trim();
			if (seen.has(key)) continue;
			seen.add(key);
			const entry: MbTrackSummary = { mbid: r.id, title: r.title };
			if (typeof r.length === "number") entry.length = r.length;
			out.tracks.push(entry);
			collectArtistRels(r.relations, producersMap, personnelMap);
		}
	}
	out.producers = [...producersMap.values()];
	// Personnel should not duplicate the producer chip (Noah "40" Shebib is often listed in
	// both buckets via separate MB rels). Drop any personnel MBID that's already a producer.
	const prodIds = new Set(out.producers.map((p) => p.mbid));
	out.personnel = [...personnelMap.values()].filter((p) => !prodIds.has(p.mbid));
	const firstLabel = (rel["label-info"] ?? []).find((li) => li.label && li.label.name)?.label;
	if (firstLabel) out.label = { mbid: firstLabel.id, name: firstLabel.name };
	const seenArtist = new Set<string>();
	for (const ac of rel["artist-credit"] ?? []) {
		const a = ac.artist;
		if (!a || !a.id || seenArtist.has(a.id)) continue;
		seenArtist.add(a.id);
		out.artists.push({ mbid: a.id, name: a.name });
	}
	const dateStr = rel.date ?? rg["first-release-date"];
	if (typeof dateStr === "string" && /^\d{4}/.test(dateStr)) out.year = dateStr.slice(0, 4);
	if (typeof rg["primary-type"] === "string") out.primaryType = rg["primary-type"];
	return out;
}

export function createMusicBrainzCatalog(): CatalogIndex {
	return {
		async search(query, limit = 5) {
			const per = Math.max(2, Math.ceil(limit / 2));
			const [artists, projects, tracks] = await Promise.all([
				searchArtists(query, per),
				searchReleaseGroups(query, per),
				searchRecordings(query, per),
			]);
			return interleave([artists, projects, tracks]).slice(0, limit * 3);
		},
		async searchByType(type, query, limit = 8) {
			if (type === "artist") return searchArtists(query, limit);
			if (type === "project") return searchReleaseGroups(query, limit);
			if (type === "track") return searchRecordings(query, limit);
			return [];
		},
		close() {},
	};
}
