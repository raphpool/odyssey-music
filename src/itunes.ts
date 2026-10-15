/**
 * Minimal iTunes Search API wrapper for resolving high-resolution album art.
 *
 * Why iTunes:
 *   - Public, no auth, no signup
 *   - 1500×1500 cover art via a trivial URL rewrite (100x100bb → 1500x1500bb)
 *   - Excellent coverage for commercial releases
 *
 * Limits:
 *   - Apple's rate limit is ~20 req/s per IP — fine for JIT (one call per focus).
 *     A bulk backfill needs its own pacing.
 *   - Artist artwork is not reliably returned (the `artworkUrl100` field is often
 *     empty or a generic placeholder). For artist nodes we prefer to surface one
 *     of their projects' covers instead, resolved upstream.
 *   - Out-of-catalog releases (small labels, white labels, dub plates) won't match.
 */

import { z } from "zod";
import { isAllowedImageUrl } from "./images/hosts.js";
import { nameMatchScore } from "./text-match.js";

const SEARCH_URL = "https://itunes.apple.com/search";
const REQUEST_TIMEOUT_MS = 5000;

interface ITunesResult {
	artworkUrl100?: string;
	collectionName?: string;
	artistName?: string;
	trackName?: string;
	artistId?: number;
	collectionId?: number;
	trackId?: number;
	artistLinkUrl?: string;
	collectionViewUrl?: string;
	trackViewUrl?: string;
}

interface ITunesResponse {
	resultCount?: number;
	results?: ITunesResult[];
}

/** iTunes `entity` values we ask for, one per Odyssey node type we can link. */
export type AppleEntity = "musicArtist" | "album" | "song";

export interface AppleCandidate {
	/** music.apple.com page for the entity, tracking params stripped. */
	url: string;
	id: number;
	/** Artist name / album title / song title, depending on the entity. */
	title: string;
	/** Credited artist. Absent for the musicArtist entity, where title IS the artist. */
	artistName?: string;
}

// Query params iTunes appends for attribution/analytics. Everything else is
// meaningful and must survive — in particular `i`, which is what makes a song
// URL a song URL: trackViewUrl is `…/album/windowlicker/281953326?i=281953327`,
// and dropping the query turns it into a link to the parent album instead.
const APPLE_TRACKING_PARAMS = ["uo", "at", "app", "ls", "itscg", "itsct", "ct"];

/**
 * Strip iTunes' affiliate/tracking params so the stored URL is the canonical
 * Apple Music page, while preserving the song selector.
 */
export function cleanAppleUrl(raw: string): string | null {
	try {
		const u = new URL(raw);
		if (u.protocol !== "https:" || u.hostname !== "music.apple.com") return null;
		for (const p of APPLE_TRACKING_PARAMS) u.searchParams.delete(p);
		return u.toString();
	} catch {
		return null;
	}
}

/**
 * Search the iTunes catalog and return Apple Music page candidates.
 *
 * This asks for several results and hands them back
 * unranked — the caller scores them against the expected name/artist, because
 * iTunes will confidently return "Volume II" for a query about the first
 * volume, and a wrong entity link is worse than no link at all.
 */
export async function searchAppleEntities(
	entity: AppleEntity,
	term: string,
	limit = 5,
): Promise<AppleCandidate[]> {
	if (!term.trim()) return [];
	const url = `${SEARCH_URL}?term=${encodeURIComponent(term)}&entity=${entity}&limit=${limit}`;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const r = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		if (!r.ok) return [];
		const body = (await r.json()) as ITunesResponse;
		const out: AppleCandidate[] = [];
		for (const res of body.results ?? []) {
			const mapped = toCandidate(entity, res);
			if (mapped) out.push(mapped);
		}
		return out;
	} catch {
		return [];
	}
}

function toCandidate(entity: AppleEntity, res: ITunesResult): AppleCandidate | null {
	if (entity === "musicArtist") {
		const url = res.artistLinkUrl ? cleanAppleUrl(res.artistLinkUrl) : null;
		if (!url || !res.artistId || !res.artistName) return null;
		return { url, id: res.artistId, title: res.artistName };
	}
	if (entity === "album") {
		const url = res.collectionViewUrl ? cleanAppleUrl(res.collectionViewUrl) : null;
		if (!url || !res.collectionId || !res.collectionName) return null;
		const c: AppleCandidate = { url, id: res.collectionId, title: res.collectionName };
		if (res.artistName) c.artistName = res.artistName;
		return c;
	}
	const url = res.trackViewUrl ? cleanAppleUrl(res.trackViewUrl) : null;
	if (!url || !res.trackId || !res.trackName) return null;
	const c: AppleCandidate = { url, id: res.trackId, title: res.trackName };
	if (res.artistName) c.artistName = res.artistName;
	return c;
}

const albumSearchResultSchema = z.object({
	artworkUrl100: z.string().optional(),
	collectionName: z.string().optional(),
	artistName: z.string().optional(),
});
const albumSearchResponseSchema = z.object({ results: z.array(z.unknown()) });

const MZSTATIC_SUFFIX = ".mzstatic.com";
const THUMBNAIL_SIZE = /100x100bb/;

/**
 * Cover art for an album, but only from a result whose collection name AND artist name both match
 * what we asked for (TRA-465). iTunes returns plausible-looking strangers for a text query, so
 * this reads `limit=5` results and takes the best verified one, never
 * `results[0]`. Both names are required: without a known artist nothing can be verified, so null.
 *
 * "Matches" is the threshold `src/streaming-links.ts` uses: `nameMatchScore` not null (every
 * significant token of the expected name has enough overlap, at least one token of the artist).
 * The response is third-party data: schema-checked, and the artwork URL must be https on
 * `*.mzstatic.com` in the canonical form `isAllowedImageUrl` accepts.
 *
 * Returns a 600×600 URL, or null on no verified match, a malformed response or a network failure.
 */
export async function lookupVerifiedAlbumArt(
	title: string,
	artistName: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	if (!title.trim() || !artistName.trim()) return null;
	const term = `${title} ${artistName}`;
	const url = `${SEARCH_URL}?term=${encodeURIComponent(term)}&entity=album&limit=5`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const r = await fetchImpl(url, { signal: controller.signal });
		if (!r.ok) return null;
		const body = albumSearchResponseSchema.safeParse(await r.json());
		if (!body.success) return null;
		let best: { art: string; score: number } | null = null;
		for (const raw of body.data.results) {
			const parsed = albumSearchResultSchema.safeParse(raw);
			if (!parsed.success) continue;
			const { artworkUrl100, collectionName, artistName: resultArtist } = parsed.data;
			if (!artworkUrl100 || !collectionName || !resultArtist) continue;
			const titleScore = nameMatchScore(collectionName, title, undefined);
			const artistScore = nameMatchScore(resultArtist, artistName, undefined);
			if (titleScore === null || artistScore === null) continue;
			const art = toHighResArtwork(artworkUrl100);
			if (!art) continue;
			if (!best || titleScore + artistScore > best.score) best = { art, score: titleScore + artistScore };
		}
		return best?.art ?? null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function toHighResArtwork(artworkUrl100: string): string | null {
	if (!THUMBNAIL_SIZE.test(artworkUrl100)) return null;
	let canonical: string;
	try {
		canonical = new URL(artworkUrl100.replace(THUMBNAIL_SIZE, "600x600bb")).href;
	} catch {
		return null;
	}
	if (!isAllowedImageUrl(canonical)) return null;
	const host = new URL(canonical).hostname;
	return host.endsWith(MZSTATIC_SUFFIX) && host.length > MZSTATIC_SUFFIX.length ? canonical : null;
}
