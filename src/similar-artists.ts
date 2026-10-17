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

// 2026-10-17 (TRA-603, review of the repository run of TRA-490, 127 artists served by the graph fallback,
// 24 false edges out of about 90). The first scoring was 3 per common collaborator, 2 per common label, 1 per
// common genre, any score above 0 kept, ties broken alphabetically. One wide genre or one major label was
// enough: Kabza De Small got 7 false edges out of 10 (generic house), The Peech Boys 7 (the Island catalogue),
// Gucci Mane 4 (Aretha Franklin, Chic), Ralf Hutter -> Calvin Harris, Schoenberg -> Paul McCartney; and the
// alphabetical tie-break put "A Guy Called Gerald" in 32 of the 127 lists.
//
// A first fix weighed a genre by 1 / log2(1 + n). Measured on the cache the same day it was too severe and
// still wrong: Burial lost Joy Orbison and Loefah (two niche genres, 0.48 < 2) while Gucci Mane kept Aretha
// Franklin, Chic and Bernard Edwards through Atlantic Records (11 artists, under the cap of a major). What
// separates a real neighbour from a false one is not how rare a genre is but whether it is a niche at all, and
// that a label alone proves nothing: a label only counts between artists who also share a niche genre.
//
// The second fix (one niche genre at 40 carriers) gave 2 false edges instead of 24, but the review of the same
// day listed the good neighbours it lost: Sean Booth without Rob Brown (the other half of Autechre), Steve
// Rutter without Mike Golding (B12), Boris without Sunn O))), Mayhem without Darkthrone, Guy without Bell Biv
// DeVoe, Killer Kau without Kabza De Small, and idm (45 carriers) and ambient (41) cut off in a cache centred on
// electronic music. Hence the direct link between two artists (a duo must not lose its other half) and tiers of
// genre specificity: 10 carriers or fewer is a niche that says enough on its own (black metal, new jack swing,
// noise rock, amapiano), up to 60 it is a weak link that needs a second one, above it says nothing.
// A genre is counted without the artist itself, so that a new sheet (not yet in the cache) and the backfill
// (where it is) get the same answer.

/** A genre carried by at most this many artists of `others` (the artist excluded) is a niche: weight 2, enough alone. */
export const GENRE_NICHE_MAX_CARRIERS = 10;
/** A genre carried by more than this many artists of `others` (the artist excluded) is too wide to say anything: weight 0. */
export const GENRE_MAX_CARRIERS = 60;
/** A label cited by at most this many artists of `others` is an indie; more is a major (Island, Columbia): weight 0. */
export const LABEL_MAX_CARRIERS = 15;
/** Weight of a common collaborator, and of a direct link between the two artists; either is enough on its own. */
export const COLLABORATOR_WEIGHT = 3;
/** Weight of a common niche genre (GENRE_NICHE_MAX_CARRIERS carriers or fewer): enough on its own. */
export const NICHE_GENRE_WEIGHT = 2;
/** Weight of a common genre carried by GENRE_NICHE_MAX_CARRIERS + 1 to GENRE_MAX_CARRIERS artists: needs a second link. */
export const GENRE_WEIGHT = 1;
/** Weight of a common indie label (see LABEL_MAX_CARRIERS), counted only when a genre of at most GENRE_MAX_CARRIERS is also common. */
export const LABEL_WEIGHT = 2;
/** Without a collaborator link, a candidate needs at least this score: one genre of 11 to 60 carriers (1) is not enough. */
export const MIN_GRAPH_SCORE = 2;

function countCarriers(sets: readonly ReadonlySet<string>[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const set of sets) for (const slug of set) counts.set(slug, (counts.get(slug) ?? 0) + 1);
	return counts;
}

/**
 * Artists of `others` that share structure with `artist`. A collaborator link weighs 3, once: a common
 * collaborator (each one counts) or a direct one, the candidate in `artist.collaborators` or the artist in
 * `candidate.collaborators`. A common genre weighs 2 if at most GENRE_NICHE_MAX_CARRIERS artists of `others`
 * carry it, 1 up to GENRE_MAX_CARRIERS, else 0. A common label weighs 2 if at most LABEL_MAX_CARRIERS artists
 * of `others` cite it, else 0, and only when a genre of at most GENRE_MAX_CARRIERS is also common: a label
 * alone never makes two artists similar. The artist itself is not counted among the carriers. A candidate is
 * kept only with a collaborator link or a score of MIN_GRAPH_SCORE or more, so the list may be shorter than
 * 10, or empty. Ordered by score desc, then number of common genres desc, then name asc. The artist, its
 * aliases and its members never appear. Deliberately one-way: no inverse edge is implied.
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

	// One pass to dedupe `others` (it may be a one-shot iterable) and one to count who carries what.
	const unique = new Map<
		string,
		{ node: ArtistNode; collaborators: Set<string>; labels: Set<string>; genres: Set<string> }
	>();
	for (const other of others) {
		if (!unique.has(other.slug)) {
			unique.set(other.slug, {
				node: other,
				collaborators: slugSet(other.collaborators),
				labels: slugSet(other.labels),
				genres: slugSet(other.genres),
			});
		}
	}
	const counted = [...unique.values()].filter((u) => u.node.slug !== artist.slug);
	const labelCarriers = countCarriers(counted.map((u) => u.labels));
	const genreCarriers = countCarriers(counted.map((u) => u.genres));

	const ranked: { candidate: SimilarCandidate; commonGenres: number }[] = [];
	for (const [
		slug,
		{ node, collaborators: otherCollaborators, labels: otherLabels, genres: otherGenres },
	] of unique) {
		if (excluded.has(slug)) continue;
		const commonCollaborators = countCommon(collaborators, otherCollaborators);
		const directLink = collaborators.has(slug) || otherCollaborators.has(artist.slug);
		const collaboratorLink = commonCollaborators > 0 || directLink;
		let commonGenres = 0;
		let genreScore = 0;
		let reliableGenre = false;
		for (const genre of genres) {
			if (!otherGenres.has(genre)) continue;
			commonGenres++;
			const carriers = genreCarriers.get(genre) ?? 0;
			if (carriers <= GENRE_NICHE_MAX_CARRIERS) genreScore += NICHE_GENRE_WEIGHT;
			else if (carriers <= GENRE_MAX_CARRIERS) genreScore += GENRE_WEIGHT;
			if (carriers <= GENRE_MAX_CARRIERS) reliableGenre = true;
		}
		let score = COLLABORATOR_WEIGHT * commonCollaborators + genreScore;
		if (directLink) score += COLLABORATOR_WEIGHT;
		if (reliableGenre) {
			for (const label of labels) {
				if (otherLabels.has(label) && (labelCarriers.get(label) ?? 0) <= LABEL_MAX_CARRIERS) {
					score += LABEL_WEIGHT;
				}
			}
		}
		if (!collaboratorLink && score < MIN_GRAPH_SCORE) continue;
		const candidate: SimilarCandidate = { name: node.name, score, slug: node.slug };
		if (node.mbid) candidate.mbid = node.mbid;
		ranked.push({ candidate, commonGenres });
	}
	return ranked
		.sort(
			(a, b) =>
				b.candidate.score - a.candidate.score ||
				b.commonGenres - a.commonGenres ||
				(a.candidate.name < b.candidate.name ? -1 : a.candidate.name > b.candidate.name ? 1 : 0),
		)
		.map((r) => r.candidate);
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
