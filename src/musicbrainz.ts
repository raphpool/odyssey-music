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

const MB_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT =
	process.env.MB_USER_AGENT ??
	"odyssey-music/0.1 (hfontanier@gmail.com; https://dropcliffs.com/labs/odyssey)";
const FETCH_TIMEOUT_MS = 4000;

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
const MB_CACHE_TTL_MS = 5 * 60 * 1000;
const MB_CACHE_MAX = 500;

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

	// Retry on 503 with backoff. MB throttles aggressively during burst traffic; a short
	// retry with jitter usually clears it. We cap at 2 retries (3 total attempts) so we
	// don't pile on if MB is genuinely down.
	for (let attempt = 0; attempt < 3; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
		try {
			const r = await fetch(url, {
				headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
				signal: ctrl.signal,
			});
			if (r.status === 503 && attempt < 2) {
				const wait = 250 * 2 ** attempt + Math.random() * 100;
				await new Promise((res) => setTimeout(res, wait));
				continue;
			}
			if (!r.ok) {
				console.warn(`[mb] ${r.status} ${url.pathname}`);
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
			if (attempt === 2) console.warn(`[mb] fetch failed ${url.pathname}: ${msg}`);
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
	for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
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
			"secondary-types"?: string[];
		}[];
	}
	const data = await mbFetch<RGResp>(`/release-group`, {
		artist: artistMbid,
		type: "album",
		limit: String(limit),
	});
	if (!data || !Array.isArray(data["release-groups"])) return [];
	const out: MbReleaseGroupSummary[] = data["release-groups"].map((g) => ({
		mbid: g.id,
		title: g.title,
		firstReleaseDate: g["first-release-date"] ?? "",
		secondaryTypes: g["secondary-types"] ?? [],
	}));
	// Newest first.
	out.sort((a, b) => (b.firstReleaseDate || "").localeCompare(a.firstReleaseDate || ""));
	return out;
}

/** Resolve an artist name to its MBID via MB search. Returns the best match or null. */
export async function findArtistMbidByName(name: string, disambig?: string): Promise<string | null> {
	const q = disambig ? `${name} ${disambig}` : name;
	const results = await searchArtists(q, 3);
	return results[0]?.mbid ?? null;
}

export function openCatalogIndex(_unused?: string): CatalogIndex {
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
