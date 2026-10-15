/**
 * Similar artists (TRA-468, graph-integrity plan, part 4, decision 6).
 *
 * `similar_artists` is never produced by the LLM. It comes from ListenBrainz labs (free, keyless,
 * looked up by artist MBID) and, when that has nothing, from a score computed over the artists already
 * in the cache. Nothing here writes to the cache: callers attach the returned edges to the node.
 *
 * ListenBrainz is an untrusted third party with no SLA: the host is fixed, the response is validated,
 * no URL from it is ever propagated, and every failure collapses to an empty result (never a throw), so
 * a ListenBrainz outage can never fail a node.
 */

import { z } from "zod";
import type { CacheIndex } from "./cache-index.js";
import { listenBrainzConfig, musicBrainzConfig } from "./config.js";
import { logger } from "./logger.js";
import { makeSlug, normalizeSlugBody } from "./slug.js";
import type { ArtistNode, EdgeRef, Slug } from "./types.js";

const log = logger.child({ module: "similar-artists" });

export const MAX_SIMILAR_ARTISTS = 10;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_NAME_LENGTH = 200;
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SimilarCandidate {
	mbid?: string;
	name: string;
	score: number;
	/**
	 * Slug of an artist already in the cache. Set by the graph fallback, whose candidates ARE cached
	 * nodes (their real slug may carry a disambiguator that makeSlug(name) would not reproduce).
	 */
	slug?: Slug;
}

export type SimilarSource = "listenbrainz" | "graph" | "none";

// Only the fields we use are read; the rest of a row (comment, type, gender, ...) is dropped.
const lbRowSchema = z.object({
	artist_mbid: z.string().regex(MBID_PATTERN),
	name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
	score: z.number().finite(),
});

// 2026-10-15 (TRA-468): ListenBrainz allows 1 request/second. Same scheduler as MusicBrainz (TRA-450):
// every call reserves a slot at least `minIntervalMs` after the previous one, synchronously and in
// arrival order. Read at call time so tests can change it; 0 disables spacing.
let lastSlotAt = 0;

function reserveSlotDelayMs(): number {
	const interval = listenBrainzConfig.minIntervalMs;
	if (interval <= 0) return 0;
	const now = Date.now();
	const at = Math.max(now, lastSlotAt + interval);
	lastSlotAt = at;
	return at - now;
}

async function sleep(delayMs: number): Promise<void> {
	if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Candidates ListenBrainz considers similar to `mbid`, best score first. `[]` on a malformed MBID,
 * network error, timeout, non-2xx status, a body that is not a JSON array; rows that fail validation
 * are dropped individually.
 */
export async function fetchSimilarArtistsLb(
	mbid: string,
	deps: { fetch?: typeof fetch } = {},
): Promise<SimilarCandidate[]> {
	if (!MBID_PATTERN.test(mbid)) return [];
	const url = new URL("/similar-artists/json", listenBrainzConfig.baseUrl);
	url.searchParams.set("artist_mbids", mbid);
	url.searchParams.set("algorithm", listenBrainzConfig.algorithm);

	await sleep(reserveSlotDelayMs());
	// Armed after the slot wait so queueing never eats the fetch timeout.
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const doFetch = deps.fetch ?? globalThis.fetch;
		const r = await doFetch(url, {
			headers: { "User-Agent": musicBrainzConfig.userAgent, Accept: "application/json" },
			// A redirect would leave the fixed host.
			redirect: "error",
			signal: ctrl.signal,
		});
		if (!r.ok) {
			log.warn("request failed", { status: r.status, mbid });
			return [];
		}
		const body: unknown = await r.json();
		if (!Array.isArray(body)) {
			log.warn("unexpected response shape", { mbid });
			return [];
		}
		const candidates: SimilarCandidate[] = [];
		for (const row of body) {
			const parsed = lbRowSchema.safeParse(row);
			if (parsed.success) {
				candidates.push({ mbid: parsed.data.artist_mbid, name: parsed.data.name, score: parsed.data.score });
			}
		}
		// Stable sort: ties keep ListenBrainz order.
		return candidates.sort((a, b) => b.score - a.score);
	} catch (e) {
		log.warn("fetch failed", { mbid, error: e instanceof Error ? e.message : String(e) });
		return [];
	} finally {
		clearTimeout(timer);
	}
}

function slugSet(edges: readonly EdgeRef[]): Set<string> {
	return new Set(edges.map((e) => e.slug));
}

