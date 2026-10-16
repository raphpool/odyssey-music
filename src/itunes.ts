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
	releaseDate: z.string().optional(),
});
const albumSearchResponseSchema = z.object({ results: z.array(z.unknown()) });

const MZSTATIC_SUFFIX = ".mzstatic.com";
const THUMBNAIL_SIZE = /100x100bb/;

/**
 * Edition suffixes that may trail a title without making it another release: the cover is the
 * same record, only the tracklist or the mastering differs. Matched on the already-normalized
 * token string, so "(Deluxe Edition)", "[Deluxe Edition]" and "- Deluxe Edition" are one case.
 * Deliberately NOT here: anything with a number ("2009 Remaster", "20th Anniversary Edition",
 * "Vol. 2", "II"), because a number is how a sequel or a different release announces itself, and
 * anything unknown ("Live", "Instrumentals", "Remixes"): when in doubt, no image (TRA-589).
 */
const EDITION_SUFFIXES = [
	"deluxe edition",
	"deluxe version",
	"deluxe",
	"expanded edition",
	"expanded",
	"special edition",
	"bonus track version",
	"bonus edition",
	"remastered edition",
	"remastered version",
	"remastered",
	"remaster",
];

/**
 * Canonical form of an album title for EQUALITY (not overlap): accents, case, punctuation and
 * `&`/`and` are folded away, trailing known edition suffixes are dropped, and nothing else is.
 * This does not reuse `normalizeTokens`, which drops tokens shorter than two characters (so the
 * "3" of "Clicks & Cuts 3" vanished) and ignores every bracketed group (so "(Vol. 2)" did too).
 */
