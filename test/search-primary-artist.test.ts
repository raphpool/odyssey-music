// TRA-547: catalog hits of a project/track expose the FIRST credited artist as `artist` (and
// `artist_slug` when that artist already is a canonical cache node), read from MusicBrainz's structured
// artist-credit -- never cut out of `subtitle`, the joined credit ("Earth, Wind & Fire" is one artist).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheIndex } from "../src/cache-index.js";
import { type CatalogIndex, type CatalogResult, createMusicBrainzCatalog } from "../src/musicbrainz.js";
import { createSearchService } from "../src/services/search-service.js";
import type { Slug } from "../src/types.js";

const MBID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const credit = (id: string, name: string, joinphrase = "", credited?: string) => ({
	name: credited ?? name,
	joinphrase,
	artist: { id, name },
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubMb(body: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
	);
}

describe("MusicBrainz catalog: primary artist of a hit (TRA-547)", () => {
	it("a release-group with a multiple credit gets artist = the first credited artist; subtitle is unchanged", async () => {
		stubMb({
			"release-groups": [
				{
					id: MBID(1),
					title: "Communicate",
					"primary-type": "Album",
					"artist-credit": [credit(MBID(10), "Sasha", ", "), credit(MBID(11), "John Digweed")],
				},
			],
		});
		const [hit] = await createMusicBrainzCatalog().searchByType("project", "communicate tra547 a", 5);
		expect(hit).toMatchObject({
			type: "project",
			subtitle: "Sasha, John Digweed",
			artist: "Sasha",
			artist_mbid: MBID(10),
		});
	});

	it("a recording credited to 'Earth, Wind & Fire' keeps the whole name as one artist", async () => {
		stubMb({
			recordings: [
				{
					id: MBID(2),
					title: "September",
					length: 215000,
					"artist-credit": [credit(MBID(20), "Earth, Wind & Fire")],
				},
			],
		});
		const [hit] = await createMusicBrainzCatalog().searchByType("track", "september tra547 b", 5);
		expect(hit).toMatchObject({
			type: "track",
			subtitle: "Earth, Wind & Fire",
			artist: "Earth, Wind & Fire",
			artist_mbid: MBID(20),
		});
	});

	it("a joined credit led by 'Earth, Wind & Fire' still yields that name only", async () => {
		stubMb({
			recordings: [
				{
					id: MBID(3),
					title: "Duet",
					"artist-credit": [credit(MBID(20), "Earth, Wind & Fire", ", "), credit(MBID(21), "The Emotions")],
				},
			],
		});
		const [hit] = await createMusicBrainzCatalog().searchByType("track", "duet tra547 c", 5);
		expect(hit?.artist).toBe("Earth, Wind & Fire");
		expect(hit?.subtitle).toBe("Earth, Wind & Fire, The Emotions");
	});

	it("a work without any artist-credit carries no artist field", async () => {
		stubMb({ recordings: [{ id: MBID(4), title: "Untitled" }] });
		const [hit] = await createMusicBrainzCatalog().searchByType("track", "untitled tra547 d", 5);
		expect(hit).not.toHaveProperty("artist");
		expect(hit).not.toHaveProperty("artist_mbid");
	});

	it("an artist hit never carries artist (its subtitle is a sort name)", async () => {
		stubMb({ artists: [{ id: MBID(5), name: "Rohff", "sort-name": "Rohff" }] });
		const [hit] = await createMusicBrainzCatalog().searchByType("artist", "rohff tra547 e", 5);
		expect(hit).not.toHaveProperty("artist");
	});
});

describe("search service: artist and artist_slug on hits (TRA-547)", () => {
	const cacheIndex = (byMbid: Record<string, Slug>): CacheIndex => ({
		byMbid: (mbid) => byMbid[mbid] ?? null,
		prefix: () => [],
		prefixByType: () => [],
	});
	const catalog = (results: CatalogResult[]): CatalogIndex => ({
		async search() {
			return results;
		},
		async searchByType() {
			return results;
		},
		close() {},
	});
	const run = (idx: CacheIndex, results: CatalogResult[]) =>
		createSearchService({ getCacheIndex: async () => idx, catalogIndex: catalog(results) })(
			"communicate",
			null,
			8,
		);

	const work = (overrides: Partial<CatalogResult> = {}): CatalogResult => ({
		type: "project",
		mbid: MBID(1),
		name: "Communicate",
		subtitle: "Sasha, John Digweed",
		artist: "Sasha",
		artist_mbid: MBID(10),
		...overrides,
	});

	it("a catalog hit carries artist, and artist_slug when the first artist is a cache node", async () => {
		const { hits } = await run(cacheIndex({ [MBID(10)]: "artist:sasha" as Slug }), [work()]);
		expect(hits[0]).toMatchObject({
			source: "catalog",
			subtitle: "Sasha, John Digweed",
			artist: "Sasha",
			artist_slug: "artist:sasha",
		});
		expect(hits[0]).not.toHaveProperty("artist_mbid");
	});

	it("omits artist_slug when the artist is not in the cache", async () => {
		const { hits } = await run(cacheIndex({}), [work()]);
		expect(hits[0]).toMatchObject({ artist: "Sasha" });
		expect(hits[0]).not.toHaveProperty("artist_slug");
	});

	it("omits artist_slug when the cached slug is not canonical or not an artist", async () => {
		const legacy = await run(cacheIndex({ [MBID(10)]: "artist:Legacy_Sasha" as Slug }), [work()]);
		expect(legacy.hits[0]).not.toHaveProperty("artist_slug");
		const wrongType = await run(cacheIndex({ [MBID(10)]: "genre:house" as Slug }), [work()]);
		expect(wrongType.hits[0]).not.toHaveProperty("artist_slug");
	});

	it("a work already in the cache (source cache) still exposes the artist", async () => {
		const idx = cacheIndex({
			[MBID(1)]: "project:communicate--sasha" as Slug,
			[MBID(10)]: "artist:sasha" as Slug,
		});
		const { hits } = await run(idx, [work()]);
		expect(hits[0]).toMatchObject({
			source: "cache",
			slug: "project:communicate--sasha",
			artist: "Sasha",
			artist_slug: "artist:sasha",
		});
	});

	it("does not give an artist hit an artist field", async () => {
		const { hits } = await run(cacheIndex({}), [
			{ type: "artist", mbid: MBID(5), name: "Rohff", subtitle: "Rohff", artist: "Rohff" },
		]);
		expect(hits[0]).not.toHaveProperty("artist");
	});
});
