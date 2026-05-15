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
	process.env.MB_USER_AGENT ?? "odyssey-music/0.1 (hfontanier@gmail.com; https://dropcliffs.com/labs/odyssey)";
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
	return ac.map((c) => c.name ?? c.artist?.name ?? "").filter(Boolean).join(", ");
}

function fmtLength(ms: number | undefined): string | undefined {
	if (!ms || ms <= 0) return undefined;
	const sec = Math.round(ms / 1000);
	return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
}

/**
 * Build an MB Lucene query for prefix-style autocomplete. We escape Lucene metachars
 * and append `*` to the last token. MB's search is Lucene under the hood, so this
 * behaves like our previous FTS5 prefix-match.
 */
function buildMbQuery(q: string): string {
	const cleaned = q.replace(/[+\-!(){}\[\]^"~*?:\\/]/g, " ").trim();
	if (!cleaned) return "";
	const tokens = cleaned.split(/\s+/);
	return tokens
		.map((t, i) => (i === tokens.length - 1 ? `${t}*` : t))
		.join(" ");
}

async function mbFetch<T>(path: string, params: Record<string, string>): Promise<T | null> {
	const url = new URL(`${MB_BASE}${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	url.searchParams.set("fmt", "json");
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const r = await fetch(url, {
			headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
			signal: ctrl.signal,
		});
		if (!r.ok) {
			console.warn(`[mb] ${r.status} ${url.pathname}`);
			return null;
		}
		return (await r.json()) as T;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.warn(`[mb] fetch failed ${url.pathname}: ${msg}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function searchArtists(q: string, limit: number): Promise<CatalogResult[]> {
	const query = buildMbQuery(q);
	if (!query) return [];
	const body = await mbFetch<{ artists: MbArtist[] }>("/artist", { query, limit: String(limit) });
	if (!body?.artists) return [];
	return body.artists.map((a) => {
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
