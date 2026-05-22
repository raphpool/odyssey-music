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

const SEARCH_URL = "https://itunes.apple.com/search";
const REQUEST_TIMEOUT_MS = 5000;

interface ITunesResult {
	artworkUrl100?: string;
	collectionName?: string;
	artistName?: string;
}

interface ITunesResponse {
	resultCount?: number;
	results?: ITunesResult[];
}

/**
 * Look up an album/EP's cover art on iTunes Search and return a 1500×1500 URL.
 * `artistName` (when known) sharply improves match precision.
 *
 * Returns null when iTunes can't find a confident match or the network fails —
 * the caller decides what to do (e.g. fall back to a related node's cover).
 */
export async function lookupAlbumArt(name: string, artistName?: string): Promise<string | null> {
	const term = [name, artistName].filter(Boolean).join(" ");
	if (!term.trim()) return null;
	const url = `${SEARCH_URL}?term=${encodeURIComponent(term)}&entity=album&limit=1`;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const r = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		if (!r.ok) return null;
		const body = (await r.json()) as ITunesResponse;
		const art = body.results?.[0]?.artworkUrl100;
		if (!art) return null;
		// Default `100x100bb` thumbnail → ask for 1500×1500. iTunes serves any size we put here.
		return art.replace("100x100bb", "1500x1500bb");
	} catch {
		return null;
	}
}
