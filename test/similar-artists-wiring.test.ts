import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { CacheIndex } from "../src/cache-index.js";
import { listenBrainzConfig } from "../src/config.js";
import { makeSimilarArtistsResolver } from "../src/similar-artists-wiring.js";
import type { ArtistNode, EdgeRef, Slug } from "../src/types.js";

// TRA-480: the resolver handed to the pipeline. ListenBrainz is a stubbed fetch; the cache is a real
// NodeCache on a temp directory (we own it, so it is not mocked).

const SUBJECT_MBID = "f90e8b26-9e52-4669-a5c9-e28529c47894";
const LB_MBID = "164f0d73-1234-4e29-9e5f-0cc9bb7f8a57";
const suiteMinIntervalMs = listenBrainzConfig.minIntervalMs;
const NO_INDEX: CacheIndex = { byMbid: () => null, prefix: () => [], prefixByType: () => [] };

function artist(name: string, extra: Partial<ArtistNode> = {}): ArtistNode {
	return {
		slug: `artist:${name.toLowerCase().replace(/\W+/g, "-")}` as Slug,
		type: "artist",
		name,
		editorial_article: "A real long article about this artist, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_bio: "bio",
		citations: [{ url: "https://example.com/x" }],
		materialized_at: "2026-10-15T00:00:00.000Z",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
		...extra,
	};
}

const TECHNO: EdgeRef = { type: "genre", slug: "genre:techno" as Slug, name: "Techno" };

describe("makeSimilarArtistsResolver (TRA-480)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		listenBrainzConfig.minIntervalMs = 0;
		dir = await mkdtemp(join(tmpdir(), "odyssey-similar-wiring-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		listenBrainzConfig.minIntervalMs = suiteMinIntervalMs;
		await rm(dir, { recursive: true, force: true });
	});

	function lbFetch(status: number, body: unknown = []) {
		return vi.fn(async () => new Response(JSON.stringify(body), { status }));
	}

	it("returns the ListenBrainz edges for an artist with an mbid, without scanning the cache", async () => {
		const spy = vi.spyOn(cache, "listSlugs");
		const fetch = lbFetch(200, [{ artist_mbid: LB_MBID, name: "Autechre", score: 9 }]);
		const resolve = makeSimilarArtistsResolver({
			cache,
			getCacheIndex: async () => NO_INDEX,
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		const edges = await resolve(artist("Subject", { mbid: SUBJECT_MBID }));

		expect(edges).toEqual([{ slug: "artist:autechre", type: "artist", name: "Autechre", mbid: LB_MBID }]);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(spy).not.toHaveBeenCalled();
	});

	it("falls back to the graph, asking ListenBrainz only once, when it has nothing", async () => {
		await cache.write(artist("Peer", { genres: [TECHNO] }));
		await cache.write(artist("Stranger"));
		const fetch = lbFetch(503);
		const resolve = makeSimilarArtistsResolver({
			cache,
			getCacheIndex: async () => NO_INDEX,
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		const edges = await resolve(artist("Subject", { mbid: SUBJECT_MBID, genres: [TECHNO] }));

		expect(edges.map((e) => e.slug)).toEqual(["artist:peer"]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("uses the graph alone, with no network call, for an artist without mbid", async () => {
		await cache.write(artist("Peer", { genres: [TECHNO] }));
		const fetch = lbFetch(200);
		const resolve = makeSimilarArtistsResolver({
			cache,
			getCacheIndex: async () => NO_INDEX,
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		const edges = await resolve(artist("Subject", { genres: [TECHNO] }));

		expect(edges.map((e) => e.slug)).toEqual(["artist:peer"]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("returns [] on an empty cache and a ListenBrainz outage", async () => {
		const resolve = makeSimilarArtistsResolver({
			cache,
			getCacheIndex: async () => NO_INDEX,
			fetch: (async () => {
				throw new Error("offline");
			}) as unknown as typeof globalThis.fetch,
		});

		expect(await resolve(artist("Subject", { mbid: SUBJECT_MBID }))).toEqual([]);
	});
});