function canonicalAlbumTitle(raw: string): string {
	let t = raw
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/['\u2019`]/g, "")
		.replace(/&/g, " and ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
	for (let stripped = true; stripped; ) {
		stripped = false;
		for (const suffix of EDITION_SUFFIXES) {
			if (t.endsWith(` ${suffix}`)) {
				t = t.slice(0, -(suffix.length + 1)).trim();
				stripped = true;
				break;
			}
		}
	}
	return t;
}

/**
 * "Various Artists" and its variants ("Various", "VA", "V.A.", "V/A"). A compilation credit
 * verifies nothing about the artist, and iTunes files other people's releases under it
 * (TRA-589: "Clicks & Cuts" resolved to a Various Artists series). Any credit that contains the
 * token "various" is refused, which also refuses a real artist literally named so: no image is
 * the price of a safe rule.
 */
function isVariousArtists(raw: string): boolean {
	const tokens = raw
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
	return tokens.includes("various") || tokens.join(" ") === "va" || tokens.join(" ") === "v a";
}

/**
 * Canonical form of an artist credit for EQUALITY: accents, case, punctuation and `&`/`and` folded,
 * nothing else. "Terry Riley" and "Daniel Brandell, Horn Ensemble D3 & Terry Riley" are different
 * credits: a recording by someone else that merely features the artist is another recording of the
 * work (TRA-595).
 */
function canonicalArtist(raw: string): string {
	return raw
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/['\u2019`]/g, "")
		.replace(/&/g, " and ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** First standalone 4-digit run of a year-ish string ("1976", "c. 1976", "1976-03-01T08:00:00Z"). */
function parseYear(raw: string | undefined): number | null {
	const m = raw ? /(?<!\d)(\d{4})(?!\d)/.exec(raw) : null;
	return m?.[1] ? Number(m[1]) : null;
}

/** Release years further apart than this are two different releases (year-end reissues stay in). */
const MAX_YEAR_GAP = 1;

export interface AlbumArtOptions {
	/**
	 * Year of the node being resolved (`year` of a project, or of the track's project). When it holds a
	 * year, an iTunes release must be within `MAX_YEAR_GAP` of it. Absent or without a 4-digit year:
	 * the year is not checked.
	 */
	year?: string | undefined;
}

/**
 * Cover art for an album, but only from a result whose collection name AND artist name both match
 * what we asked for (TRA-465). iTunes returns plausible-looking strangers for a text query, so
 * this reads `limit=5` results and takes the best verified one, never
 * `results[0]`. Both names are required: without a known artist nothing can be verified, so null.
 *
 * Verified means, all of:
 *   - the title is EQUAL once normalized (case, accents, punctuation, `&`/`and`) and stripped of
 *     trailing edition suffixes from `EDITION_SUFFIXES`. A longer title that merely contains the
 *     asked one is another release: "Clicks & Cuts" never retains "Clicks & Cuts 3". The rule is
 *     a whitelist: "Album (Deluxe Edition)" retains "Album", but an unknown or numbered
 *     suffix ("Vol. 2", "2009 Remaster", "Live") does not;
 *   - neither the asked artist nor the result's artist is "Various Artists" (a compilation is
 *     not verifiable; the request is not even sent);
 *   - the artist credit is EQUAL to the asked artist once normalized (TRA-595): a credit that merely
 *     contains the artist, or lists several, is another recording of the work ("In C" by
 *     "Daniel Brandell, Horn Ensemble D3 & Terry Riley", 2020);
 *   - when `options.year` holds a year, the iTunes release year is within one year of it, and a
 *     result without a readable `releaseDate` is refused (Music for 18 Musicians: ECM 1978 yes,
 *     Nonesuch 1998 no). Among the verified results the closest year wins; if the best distance is
 *     shared by results with different artwork, nothing is retained (an undecidable tie is no
 *     image). Without a node year every verified result is at distance 0, so the same tie rule
 *     applies: two exact-credit releases with different artwork and nothing to tell them apart.
 * The response is third-party data: schema-checked, and the artwork URL must be https on
 * `*.mzstatic.com` in the canonical form `isAllowedImageUrl` accepts.
 *
 * Returns a 600×600 URL, or null on no verified match, a malformed response or a network failure.
 */
export async function lookupVerifiedAlbumArt(
	title: string,
	artistName: string,
	fetchImpl: typeof fetch = fetch,
	options: AlbumArtOptions = {},
): Promise<string | null> {
	if (!title.trim() || !artistName.trim()) return null;
	if (isVariousArtists(artistName)) return null;
	const wantedTitle = canonicalAlbumTitle(title);
	const wantedArtist = canonicalArtist(artistName);
	if (!wantedTitle || !wantedArtist) return null;
	const wantedYear = parseYear(options.year);
	const term = `${title} ${artistName}`;
	const url = `${SEARCH_URL}?term=${encodeURIComponent(term)}&entity=album&limit=5`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const r = await fetchImpl(url, { signal: controller.signal });
		if (!r.ok) return null;
		const body = albumSearchResponseSchema.safeParse(await r.json());
		if (!body.success) return null;
		const verified: Array<{ art: string; gap: number }> = [];
		for (const raw of body.data.results) {
			const parsed = albumSearchResultSchema.safeParse(raw);
			if (!parsed.success) continue;
			const { artworkUrl100, collectionName, artistName: resultArtist, releaseDate } = parsed.data;
			if (!artworkUrl100 || !collectionName || !resultArtist) continue;
			if (isVariousArtists(resultArtist)) continue;
			if (canonicalArtist(resultArtist) !== wantedArtist) continue;
			if (canonicalAlbumTitle(collectionName) !== wantedTitle) continue;
			if (nameMatchScore(collectionName, title, undefined) === null) continue;
			let gap = 0;
			if (wantedYear !== null) {
				const year = parseYear(releaseDate);
				if (year === null) continue;
				gap = Math.abs(year - wantedYear);
				if (gap > MAX_YEAR_GAP) continue;
			}
			const art = toHighResArtwork(artworkUrl100);
			if (!art) continue;
			verified.push({ art, gap });
		}
		if (verified.length === 0) return null;
		const closest = Math.min(...verified.map((v) => v.gap));
		const arts = new Set(verified.filter((v) => v.gap === closest).map((v) => v.art));
		// Two different pictures at the same distance: nothing tells the recordings apart, so no image.
		return arts.size === 1 ? (arts.values().next().value ?? null) : null;
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
