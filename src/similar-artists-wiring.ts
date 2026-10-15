/**
 * Wiring of `PipelineDeps.similarArtists` (TRA-480): `resolveSimilarArtists` (TRA-468) fed by a cache.
 *
 * Kept apart from the resolver so that the resolver stays free of cache I/O, and shared by the two
 * composition roots that materialize artists (the HTTP server and the crawl CLI).
 */

import type { NodeCache } from "./cache.js";
import type { CacheIndex } from "./cache-index.js";
import { logger } from "./logger.js";
import { resolveSimilarArtists } from "./similar-artists.js";
import type { ArtistNode, EdgeRef } from "./types.js";

const log = logger.child({ module: "similar-artists-wiring" });

// A burst of materializations (a crawl) falling back to the graph shares one scan of the cache.
const ARTIST_SCAN_TTL_MS = 60_000;

export function makeSimilarArtistsResolver(deps: {
	cache: Pick<NodeCache, "get" | "listSlugs">;
	getCacheIndex: () => Promise<CacheIndex>;
	fetch?: typeof fetch;
}): (artist: ArtistNode) => Promise<EdgeRef[]> {
	let scan: { at: number; artists: Promise<ArtistNode[]> } | undefined;

	// Built lazily: only an artist that ListenBrainz did not answer for needs the graph fallback, and a
	// node of another type never reaches this function.
	function cachedArtists(): Promise<ArtistNode[]> {
		const now = Date.now();
		if (scan && now - scan.at < ARTIST_SCAN_TTL_MS) return scan.artists;
		const artists = (async () => {
			const out: ArtistNode[] = [];
			for (const slug of await deps.cache.listSlugs()) {
				if (!slug.startsWith("artist:")) continue;
				try {
					const node = await deps.cache.get(slug);
					if (node.type === "artist") out.push(node);
				} catch (e) {
					log.warn("unreadable artist skipped", { slug, error: e instanceof Error ? e.message : String(e) });
				}
			}
			return out;
		})();
		scan = { at: now, artists };
		// A failed scan must not be served from the memo.
		artists.catch(() => {
			if (scan?.artists === artists) scan = undefined;
		});
		return artists;
	}

	return async (artist) => {
		const cacheIndex = await deps.getCacheIndex();
		const fetchDeps = deps.fetch ? { fetch: deps.fetch } : {};
		// Pass 1: ListenBrainz when the artist has an MBID. With no usable answer (or no MBID, so no
		// network call) it returns nothing from an empty graph, and the cache scan below is worth paying.
		const first = await resolveSimilarArtists(artist, { cacheIndex, others: () => [], ...fetchDeps });
		if (first.source === "listenbrainz") return first.edges;
		// Pass 2: graph only. The MBID is dropped so that ListenBrainz is not asked a second time.
		const { mbid: _asked, ...withoutMbid } = artist;
		const others = await cachedArtists();
		const second = await resolveSimilarArtists(withoutMbid, {
			cacheIndex,
			others: () => others,
			...fetchDeps,
		});
		return second.edges;
	};
}
