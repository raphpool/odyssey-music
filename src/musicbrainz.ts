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
import { normalizeSlugBody, normalizeTitleBody, stripEditionNoise } from "./slug.js";
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

export interface MusicBrainzCatalogOptions {
	/**
	 * The web search has historically treated a failed catalog lookup as an empty
	 * supplement to its cache. Mobile callers need to expose that outage instead.
	 */
	failOnUnavailable?: boolean;
}

export class MusicBrainzCatalogUnavailableError extends Error {
	constructor() {
		super("MusicBrainz catalog is unavailable");
		this.name = "MusicBrainzCatalogUnavailableError";
	}
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
// `artist.id` is typed but deliberately not enforced by hasValidArtistCredit: the autocomplete
// paths only read names, so an odd id must not blank them. toCredits() validates it where it matters.
interface MbArtistCreditEntry {
	name?: string;
	/** Text MB puts between this entry and the next (" & ", " feat. ", ""). Unvalidated: read with a typeof guard. */
	joinphrase?: string;
	/** `aliases` is present in search hits and unvalidated: read with aliasNames(). */
	artist?: { id?: string; name?: string; aliases?: unknown };
}
interface MbReleaseGroup {
	id: string;
	title: string;
	"primary-type"?: string;
	"first-release-date"?: string;
	"artist-credit"?: MbArtistCreditEntry[];
}
interface MbRecording {
	id: string;
	title: string;
	length?: number;
	/** MB's note telling same-titled recordings apart ("live, Detroit 1998", "DJ-mix", "video"...). */
	disambiguation?: string;
	"first-release-date"?: string;
	"artist-credit"?: MbArtistCreditEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function isMbid(value: unknown): value is string {
	return typeof value === "string" && MBID_RE.test(value);
}

function hasOptionalText(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	return value === undefined || isText(value);
}

function hasValidArtistCredit(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	return value.every((credit) => {
		if (!isRecord(credit) || !hasOptionalText(credit, "name")) return false;
		const artist = credit.artist;
		return artist === undefined || (isRecord(artist) && hasOptionalText(artist, "name"));
	});
}

function parseArtists(body: unknown): MbArtist[] | null {
	if (!isRecord(body) || !Array.isArray(body.artists)) return null;
	const artists = body.artists;
	if (
		!artists.every(
			(artist) =>
				isRecord(artist) &&
				isMbid(artist.id) &&
				isText(artist.name) &&
				hasOptionalText(artist, "sort-name") &&
				hasOptionalText(artist, "country") &&
				hasOptionalText(artist, "disambiguation"),
		)
	)
		return null;
	return artists as MbArtist[];
}

function parseReleaseGroups(body: unknown): MbReleaseGroup[] | null {
	if (!isRecord(body) || !Array.isArray(body["release-groups"])) return null;
	const releaseGroups = body["release-groups"];
	if (
		!releaseGroups.every(
			(releaseGroup) =>
				isRecord(releaseGroup) &&
				isMbid(releaseGroup.id) &&
				isText(releaseGroup.title) &&
				hasOptionalText(releaseGroup, "primary-type") &&
				hasOptionalText(releaseGroup, "first-release-date") &&
				(releaseGroup["artist-credit"] === undefined || hasValidArtistCredit(releaseGroup["artist-credit"])),
		)
	)
		return null;
	return releaseGroups as MbReleaseGroup[];
}

function parseRecordings(body: unknown): MbRecording[] | null {
	if (!isRecord(body) || !Array.isArray(body.recordings)) return null;
	const recordings = body.recordings;
	if (
		!recordings.every(
			(recording) =>
				isRecord(recording) &&
				isMbid(recording.id) &&
				isText(recording.title) &&
				(recording.length === undefined || typeof recording.length === "number") &&
				(recording["first-release-date"] === undefined ||
					typeof recording["first-release-date"] === "string") &&
				(recording["artist-credit"] === undefined || hasValidArtistCredit(recording["artist-credit"])),
		)
	)
		return null;
	return recordings as MbRecording[];
}

/**
 * Valid credits out of an untrusted `artist-credit` array: only entries whose artist carries a
 * real MBID and a non-blank name survive, deduplicated by MBID. Anything else is dropped rather
 * than guessed at — a credit without an MBID cannot be linked to a node.
 */
function toCredits(raw: unknown): MbCredit[] {
	if (!Array.isArray(raw)) return [];
	const out: MbCredit[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (!isRecord(entry) || !isRecord(entry.artist)) continue;
		const { id, name: canonical } = entry.artist;
		if (!isMbid(id) || seen.has(id)) continue;
		const name = isText(canonical) ? canonical : isText(entry.name) ? entry.name : null;
		if (name === null) continue;
		seen.add(id);
		out.push({ mbid: id, name });
	}
	return out;
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
// Throttling (429/503) and the gateway errors MusicBrainz sits behind (500/502/504, seen on
// 2026-10-15 during the TRA-463 review) are transient: same backoff for all of them.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
let retryQueue = Promise.resolve();
// 2026-10-14 (TRA-450): MusicBrainz policy is 1 request/second per client, and the ~4 000-call
// backfills would otherwise be rejected or banned. Every outgoing request (first attempts and
// retries alike) reserves the next slot at least `minIntervalMs` after the previous one.
// Reservations are made synchronously in arrival order and are strictly increasing, so the
// timers fire FIFO. Read at call time so tests can change it; 0 disables spacing.
let lastSlotAt = 0;

function reserveSlotDelayMs(): number {
	const interval = musicBrainzConfig.minIntervalMs;
	if (interval <= 0) return 0;
	const now = Date.now();
	const at = Math.max(now, lastSlotAt + interval);
	lastSlotAt = at;
	return at - now;
}

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

// `fetchImpl` is injectable so callers outside this module (the image resolver, TRA-465) can be
// tested without stubbing the global; it defaults to the global fetch read at call time.
async function mbFetch<T>(
	path: string,
	params: Record<string, string>,
	fetchImpl: typeof fetch = fetch,
): Promise<T | null> {
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
		// Wait for the slot before arming the abort timer so queueing never eats the fetch timeout.
		await sleep(reserveSlotDelayMs());
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
		try {
			const r = await fetchImpl(url, {
				headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
				signal: ctrl.signal,
			});
			if (RETRYABLE_STATUSES.has(r.status) && attempt < MB_MAX_ATTEMPTS - 1) {
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

async function searchArtists(q: string, limit: number, failOnUnavailable = false): Promise<CatalogResult[]> {
	const query = buildMbQuery(q);
	if (!query) return [];
	const artists = parseArtists(await mbFetch<unknown>("/artist", { query, limit: String(limit) }));
	if (!artists) return unavailableOrEmpty(failOnUnavailable);
	return artists
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

async function searchReleaseGroups(
	q: string,
	limit: number,
	failOnUnavailable = false,
): Promise<CatalogResult[]> {
	const query = buildMbQuery(q);
	if (!query) return [];
	// Lucene filter: only Album / Single / EP (matches our original SQLite filter).
	const filtered = `(${query}) AND (primarytype:Album OR primarytype:Single OR primarytype:EP)`;
	const releaseGroups = parseReleaseGroups(
		await mbFetch<unknown>("/release-group", {
			query: filtered,
			limit: String(limit),
		}),
	);
	if (!releaseGroups) return unavailableOrEmpty(failOnUnavailable);
	return releaseGroups.map((rg) => {
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

async function searchRecordings(
	q: string,
	limit: number,
	failOnUnavailable = false,
): Promise<CatalogResult[]> {
	const query = buildMbQuery(q);
	if (!query) return [];
	const recordings = parseRecordings(
		await mbFetch<unknown>("/recording", {
			query,
			limit: String(limit),
		}),
	);
	if (!recordings) return unavailableOrEmpty(failOnUnavailable);
	return recordings.map((rec) => {
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

const WIKIDATA_QID_PATH = /^\/(?:wiki|entity)\/(Q[1-9]\d*)$/;

/**
 * Wikidata QID of an artist or label, read from its MusicBrainz url-rels (TRA-465).
 *
 * url-rels are user-editable third-party data: only an https `wikidata.org` link of relation type
 * "wikidata" whose path is exactly `/wiki/Q…` or `/entity/Q…` yields a QID, anything else is null.
 * Null as well when MusicBrainz is unreachable or the entity has no Wikidata link.
 */
export async function fetchWikidataUrlRelMb(
	entity: "artist" | "label",
	mbid: string,
	fetchImpl?: typeof fetch,
): Promise<string | null> {
	const data = await mbFetch<{ relations?: MbUrlRelation[] }>(
		`/${entity}/${mbid}`,
		{ inc: "url-rels" },
		fetchImpl,
	);
	if (!data || !Array.isArray(data.relations)) return null;
	for (const rel of data.relations) {
		if (rel?.type !== "wikidata") continue;
		const resource = rel.url?.resource;
		if (typeof resource !== "string") continue;
		let u: URL;
		try {
			u = new URL(resource);
		} catch {
			continue;
		}
		if (u.protocol !== "https:" || (u.hostname !== "www.wikidata.org" && u.hostname !== "wikidata.org")) {
			continue;
		}
		const qid = WIKIDATA_QID_PATH.exec(u.pathname)?.[1];
		if (qid) return qid;
	}
	return null;
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
	/** `credit` is the release group's artist credit, [] when MB gave none we can trust. */
	notableReleases: { mbid: string; title: string; firstReleaseDate: string; credit: MbCredit[] }[];
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
 * Fetch the artist entity itself — name, country/area, disambiguation. Mirrors
 * fetchLabelEntityMb above; added for TRA-XXX (2026-09-17) after a --genre-seeds crawl
 * wrote several homonym mismatches under artist slugs (e.g. artist:tracy-onne, a Spanish
 * makina DJ per MB's disambiguation, got materialized as Tracy Lawrence, the US country
 * singer). Country/area and disambiguation let researchTarget pin the search query to the
 * exact artist the MBID names, the same way the label block already does. Returns null on
 * lookup failure — caller treats as soft (non-fatal).
 */
export interface MbArtistEntity {
	mbid: string;
	name: string;
	country: string | null;
	area: string | null;
	disambiguation: string | null;
	/**
	 * MB `type` folded to what the graph cares about: a person or a group (band, orchestra, choir),
	 * null when MB gives another type or none. Optional only so the hand-built MbArtistEntity fixture
	 * in test/pipeline-e2e.test.ts (outside TRA-452's scope) still typechecks; fetchArtistEntityMb
	 * always sets it, and readers should treat absent like null.
	 */
	kind?: MbArtistKind | null;
}
export type MbArtistKind = "person" | "group";

function artistKind(type: unknown): MbArtistKind | null {
	if (type === "Person") return "person";
	if (type === "Group" || type === "Orchestra" || type === "Choir") return "group";
	return null;
}

export async function fetchArtistEntityMb(artistMbid: string): Promise<MbArtistEntity | null> {
	interface ArtistEntityResp {
		id: string;
		name: string;
		type?: string;
		country?: string;
		area?: { name?: string };
		disambiguation?: string;
	}
	const data = await mbFetch<ArtistEntityResp>(`/artist/${artistMbid}`, {});
	if (!data?.id) return null;
	return {
		mbid: data.id,
		name: data.name,
		country: data.country ?? null,
		area: data.area?.name ?? null,
		disambiguation: data.disambiguation ?? null,
		kind: artistKind(data.type),
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
			"artist-credit"?: unknown;
		}[];
	}
	const [artistResp, rgResp] = await Promise.all([
		mbFetch<ArtistBrowseResp>("/artist", { label: labelMbid, limit: "100" }),
		// `inc=artist-credits` is what makes the browse endpoint return each group's credit.
		mbFetch<RGBrowseResp>("/release-group", { label: labelMbid, limit: "100", inc: "artist-credits" }),
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
			credit: toCredits(rg["artist-credit"]),
		});
	}
	return out;
}

/** @deprecated Use {@link resolveRecording}: it checks the exact title and returns the artist credit. */
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
 *
 * @deprecated Use {@link resolveReleaseGroup}. This one takes `results[0]` without comparing
 * titles: on 2026-10-14 "New Forms" resolved to "New Forms²" (both score 100, the sequel first).
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

export interface MbReleaseIdentity {
	mbid: string;
	title: string;
	/** Credited artists that carry an MBID, in MB order. "Various Artists" is a valid credit. */
	credit: MbCredit[];
	/** Release groups only; recordings have no primary type. */
	primaryType: string | null;
	firstReleaseDate: string | null;
}

/** Drop the two characters that would break out of a Lucene phrase; same policy as the older finders. */
function lucenePhrase(text: string): string {
	return text.replace(/["\\]/g, "").trim();
}

/**
 * An artist name reduced to what makes two spellings the same artist: normalizeSlugBody (case,
 * diacritics, "&" == "and", trailing disambiguation) plus a leading "The" ("The Beatles" == "Beatles").
 * A name with a letter normalizeSlugBody would erase ("Mø" -> "m", "Группа X" -> "x", "坂本龍一" -> "")
 * is compared literally (NFKC, case-folded), like sameArtistName does for artists: else unrelated artists
 * get one key. Used for EQUALITY only, never for containment; an empty key matches nothing.
 * Dropping a leading "The" is deliberately symmetric, hint and credit alike: "The Prodigy" now equals
 * "Prodigy" (main refused it), though a distinct "Prodigy" exists (Mobb Deep). Accepted (TRA-537 review):
 * the Lucene `artist:` filter already keeps such a candidate out of the hits, and the tolerance for
 * "The" is one the project asked to keep.
 */
function creditKey(name: string): string {
	if (hasUnfoldableLetter(name)) return name.normalize("NFKC").trim().toLowerCase();
	const body = normalizeSlugBody(name);
	return body.startsWith("the-") ? body.slice(4) : body;
}

/** Names of the credited artist's aliases, from an untrusted search hit: anything that is not a name is dropped. */
function aliasNames(entry: MbArtistCreditEntry): string[] {
	const aliases = entry.artist?.aliases;
	if (!Array.isArray(aliases)) return [];
	return aliases.flatMap((a) => (isRecord(a) && typeof a.name === "string" ? [a.name] : []));
}

const JOINT_NAME_SEPARATOR = /\s*(?:&|\+|\/|,|\band\b|\bfeat\.?|\bfeaturing\b|\bwith\b)\s*/iu;

/**
 * True when the hint is a whole segment of a joint name in the credit ("Alva Noto" in "Alva Noto +
 * Ryuichi Sakamoto", "Roni Size" in "Roni Size / Reprazent"), cut on & + / , and feat. with. Never an
 * acceptance: it only keeps a set-aside candidate from disappearing. "Prince" is no segment of
 * "Prince Buster", "Fire" is one of "Earth, Wind & Fire" (a doubt, so ambiguous, never a match).
 */
function creditNamesHintAsSegment(entries: MbArtistCreditEntry[], hintKey: string): boolean {
	return entries.some((e) =>
		[e.name, e.artist?.name].some((n) =>
			(n?.split(JOINT_NAME_SEPARATOR) ?? []).some((part) => creditKey(part) === hintKey),
		),
	);
}

/**
 * True when the requested artist IS one of the credited artists: the key of the hint equals the key of a
 * credit entry (credited-as name or canonical name), or of the whole credit read as one string.
 * Containment is refused on purpose (2026-10-15, TRA-537, found in the TRA-477 deep review): "Prince"
 * was contained in "Prince Buster", and an identity established that way rewrites the source node's edge.
 * Joint credits: MB lists "Prince" and "The Revolution" as two credited artists, and each is an artist
 * credited on the work, so "Prince" matches. A joint name MB files as ONE artist ("Prince and the
 * Revolution" has its own MBID) is another artist than "Prince" and is refused; asking for the joint name
 * itself matches that entry, or the joined credit ("Prince & The Revolution" over two entries).
 * Every credited artist counts, whatever the join phrase: a featured artist ("Beyoncé feat. Jay-Z") is
 * credited on the work, so asking for Jay-Z matches. Callers read the credit the resolver returns.
 * An alias of a credited artist (when the hit carries them) is a name of that same artist, so it counts.
 */
function creditEqualsHint(entries: MbArtistCreditEntry[], hintKey: string): boolean {
	if (!hintKey) return false;
	// MB's `artist:` search field does not index aliases, so an alias only turns a printed credit that
	// already contains the hint into an equality. Some aliases are the truncated form of the name itself
	// ("Cam" for "DJ Cam", "Noto" for "Alva Noto"; 12 distinct artists are named "Cam"): an alias that is a
	// run of whole words strictly inside the printed or canonical name of the same entry is ignored,
	// or containment would be back (TRA-537 review). "Sasha + John Digweed" for "Sasha & John Digweed" stays.
	const isTruncation = (alias: string, e: MbArtistCreditEntry) =>
		[e.name, e.artist?.name].some((n) => {
			if (n === undefined) return false;
			const outer = creditKey(n);
			return outer !== alias && ` ${outer.replace(/-/g, " ")} `.includes(` ${alias.replace(/-/g, " ")} `);
		});
	if (
		entries.some((e) =>
			aliasNames(e).some((alias) => {
				const key = creditKey(alias);
				return key === hintKey && !isTruncation(key, e);
			}),
		)
	)
		return true;
	// Credited-as name, then canonical name: the hint may be either spelling.
	const projections = [(e: MbArtistCreditEntry) => e.name, (e: MbArtistCreditEntry) => e.artist?.name];
	return projections.some((nameOf) => {
		if (entries.some((e) => creditKey(nameOf(e) ?? "") === hintKey)) return true;
		if (entries.length < 2) return false;
		const names = entries.map(nameOf);
		if (names.some((n) => n === undefined)) return false;
		const joined = entries.map(
			(e, i) => `${names[i]}${typeof e.joinphrase === "string" ? e.joinphrase : ""}`,
		);
		return creditKey(joined.join("")) === hintKey;
	});
}

type Pick<T> = { kind: "one"; candidate: T } | { kind: "none" } | { kind: "ambiguous" };

/** True when `a` is a strictly earlier date than `b`: "1999" is not earlier than "1999-05-03" (same year). */
function strictlyEarlier(a: string, b: string): boolean {
	return a < b && !b.startsWith(a);
}

/**
 * Choose the candidate MB actually means. Never defaults to the first result: MB ranks "New Forms²"
 * and "New Forms" both at 100, and returns up to 8 look-alikes of one title and one credit in an order
 * that changes from one request to the next (2026-10-15, TRA-474 review: Kraftwerk's "Autobahn" came
 * back as a Detroit live recording, Zero 7's "Destiny" alternated between the album track and a
 * DJ-mix, "Windowlicker" met a 2026 EP credited to a fake "Aphex Twin"). So:
 * 1. keep only candidates whose normalized title equals the requested one. Titles go through
 *    normalizeTitleBody, NOT normalizeSlugBody: the latter drops a trailing "(...)", which made
 *    "Fitna (Live)" == "Fitna" and "Get Lucky (Daft Punk Remix)" == "Get Lucky" (TRA-452 review,
 *    2026-10-15) so the credit step could return the live or remixed version. Edition noise
 *    ("Kid A (Deluxe Edition)", "(2019 Remaster)", "(feat. X)") is ignored on purpose: it names
 *    the same work, and MB catalogues the bare title as one release group;
 * 2. among them, ALL whose credit equals the hint (see creditEqualsHint: equality of normalized names
 *    on each credited artist, never containment). A hint that no credit equals gives "none": the work
 *    is credited to someone else ("Prince" asked, "Prince Buster" credited). TRA-537 removed the old
 *    fallback to the single exact-title candidate, which resolved exactly that case. Without a hint,
 *    the single exact-title candidate wins (more than one = ambiguous);
 * 3. recordings carrying a non-empty `disambiguation` (live, DJ-mix, video...) are set aside; exactly
 *    one must remain. Release groups have no such note: the one with the strictly earliest
 *    first-release-date among the dated ones wins (a later EP or compilation of the same title does
 *    not), a tie or no date at all is ambiguous.
 * Ambiguous is not "none": the caller keeps the two apart.
 */
function pickByTitleAndCredit<
	T extends {
		id: string;
		title: string;
		disambiguation?: string | undefined;
		"first-release-date"?: string | undefined;
		"artist-credit"?: MbArtistCreditEntry[] | undefined;
	},
>(
	candidates: T[],
	title: string,
	artistHint: string | undefined,
	kind: "release-group" | "recording",
): Pick<T> {
	const wanted = normalizeTitleBody(title);
	if (!wanted) return { kind: "none" };
	const exact = candidates.filter((c) => normalizeTitleBody(c.title) === wanted);
	const hasHint = artistHint !== undefined && artistHint.trim() !== "";
	const hint = hasHint ? creditKey(artistHint) : "";
	// A hint that reduces to nothing ("!!!") can match no credit: never read it as "no hint" (code review,
	// TRA-537), which would take the lone exact-title candidate whatever its credit.
	if (hasHint && hint === "") return { kind: "none" };
	// With a hint, only a candidate credited to that artist can be the work; without one the title alone decides.
	const pool = hasHint ? exact.filter((c) => creditEqualsHint(c["artist-credit"] ?? [], hint)) : exact;
	if (pool.length === 0) return { kind: "none" };
	if (!hasHint && pool.length > 1) return { kind: "ambiguous" };
	// An exact-title candidate set aside because its credit is a group or duo that NAMES the artist
	// ("Alva Noto + Ryuichi Sakamoto") must not vanish silently: it may be the canonical work, and the
	// candidate that stays alone a non-canonical duplicate (2026-10-15, TRA-537 review: "Uoon II" resolved
	// to the 2022 duplicate credited [Sakamoto][Alva Noto]; a reissue beat the original the same way).
	// Doubt is "ambiguous", as before TRA-537. Segments are used to refuse only, never to accept.
	if (
		hasHint &&
		exact.some((c) => !pool.includes(c) && creditNamesHintAsSegment(c["artist-credit"] ?? [], hint))
	) {
		return { kind: "ambiguous" };
	}

	if (kind === "recording") {
		const plain = pool.filter((c) => (c.disambiguation ?? "").trim() === "");
		const only = plain[0];
		if (plain.length > 1) return { kind: "ambiguous" };
		return only ? { kind: "one", candidate: only } : { kind: "none" };
	}
	const only = pool[0];
	if (pool.length === 1 && only) return { kind: "one", candidate: only };
	const dated = pool.filter((c) => (c["first-release-date"] ?? "") !== "");
	const earliest = [...dated].sort((a, b) =>
		(a["first-release-date"] ?? "").localeCompare(b["first-release-date"] ?? ""),
	)[0];
	const earliestDate = earliest?.["first-release-date"] ?? "";
	const strict =
		earliest !== undefined &&
		dated.every((c) => c === earliest || strictlyEarlier(earliestDate, c["first-release-date"] ?? ""));
	return strict && earliest ? { kind: "one", candidate: earliest } : { kind: "ambiguous" };
}

function luceneQuery(
	field: "releasegroup" | "recording",
	title: string,
	artistHint: string | undefined,
): string | null {
	// A title with nothing left after normalization ("!!!") can never be verified against a result.
	// The phrase is built from the title minus its edition noise, keeping case and spacing: MB files
	// "Kid A" once, so querying the full "Kid A (Deluxe Edition)" may not return it (TRA-494).
	const phrase = lucenePhrase(stripEditionNoise(title));
	if (!phrase || !normalizeTitleBody(title)) return null;
	// Same for the hint: a punctuation-only hint would only narrow the search to nothing.
	const hint = artistHint && normalizeSlugBody(artistHint) ? lucenePhrase(artistHint) : "";
	return hint ? `${field}:"${phrase}" AND artist:"${hint}"` : `${field}:"${phrase}"`;
}

/** MB's maximum page: the whole result set of a title search, so that no look-alike hides past the page. */
const WORK_SEARCH_LIMIT = "100";

/**
 * True when MB announces more matches (`count`) than the page holds. Picking among a truncated page
 * is picking blind: the candidate left out may be the studio recording, or the earlier release
 * (2026-10-15, TRA-474 re-review: "To Hell with Good Intentions", count 13 of 8 received, resolved to
 * the compilation's recording in one run out of twelve).
 */
function isTruncated(body: unknown, received: number): boolean {
	return isRecord(body) && typeof body.count === "number" && body.count > received;
}

/**
 * What a resolver found: the work, or nothing. 2026-10-15 (TRA-505): the backfill filed "MusicBrainz did
 * not answer" under "no match" (null for both), so an outage became a verdict that --resume never
 * revisited. A null identity is now told apart three ways: `ambiguous`
 * ("several look-alikes"), `unavailable` (MB did not give a usable answer: HTTP error, network error,
 * unreadable or off-schema JSON; says nothing about the work, so a caller must retry rather than
 * conclude) and neither (MB answered and knows no such work).
 */
export interface MbWorkResolution {
	identity: MbReleaseIdentity | null;
	ambiguous: boolean;
	unavailable: boolean;
}

/**
 * Resolve a project title (plus an optional credited-artist hint) to the one MB release group it
 * names, with its artist credit. Null identity when MB is unreachable (`unavailable`), answers garbage
 * (`unavailable`), or nothing can be singled out; `ambiguous` is true when several candidates fit equally.
 */
export async function resolveReleaseGroupDetailed(
	title: string,
	artistHint?: string,
): Promise<MbWorkResolution> {
	const none: MbWorkResolution = { identity: null, ambiguous: false, unavailable: false };
	const query = luceneQuery("releasegroup", title, artistHint);
	if (!query) return none;
	const body = await mbFetch<unknown>("/release-group", { query, limit: WORK_SEARCH_LIMIT });
	const releaseGroups = parseReleaseGroups(body);
	// mbFetch gives null for an HTTP error, a network error and a body that is not JSON; the parser
	// gives null for JSON off schema. All four are an outage, not a verdict.
	if (!releaseGroups) return { ...none, unavailable: true };
	if (isTruncated(body, releaseGroups.length)) return { ...none, ambiguous: true };
	const picked = pickByTitleAndCredit(releaseGroups, title, artistHint, "release-group");
	if (picked.kind !== "one") return { ...none, ambiguous: picked.kind === "ambiguous" };
	const rg = picked.candidate;
	return {
		ambiguous: false,
		unavailable: false,
		identity: {
			mbid: rg.id,
			title: rg.title,
			credit: toCredits(rg["artist-credit"]),
			primaryType: rg["primary-type"] ?? null,
			firstReleaseDate: rg["first-release-date"] || null,
		},
	};
}

/** Recording counterpart of {@link resolveReleaseGroupDetailed}; `primaryType` is always null. */
export async function resolveRecordingDetailed(
	title: string,
	artistHint?: string,
): Promise<MbWorkResolution> {
	const none: MbWorkResolution = { identity: null, ambiguous: false, unavailable: false };
	const query = luceneQuery("recording", title, artistHint);
	if (!query) return none;
	const body = await mbFetch<unknown>("/recording", { query, limit: WORK_SEARCH_LIMIT });
	const recordings = parseRecordings(body);
	if (!recordings) return { ...none, unavailable: true };
	if (isTruncated(body, recordings.length)) return { ...none, ambiguous: true };
	const picked = pickByTitleAndCredit(recordings, title, artistHint, "recording");
	if (picked.kind !== "one") return { ...none, ambiguous: picked.kind === "ambiguous" };
	const rec = picked.candidate;
	return {
		ambiguous: false,
		unavailable: false,
		identity: {
			mbid: rec.id,
			title: rec.title,
			credit: toCredits(rec["artist-credit"]),
			primaryType: null,
			firstReleaseDate: rec["first-release-date"] || null,
		},
	};
}

/** {@link resolveReleaseGroupDetailed} without the flags: null means "do not use". */
export async function resolveReleaseGroup(
	title: string,
	artistHint?: string,
): Promise<MbReleaseIdentity | null> {
	return (await resolveReleaseGroupDetailed(title, artistHint)).identity;
}

export async function resolveRecording(
	title: string,
	artistHint?: string,
): Promise<MbReleaseIdentity | null> {
	return (await resolveRecordingDetailed(title, artistHint)).identity;
}

/** Valid "member of band" relations out of an untrusted `relations` array, deduplicated by MBID. */
function parseMemberships(relations: unknown[]): { groups: MbCredit[]; members: MbCredit[] } {
	const out: { groups: MbCredit[]; members: MbCredit[] } = { groups: [], members: [] };
	const seen = { groups: new Set<string>(), members: new Set<string>() };
	for (const relation of relations) {
		if (!isRecord(relation) || relation.type !== "member of band") continue;
		const side =
			relation.direction === "forward" ? "groups" : relation.direction === "backward" ? "members" : null;
		const [credit] = toCredits([{ artist: relation.artist }]);
		if (!side || !credit || seen[side].has(credit.mbid)) continue;
		seen[side].add(credit.mbid);
		out[side].push(credit);
	}
	return out;
}

/**
 * Band membership of an artist, from MB "member of band" relations. `groups` are the bands this
 * artist belongs to (relation direction "forward"); `members` are the people in this artist, when
 * it is a band ("backward"). Malformed relations are skipped; any failure yields empty lists.
 */
export async function fetchArtistMembershipsMb(
	artistMbid: string,
): Promise<{ groups: MbCredit[]; members: MbCredit[] }> {
	// The MBID is interpolated into the request path, so refuse anything that is not a bare UUID.
	if (!isMbid(artistMbid)) return { groups: [], members: [] };
	const body = await mbFetch<unknown>(`/artist/${artistMbid}`, { inc: "artist-rels" });
	if (!isRecord(body) || !Array.isArray(body.relations)) return { groups: [], members: [] };
	return parseMemberships(body.relations);
}

export interface MbArtistProfile {
	/** The MBID MB answered with: differs from the one asked for when that MBID was merged into another. */
	mbid: string;
	name: string;
	kind: MbArtistKind | null;
	disambiguation: string | null;
	area: string | null;
	groups: MbCredit[];
}

/**
 * Identity and bands of one artist in a single request (`?inc=artist-rels`). Unlike
 * {@link fetchArtistMembershipsMb}, a failure is null, never an empty list: a caller that stores the
 * answer must not mistake "MB did not answer" (502, timeout, malformed body) for "no bands". The
 * `relations` array is always present in a good answer, even when empty.
 */
export async function fetchArtistProfileMb(artistMbid: string): Promise<MbArtistProfile | null> {
	if (!isMbid(artistMbid)) return null;
	const body = await mbFetch<unknown>(`/artist/${artistMbid}`, { inc: "artist-rels" });
	if (!isRecord(body) || !isMbid(body.id) || !isText(body.name) || !Array.isArray(body.relations))
		return null;
	return {
		mbid: body.id,
		name: body.name,
		kind: artistKind(body.type),
		disambiguation: textOf(body.disambiguation),
		area: isRecord(body.area) ? textOf(body.area.name) : null,
		groups: parseMemberships(body.relations).groups,
	};
}

export interface MbArtistIdentity {
	mbid: string;
	/** MB's canonical name, possibly in the original script ("坂本龍一"): never a source for a slug. */
	name: string;
	kind: MbArtistKind | null;
	disambiguation: string | null;
	area: string | null;
}

/** Hint words that say what the hint is, not who the artist is ("song by Bob Dylan"), plus filler. */
const HINT_STOPWORDS = new Set([
	...["song", "track", "album", "band", "the", "and", "from", "with", "music", "city", "state", "states"],
	...["united", "kingdom", "republic", "north", "south", "east", "west", "new", "group", "duo"],
]);

// Countries come in many spellings between a node's `origin` ("Leeds, England", "Olympia, Washington,
// U.S.") and MB's area / disambiguation ("United Kingdom", "UK", "Türkiye"): both sides are folded
// to one token per country, otherwise "United Kingdom" and "United States" would share "united".
const COUNTRY_PHRASES: [RegExp, string][] = [
	[/\b(?:united kingdom|great britain|northern ireland)\b/g, "gbr"],
	[/\bunited states(?: of america)?\b/g, "usa"],
];
const COUNTRY_WORDS: Record<string, string> = {
	...Object.fromEntries(
		["uk", "england", "scotland", "wales", "britain", "british", "english", "scottish", "welsh"].map((w) => [
			w,
			"gbr",
		]),
	),
	...Object.fromEntries(["us", "usa", "america", "american"].map((w) => [w, "usa"])),
	...Object.fromEntries(["turkey", "turkiye", "turkish"].map((w) => [w, "tur"])),
	french: "france",
	german: "germany",
	japanese: "japan",
	swedish: "sweden",
	canadian: "canada",
	italian: "italy",
	spanish: "spain",
	dutch: "netherlands",
	russian: "russia",
	polish: "poland",
	brazilian: "brazil",
	australian: "australia",
	irish: "ireland",
	belgian: "belgium",
	norwegian: "norway",
	danish: "denmark",
	finnish: "finland",
	portuguese: "portugal",
	jamaican: "jamaica",
};
/** MB `country` codes worth reading as context when MB gives no area name. */
const COUNTRY_CODES: Record<string, string> = {
	GB: "gbr",
	US: "usa",
	TR: "tur",
	FR: "france",
	DE: "germany",
	JP: "japan",
	SE: "sweden",
	CA: "canada",
	IT: "italy",
	ES: "spain",
	NL: "netherlands",
	AU: "australia",
};

/** Lowercase, accent-free, country-folded words (>= 3 chars) of free text, minus filler. */
function contextWords(text: string): string[] {
	let s = text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/(?<=\p{L})\.(?=\p{L})/gu, "")
		.replace(/(?<=\p{L})\./gu, "");
	for (const [pattern, token] of COUNTRY_PHRASES) s = s.replace(pattern, ` ${token} `);
	const words = s.split(/[^\p{L}\p{N}]+/u).map((w) => COUNTRY_WORDS[w] ?? w);
	return [...new Set(words.filter((w) => w.length >= 3 && !HINT_STOPWORDS.has(w)))];
}

/**
 * True when a name keeps a letter that is not a-z once accents are stripped ("坂本龍一", "Группа", but
 * also "ø", "ł", "ß", which NFKD does not decompose): slug normalization would erase it.
 */
function hasUnfoldableLetter(name: string): boolean {
	return /\p{L}/u.test(name.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[a-z]/gi, ""));
}

/**
 * Name identity between a requested artist name and an MB name or alias. Latin names compare through
 * normalizeSlugBody (case, accents, punctuation, "&"). A name with letters it would erase compares
 * literally (NFKC, case-folded) instead: normalizeSlugBody reduces "坂本龍一" to "" and "Группа X" to "x",
 * and, with the slug transliteration off (default), "Mø" to "m", which would make unrelated artists equal.
 * With ODYSSEY_SCOPED_RELEASE_SLUGS on (TRA-528) "Mø" becomes "mo", but the guard stays: it does not read
 * the flag, so a name with "ø" is compared literally either way ("Mø" vs "Mo" is false, "Mø" vs "MØ"
 * true). Stricter than the slug, never looser.
 */
function sameArtistName(a: string, b: string): boolean {
	if (hasUnfoldableLetter(a) || hasUnfoldableLetter(b)) {
		const fold = (s: string) => s.normalize("NFKC").trim().toLowerCase();
		return fold(a) !== "" && fold(a) === fold(b);
	}
	const na = normalizeSlugBody(a);
	return na !== "" && na === normalizeSlugBody(b);
}

interface MbArtistSearchHit {
	identity: MbArtistIdentity;
	aliases: string[];
	/**
	 * Words of MB's disambiguation, area, begin-area, end-area and country: what a node's hints are
	 * compared to when a lone candidate is accepted or refused. It can refuse; it never separates.
	 */
	context: Set<string>;
	/**
	 * Words of the areas MB types as anything but `Country` (a city, a subdivision, an island): the only
	 * words that tell homonyms apart. Empty when MB gives no area or no type.
	 */
	places: Set<string>;
	/** The words of `places` that come from an area typed `City`: what a partial pool is trusted on. */
	cities: Set<string>;
}

function textOf(value: unknown): string | null {
	return isText(value) ? value : null;
}

/**
 * Tokens that name a country, once folded by {@link contextWords}: "gbr" / "usa" / "tur" (England,
 * Scotland, "UK", "U.S.", "Türkiye"...), the country each demonym folds to, the codes MB gives, plus
 * countries that have no spelling variant to fold. They filter the words of a node's `origin` only: MB
 * names areas below `Country` after countries too (Western Australia, "Ciudad de México", the city of
 * Luxembourg), so a country word of the origin would otherwise match them (TRA-508 review: Keith
 * Richards, Nico). A defense in depth: the origin's place words are already its first segment only.
 */
const COUNTRY_TOKENS: ReadonlySet<string> = new Set([
	"gbr",
	"usa",
	"tur",
	...Object.values(COUNTRY_WORDS),
	...Object.values(COUNTRY_CODES),
	...["mexico", "argentina", "chile", "colombia", "peru", "cuba", "india", "china", "korea", "taiwan"],
	...["indonesia", "thailand", "vietnam", "philippines", "israel", "egypt", "nigeria", "ghana", "kenya"],
	...["morocco", "algeria", "tunisia", "senegal", "mali", "ethiopia", "iceland", "switzerland", "austria"],
	...["greece", "hungary", "romania", "bulgaria", "serbia", "croatia", "slovenia", "slovakia", "czechia"],
	...["ukraine", "lithuania", "latvia", "estonia", "luxembourg", "zealand", "africa", "jamaica", "iran"],
	...["kazakhstan", "congo", "australia", "venezuela", "ecuador", "bolivia", "uruguay", "paraguay"],
]);

/** An MB area type that can name a place; `Country` and an unknown type cannot. */
function isPlaceType(type: string | null): boolean {
	return type !== null && type.trim().toLowerCase() !== "country";
}

/** MB area keys of an artist search hit: where it lives, where it began, where it ended. */
const ARTIST_AREA_KEYS = ["area", "begin-area", "end-area"] as const;

/** One page of an artist search: well-formed hits, the `count` MB reports, which entries came. */
interface ArtistSearchPage {
	hits: MbArtistSearchHit[];
	/** Every result MB holds for the query, of which a page returns at most `limit`. */
	count: number;
	/** Entries in the page, malformed or special-purpose ones included. */
	received: number;
	/**
	 * The ids of the entries in the page, null for an entry without a text id. MB's offset paging is not
	 * stable among results of equal score: an entry can come on two pages while another never comes.
	 */
	ids: (string | null)[];
}

/**
 * Well-formed search hits; malformed entries are dropped one by one. The score is deliberately unused.
 * Null when the body is not a search answer at all, `count` included: without it a page cannot be known
 * to be the whole pool.
 */
function parseArtistSearchHits(body: unknown): ArtistSearchPage | null {
	if (!isRecord(body) || !Array.isArray(body.artists)) return null;
	if (typeof body.count !== "number" || !Number.isInteger(body.count) || body.count < 0) return null;
	const hits: MbArtistSearchHit[] = [];
	for (const raw of body.artists) {
		if (!isRecord(raw) || !isMbid(raw.id) || !isText(raw.name) || SPECIAL_PURPOSE_MBIDS.has(raw.id)) continue;
		const disambiguation = textOf(raw.disambiguation);
		const areaOf = (key: (typeof ARTIST_AREA_KEYS)[number]) => {
			const area = raw[key];
			const name = isRecord(area) ? textOf(area.name) : null;
			return isRecord(area) && name !== null ? { name, type: textOf(area.type) } : null;
		};
		const areas = ARTIST_AREA_KEYS.flatMap((key) => areaOf(key) ?? []);
		const code = typeof raw.country === "string" ? COUNTRY_CODES[raw.country] : undefined;
		const aliases = Array.isArray(raw.aliases)
			? raw.aliases.flatMap((alias) => (isRecord(alias) && isText(alias.name) ? [alias.name] : []))
			: [];
		hits.push({
			identity: {
				mbid: raw.id,
				name: raw.name,
				kind: artistKind(raw.type),
				disambiguation,
				area: areaOf("area")?.name ?? null,
			},
			aliases,
			context: new Set(
				[disambiguation, ...areas.map((a) => a.name), code ?? null].flatMap((text) =>
					text === null ? [] : contextWords(text),
				),
			),
			// An area of unknown type is not a place: it might be a country MB left untyped.
			places: new Set(areas.filter((a) => isPlaceType(a.type)).flatMap((a) => contextWords(a.name))),
			cities: new Set(
				areas.filter((a) => a.type?.trim().toLowerCase() === "city").flatMap((a) => contextWords(a.name)),
			),
		});
	}
	return {
		hits,
		count: body.count,
		received: body.artists.length,
		ids: body.artists.map((raw) => (isRecord(raw) ? textOf(raw.id) : null)),
	};
}

/** Words (>= 3 chars) of the hints, country-folded, minus filler, deduplicated. */
function hintWords(hints: readonly (string | undefined)[]): string[] {
	return [...new Set(hints.flatMap((hint) => (hint ? contextWords(hint) : [])))];
}

/**
 * The words of a node's `origin` that can name a place: its first segment ("Sydney" of "Sydney,
 * Australia", "Guadalajara" of "Guadalajara, Jalisco, Mexico"), minus country tokens. Segments are cut at
 * `,` `;` and `/`. Later segments are regions and countries, and MB areas below `Country` bear their
 * names ("Western Australia"). An origin of a single segment gives no word at all: it is most often a
 * country, and the countries no list names ("Georgia", "Lebanon", "Panama") would match an MB area
 * (a US state, a city) the same way (2026-10-15, TRA-508 re-review). A bare city is lost on purpose.
 */
function originPlaceWords(origin: string | undefined): string[] {
	const segments = (origin ?? "").split(/[,;/]/).filter((segment) => segment.trim() !== "");
	const [first] = segments;
	return first && segments.length > 1 ? contextWords(first).filter((w) => !COUNTRY_TOKENS.has(w)) : [];
}

/**
 * What the pool's candidates are chosen with. `words` are all the node's hint words (disambiguator and
 * origin): they can only refuse a lone candidate. `origin` are {@link originPlaceWords}: the only words
 * that can separate homonyms, and only against {@link MbArtistSearchHit.places}.
 */
interface ArtistHints {
	words: string[];
	origin: string[];
}

/**
 * The one candidate MB means, with the hint words that decided it, or null.
 *
 * Several exact homonyms: the one whose places (areas MB does not type `Country`) share strictly more
 * words with the node's origin than every other, and at least one. Neither a country, nor MB's
 * disambiguation, nor the node's free-text disambiguator separates homonyms: the real "Aphex Twin" has
 * no country in its MB context while the impostor "UK experimental electronic artist" has one and the
 * word "electronic" (2026-10-15, TRA-506 and TRA-508 reviews: "Cornwall, England", then
 * "electronic musician", made the impostor win). MB's side drops `Country` areas by type (no list of
 * countries to keep: Kazakhstan, Georgia and Puerto Rico used to slip through one); the node's side
 * keeps the first segment of its origin only, without country tokens, because MB names areas below
 * `Country` after countries ("Western Australia" took Keith Richards, "Ciudad de México" took Nico).
 *
 * A single candidate is accepted unless the node has hints and MB has a context for it and the two share
 * no word: a different artist of the same name (post-punk "113" from Leeds vs the French rap group). No
 * hint, or no MB context, means nothing can contradict it. When the pool is incomplete (MB holds more
 * results than were read), a candidate proves little about the unread ones: it must be the only one of
 * the pool read to share a place with the node's origin, and share it through an area typed `City`.
 * (Not required of a complete pool: MB types Tokyo, Coventry or Kingston as subdivisions.)
 */
function pickByHints(
	pool: MbArtistSearchHit[],
	hints: ArtistHints,
	complete: boolean,
): { hit: MbArtistSearchHit; matched: string[] } | null {
	const sharedPlaces = (hit: MbArtistSearchHit) => hints.origin.filter((w) => hit.places.has(w));
	const sharesCity = (hit: MbArtistSearchHit) => hints.origin.some((w) => hit.cities.has(w));
	const [only] = pool;
	if (pool.length === 1 && only) {
		const common = hints.words.filter((w) => only.context.has(w));
		if (hints.words.length > 0 && only.context.size > 0 && common.length === 0) return null;
		if (complete) return { hit: only, matched: common };
		const places = sharedPlaces(only);
		return places.length > 0 && sharesCity(only) ? { hit: only, matched: places } : null;
	}
	const scored = pool
		.map((hit) => ({ hit, shared: sharedPlaces(hit) }))
		.sort((a, b) => b.shared.length - a.shared.length);
	const [best, runnerUp] = scored;
	if (!best || best.shared.length === 0 || runnerUp?.shared.length === best.shared.length) return null;
	if (!complete && ((runnerUp?.shared.length ?? 0) > 0 || !sharesCity(best.hit))) return null;
	return { hit: best.hit, matched: best.shared };
}

export interface MbArtistResolution {
	artist: MbArtistIdentity | null;
	/** Exact-name candidates found (any search score): 0 unknown to MB, 1 sole, > 1 homonyms. */
	candidates: number;
	/** Where the candidates came from: canonical names, or (only when none matched) aliases. */
	path: "name" | "alias" | null;
	/** True when a search got no usable answer, which says nothing about the artist. */
	unavailable: boolean;
	/**
	 * The hint words that chose the artist, for audit: the places shared with the node's origin when
	 * homonyms were told apart, else the hint words shared with MB's context. Empty when nothing was
	 * chosen, or when the node gave no hint.
	 */
	matchedWords: string[];
}

/** MB's page size for a search, and the offset past which it answers HTTP 400. */
const MB_SEARCH_PAGE = 100;
const MB_SEARCH_MAX_OFFSET = 500;

/**
 * The hits of an artist search, paged until MB's `count` is read or its offset cap (500 results) is
 * reached: at most 5 requests. Hits are deduplicated by MBID: MB's offset paging repeats an entry among
 * results of equal score and then never serves another (2026-10-15, TRA-508 review: "Sylvester", 154
 * entries for 149 distinct ones). `complete` is true only when the distinct entries reach MB's `count`,
 * so any such loss leaves the pool incomplete. Null when any page got no usable answer: a pool missing
 * a page would pass for a smaller one.
 */
async function searchArtistPool(
	field: "artist" | "alias",
	phrase: string,
): Promise<{ hits: MbArtistSearchHit[]; complete: boolean } | null> {
	const hits: MbArtistSearchHit[] = [];
	const seen = new Set<string>();
	let anonymous = 0;
	let count = 0;
	for (let offset = 0; offset < MB_SEARCH_MAX_OFFSET; offset += MB_SEARCH_PAGE) {
		const page = parseArtistSearchHits(
			await mbFetch<unknown>("/artist", {
				query: `${field}:"${phrase}"`,
				limit: String(MB_SEARCH_PAGE),
				offset: String(offset),
			}),
		);
		if (!page) return null;
		if (offset === 0) count = page.count;
		for (const id of page.ids) {
			if (id === null) anonymous++;
			else seen.add(id);
		}
		for (const hit of page.hits) {
			if (!hits.some((h) => h.identity.mbid === hit.identity.mbid)) hits.push(hit);
		}
		if (seen.size + anonymous >= count || page.received < MB_SEARCH_PAGE) break;
	}
	return { hits, complete: seen.size + anonymous >= count };
}

/**
 * Resolve an artist name to the one MB artist it names, or to nothing: an unresolved artist keeps
 * its slug and gets no MBID, whereas a wrong MBID would graft another artist's identity onto the
 * node (2026-10-15, TRA-463 review: Leeds post-punk "113" became the French rap group, DJ "Jaguar"
 * became a heavy metal band). So:
 * 1. the pool is every returned artist whose canonical name equals the requested one, whatever its
 *    search score (MB scores "Earth", the right one, at 89) and however it ranks. The search is paged
 *    ({@link searchArtistPool}): 25 results hid every homonym of "Guy" but one (2026-10-15, TRA-508);
 * 2. only when no canonical name matches, a second `alias:` search is made (the `artist:` field does
 *    not index aliases: "Ryuichi Sakamoto" never finds 坂本龍一) and artists carrying the name as an
 *    alias form the pool;
 * 3. {@link pickByHints} chooses within the pool, or refuses.
 */
export async function resolveArtistDetailed(
	name: string,
	hints: { disambiguator?: string; origin?: string } = {},
): Promise<MbArtistResolution> {
	const none: MbArtistResolution = {
		artist: null,
		candidates: 0,
		path: null,
		unavailable: false,
		matchedWords: [],
	};
	const phrase = lucenePhrase(name);
	if (!phrase) return none;
	const found = await searchArtistPool("artist", phrase);
	if (!found) return { ...none, unavailable: true };
	let path: "name" | "alias" = "name";
	let complete = found.complete;
	let pool = found.hits.filter((h) => sameArtistName(h.identity.name, name));
	if (pool.length === 0) {
		const aliasFound = await searchArtistPool("alias", phrase);
		if (!aliasFound) return { ...none, unavailable: true };
		path = "alias";
		// A name search that left results unread may hide exact-name artists the alias pool must not outrank.
		complete = complete && aliasFound.complete;
		pool = aliasFound.hits.filter((h) => h.aliases.some((alias) => sameArtistName(alias, name)));
	}
	if (pool.length === 0) return none;
	const picked = pickByHints(
		pool,
		{ words: hintWords([hints.disambiguator, hints.origin]), origin: originPlaceWords(hints.origin) },
		complete,
	);
	return {
		artist: picked?.hit.identity ?? null,
		candidates: pool.length,
		path,
		unavailable: false,
		matchedWords: picked?.matched ?? [],
	};
}

export async function resolveArtist(
	name: string,
	hints: { disambiguator?: string; origin?: string } = {},
): Promise<MbArtistIdentity | null> {
	return (await resolveArtistDetailed(name, hints)).artist;
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
	return (await fetchTrackMetaDetailedMb(recordingMbid)).meta;
}

/**
 * What a metadata lookup found, and whether MB failed to answer part of it (2026-10-15, TRA-505: the
 * backfill wrote an mbid beside a hollow tracklist after an outage, and the work left the pending list
 * for good). `unavailable` is true when
 * any request got no usable answer (HTTP error, network error, unreadable or non-object JSON): the
 * `meta` then lacks what that request would have given, which a caller writing it to disk must not
 * mistake for a work that has no such data. A work MB knows to have none (no release) is not unavailable.
 */
export interface MbMetaLookup<T> {
	meta: T;
	unavailable: boolean;
}

/** {@link fetchTrackMetaMb} that also says whether MB failed to answer. */
export async function fetchTrackMetaDetailedMb(recordingMbid: string): Promise<MbMetaLookup<MbTrackMeta>> {
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
	// The recording lookup always carries a `releases` array (empty when MB knows none): a body without
	// one is not MB's answer (a proxy's error page, a truncated cache entry).
	if (!rec || Array.isArray(rec) || !Array.isArray(rec.releases)) return { meta: empty, unavailable: true };
	let unavailable = false;
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
		// `||`, not `??`: MB sends "date": "" for an undated edition, which must sort last, not first.
		const ad = a.date || a["release-events"]?.[0]?.date || "9999";
		const bd = b.date || b["release-events"]?.[0]?.date || "9999";
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
		// `label-info` is always there under `inc=labels` (empty for a release without label).
		if (!rel || Array.isArray(rel) || !Array.isArray(rel["label-info"])) unavailable = true;
		const firstLabel = (Array.isArray(rel?.["label-info"]) ? rel["label-info"] : []).find(
			(li) => li.label && li.label.name,
		)?.label;
		if (firstLabel) out.label = { mbid: firstLabel.id, name: firstLabel.name };
	}
	out.producers = [...producersMap.values()];
	const prodIdsT = new Set(out.producers.map((p) => p.mbid));
	out.personnel = [...personnelMap.values()].filter((p) => !prodIdsT.has(p.mbid));
	return { meta: out, unavailable };
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
	return (await fetchProjectMetaDetailedMb(rgMbid)).meta;
}

/** {@link fetchProjectMetaMb} that also says whether MB failed to answer. */
export async function fetchProjectMetaDetailedMb(rgMbid: string): Promise<MbMetaLookup<MbProjectMeta>> {
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
	if (!rg || Array.isArray(rg) || !Array.isArray(rg.releases)) return { meta: empty, unavailable: true };
	// An empty release list is an answer: MB knows the group and it has no release to read. A release
	// entry without an id is not (off schema).
	if (rg.releases.length === 0) return { meta: empty, unavailable: false };
	const releases = [...rg.releases].sort((a, b) => {
		// `||`, not `??`: MB sends "date": "" for an undated edition, which must sort last, not first.
		const ad = a.date || a["release-events"]?.[0]?.date || "9999";
		const bd = b.date || b["release-events"]?.[0]?.date || "9999";
		return ad.localeCompare(bd);
	});
	const releaseId = releases[0]?.id;
	if (!releaseId) return { meta: empty, unavailable: true };
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
	// `media` is always there under `inc=recordings` (empty for a release without track).
	if (!rel || Array.isArray(rel) || !Array.isArray(rel.media)) return { meta: empty, unavailable: true };
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
	return { meta: out, unavailable: false };
}

function unavailableOrEmpty(failOnUnavailable: boolean): CatalogResult[] {
	if (failOnUnavailable) throw new MusicBrainzCatalogUnavailableError();
	return [];
}

export function createMusicBrainzCatalog(options: MusicBrainzCatalogOptions = {}): CatalogIndex {
	const failOnUnavailable = options.failOnUnavailable ?? false;
	return {
		async search(query, limit = 5) {
			const per = Math.max(2, Math.ceil(limit / 2));
			const [artists, projects, tracks] = await Promise.all([
				searchArtists(query, per, failOnUnavailable),
				searchReleaseGroups(query, per, failOnUnavailable),
				searchRecordings(query, per, failOnUnavailable),
			]);
			return interleave([artists, projects, tracks]).slice(0, limit * 3);
		},
		async searchByType(type, query, limit = 8) {
			if (type === "artist") return searchArtists(query, limit, failOnUnavailable);
			if (type === "project") return searchReleaseGroups(query, limit, failOnUnavailable);
			if (type === "track") return searchRecordings(query, limit, failOnUnavailable);
			return [];
		},
		close() {},
	};
}