function countCommon(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	let n = 0;
	for (const s of a) if (b.has(s)) n++;
	return n;
}

/**
 * Artists of `others` that share structure with `artist`: 3 per common collaborator, 2 per common label,
 * 1 per common genre (by slug). The artist, its aliases and its members never appear; score 0 is
 * dropped; ordered by score desc then name asc. Deliberately one-way: no inverse edge is implied.
 */
export function computeSimilarFromGraph(
	artist: ArtistNode,
	others: Iterable<ArtistNode>,
): SimilarCandidate[] {
	const excluded = new Set<string>([
		artist.slug,
		...artist.aliases.map((e) => e.slug),
		...artist.members.map((e) => e.slug),
	]);
	const collaborators = slugSet(artist.collaborators);
	const labels = slugSet(artist.labels);
	const genres = slugSet(artist.genres);

	const seen = new Set<string>();
	const candidates: SimilarCandidate[] = [];
	for (const other of others) {
		if (excluded.has(other.slug) || seen.has(other.slug)) continue;
		seen.add(other.slug);
		const score =
			3 * countCommon(collaborators, slugSet(other.collaborators)) +
			2 * countCommon(labels, slugSet(other.labels)) +
			countCommon(genres, slugSet(other.genres));
		if (score <= 0) continue;
		const candidate: SimilarCandidate = { name: other.name, score, slug: other.slug };
		if (other.mbid) candidate.mbid = other.mbid;
		candidates.push(candidate);
	}
	return candidates.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// True when every letter of the name is Latin. makeSlug only keeps [a-z0-9], so a name in another
// script yields an empty (or, mixed with Latin, a truncated and collision-prone) slug body.
function isLatinName(name: string): boolean {
	return (name.match(/\p{L}/gu) ?? []).every((ch) => /\p{Script=Latin}/u.test(ch));
}

/**
 * The slug an edge to `candidate` must carry, or null when none can be trusted. A cached artist keeps
 * its slug; an unknown one gets makeSlug(name), but only for a Latin name: a slug is never derived from
 * a name in another script.
 */
function slugFor(candidate: SimilarCandidate, cacheIndex: CacheIndex): Slug | null {
	if (candidate.slug) return candidate.slug;
	if (candidate.mbid) {
		const cached = cacheIndex.byMbid(candidate.mbid);
		if (cached) return cached;
	}
	if (!isLatinName(candidate.name) || !normalizeSlugBody(candidate.name)) return null;
	return makeSlug("artist", candidate.name);
}

function toEdges(
	artist: ArtistNode,
	candidates: readonly SimilarCandidate[],
	cacheIndex: CacheIndex,
): EdgeRef[] {
	const excluded = new Set<string>([
		artist.slug,
		...artist.aliases.map((e) => e.slug),
		...artist.members.map((e) => e.slug),
	]);
	const edges: EdgeRef[] = [];
	for (const candidate of candidates) {
		if (edges.length >= MAX_SIMILAR_ARTISTS) break;
		const slug = slugFor(candidate, cacheIndex);
		if (!slug || excluded.has(slug)) continue;
		excluded.add(slug);
		const edge: EdgeRef = { slug, type: "artist", name: candidate.name };
		if (candidate.mbid) edge.mbid = candidate.mbid;
		edges.push(edge);
	}
	return edges;
}

/**
 * Up to 10 `similar_artists` edges for `artist`. ListenBrainz when the artist has an MBID and it yields
 * at least one usable edge; otherwise the graph fallback (also used directly, with no network call,
 * for an artist without MBID). `source` is "none" when neither produced anything.
 */
export async function resolveSimilarArtists(
	artist: ArtistNode,
	deps: { cacheIndex: CacheIndex; others: () => Iterable<ArtistNode>; fetch?: typeof fetch },
): Promise<{ edges: EdgeRef[]; source: SimilarSource }> {
	if (artist.mbid) {
		const lbDeps = deps.fetch ? { fetch: deps.fetch } : {};
		const edges = toEdges(artist, await fetchSimilarArtistsLb(artist.mbid, lbDeps), deps.cacheIndex);
		if (edges.length > 0) return { edges, source: "listenbrainz" };
	}
	const edges = toEdges(artist, computeSimilarFromGraph(artist, deps.others()), deps.cacheIndex);
	return { edges, source: edges.length > 0 ? "graph" : "none" };
}
