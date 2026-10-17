import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheIndex } from "../src/cache-index.js";
import { listenBrainzConfig, musicBrainzConfig } from "../src/config.js";
import {
	computeSimilarFromGraph,
	fetchSimilarArtistsLb,
	GENRE_MAX_CARRIERS,
	LABEL_MAX_CARRIERS,
	MIN_GRAPH_SCORE,
	resolveSimilarArtists,
} from "../src/similar-artists.js";
import type { ArtistNode, EdgeRef, Slug } from "../src/types.js";

const KANYE = "f90e8b26-9e52-4669-a5c9-e28529c47894";
const suiteMinIntervalMs = listenBrainzConfig.minIntervalMs;

beforeEach(() => {
	// Tests stub fetch; ListenBrainz spacing is opted into by the scheduler test only.
	listenBrainzConfig.minIntervalMs = 0;
});

afterEach(() => {
	listenBrainzConfig.minIntervalMs = suiteMinIntervalMs;
	vi.useRealTimers();
});

function edge(type: EdgeRef["type"], name: string): EdgeRef {
	return { slug: `${type}:${name.toLowerCase().replace(/\W+/g, "-")}` as Slug, type, name };
}

function artist(name: string, extra: Partial<ArtistNode> = {}): ArtistNode {
	return {
		slug: `artist:${name.toLowerCase().replace(/\W+/g, "-")}` as Slug,
		type: "artist",
		name,
		editorial_article: "x".repeat(40),
		editorial_bio: "bio",
		citations: [],
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

function mbid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function lbRow(n: number, name: string, score: number, extra: Record<string, unknown> = {}) {
	return {
		artist_mbid: mbid(n),
		name,
		comment: "",
		type: "Person",
		gender: null,
		score,
		reference_mbid: KANYE,
		...extra,
	};
}

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as Response;
}

function statusResponse(status: number): Response {
	return { ok: false, status, json: async () => ({}) } as Response;
}

function emptyIndex(known: Record<string, Slug> = {}): CacheIndex {
	return {
		byMbid: (m) => known[m] ?? null,
		prefix: () => [],
		prefixByType: () => [],
	};
}

const KANYE_ROWS = [
	lbRow(1, "Kendrick Lamar", 6967),
	lbRow(2, "Eminem", 5940),
	lbRow(3, "Dr. Dre", 5165),
	lbRow(4, "Jay-Z", 5000),
	lbRow(5, "Travis Scott", 4800),
	lbRow(6, "Drake", 4700),
	lbRow(7, "J. Cole", 4600),
	lbRow(8, "Nas", 4500),
	lbRow(9, "Lil Wayne", 4400),
	lbRow(10, "Frank Ocean", 4300),
	lbRow(11, "Tyler, The Creator", 4200),
	lbRow(12, "Future", 4100),
];

describe("fetchSimilarArtistsLb", () => {
	it("returns validated candidates ordered by score, calling the fixed host with a User-Agent", async () => {
		const fetchMock = vi.fn(async () => jsonResponse([...KANYE_ROWS].reverse()));
		const out = await fetchSimilarArtistsLb(KANYE, { fetch: fetchMock as unknown as typeof fetch });

		expect(out.slice(0, 3)).toEqual([
			{ mbid: mbid(1), name: "Kendrick Lamar", score: 6967 },
			{ mbid: mbid(2), name: "Eminem", score: 5940 },
			{ mbid: mbid(3), name: "Dr. Dre", score: 5165 },
		]);
		expect(out).toHaveLength(12);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.origin).toBe("https://labs.api.listenbrainz.org");
		expect(url.pathname).toBe("/similar-artists/json");
		expect(url.searchParams.get("artist_mbids")).toBe(KANYE);
		expect(url.searchParams.get("algorithm")).toBe(listenBrainzConfig.algorithm);
		expect((init.headers as Record<string, string>)["User-Agent"]).toBe(musicBrainzConfig.userAgent);
		expect(init.redirect).toBe("error");
	});

	it("returns [] on 429 / 5xx without throwing", async () => {
		for (const status of [429, 500, 503]) {
			const fetchMock = vi.fn(async () => statusResponse(status));
			expect(await fetchSimilarArtistsLb(KANYE, { fetch: fetchMock as unknown as typeof fetch })).toEqual([]);
		}
	});

	it("returns [] on a network error and on an invalid JSON body", async () => {
		const boom = vi.fn(async () => {
			throw new Error("ECONNRESET");
		});
		expect(await fetchSimilarArtistsLb(KANYE, { fetch: boom as unknown as typeof fetch })).toEqual([]);

		const badJson = vi.fn(
			async () =>
				({
					ok: true,
					status: 200,
					json: async () => {
						throw new SyntaxError("Unexpected token <");
					},
				}) as unknown as Response,
		);
		expect(await fetchSimilarArtistsLb(KANYE, { fetch: badJson as unknown as typeof fetch })).toEqual([]);
	});

	it("returns [] when the body is not an array", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ error: "nope" }));
		expect(await fetchSimilarArtistsLb(KANYE, { fetch: fetchMock as unknown as typeof fetch })).toEqual([]);
	});

	it("drops rows that fail validation and keeps the valid ones", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse([
				lbRow(1, "Valid", 10),
				{ ...lbRow(2, "Bad mbid", 9), artist_mbid: "not-a-uuid" },
				{ ...lbRow(3, "Bad score", 8), score: "high" },
				{ ...lbRow(4, "", 7) },
				{ ...lbRow(5, "Infinite", Number.POSITIVE_INFINITY) },
				null,
				"nope",
			]),
		);
		const out = await fetchSimilarArtistsLb(KANYE, { fetch: fetchMock as unknown as typeof fetch });
		expect(out).toEqual([{ mbid: mbid(1), name: "Valid", score: 10 }]);
	});

	it("does not call the network for a malformed MBID", async () => {
		const fetchMock = vi.fn();
		expect(
			await fetchSimilarArtistsLb("kanye&evil=1", { fetch: fetchMock as unknown as typeof fetch }),
		).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("never forwards a URL found in the response", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse([lbRow(1, "Someone", 5, { url: "https://evil.example/x", image: "javascript:alert(1)" })]),
		);
		const out = await fetchSimilarArtistsLb(KANYE, { fetch: fetchMock as unknown as typeof fetch });
		expect(Object.keys(out[0] ?? {}).sort()).toEqual(["mbid", "name", "score"]);
	});

	it("spaces consecutive calls by at least minIntervalMs", async () => {
		listenBrainzConfig.minIntervalMs = 1_000;
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
		const times: number[] = [];
		const fetchMock = vi.fn(async () => {
			times.push(Date.now());
			return jsonResponse([]);
		});
		const run = Promise.all([
			fetchSimilarArtistsLb(KANYE, { fetch: fetchMock as unknown as typeof fetch }),
			fetchSimilarArtistsLb(KANYE, { fetch: fetchMock as unknown as typeof fetch }),
			fetchSimilarArtistsLb(KANYE, { fetch: fetchMock as unknown as typeof fetch }),
		]);
		await vi.advanceTimersByTimeAsync(5_000);
		await run;
		expect(times).toHaveLength(3);
		const gaps = times.slice(1).map((t, i) => t - (times[i] ?? 0));
		expect(gaps).toHaveLength(2);
		expect(gaps.every((gap) => gap >= 1_000)).toBe(true);
	});

	it("aborts a request that exceeds the 5 s timeout and returns []", async () => {
		vi.useFakeTimers();
		const hanging = vi.fn(
			(_url: URL, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const run = fetchSimilarArtistsLb(KANYE, { fetch: hanging as unknown as typeof fetch });
		await vi.advanceTimersByTimeAsync(5_001);
		expect(await run).toEqual([]);
	});
});

describe("computeSimilarFromGraph", () => {
	// TRA-603 (2026-10-17): genres and labels are weighed by what they single out, a candidate needs a common
	// collaborator or a score of 2, and ties are no longer alphabetical. Helpers for the cases below.
	const bump = (n: number, make: (i: number) => ArtistNode): ArtistNode[] =>
		Array.from({ length: n }, (_, i) => make(i));
	const wide = (n: number, extra: Partial<ArtistNode>): ArtistNode[] =>
		bump(n, (i) => artist(`Filler ${String(i).padStart(3, "0")}`, extra));

	it("weighs 3 per common collaborator, 2 per common indie label and 1 / log2(1 + n) per common genre", () => {
		const me = artist("Me", {
			collaborators: [edge("artist", "Collab")],
			labels: [edge("label", "Warp"), edge("label", "Ninja")],
			genres: [edge("genre", "Idm"), edge("genre", "Techno")],
		});
		const near = artist("Near", {
			collaborators: [edge("artist", "Collab")],
			labels: [edge("label", "Warp")],
			genres: [edge("genre", "Idm"), edge("genre", "Techno")],
		});
		// n = 1 for each genre (only Near carries them among `others`): 1 / log2(2) = 1.
		expect(computeSimilarFromGraph(me, [near])).toEqual([
			{ name: "Near", score: 3 + 2 + 1 + 1, slug: near.slug },
		]);
	});

	it("keeps a candidate with a common collaborator even when nothing else is shared", () => {
		const me = artist("Me", { collaborators: [edge("artist", "Collab")], genres: [edge("genre", "Idm")] });
		const other = artist("Other", { collaborators: [edge("artist", "Collab")], mbid: mbid(7) });
		expect(computeSimilarFromGraph(me, [other])).toEqual([
			{ name: "Other", score: 3, slug: other.slug, mbid: mbid(7) },
		]);
	});

	it("weighs a genre by its specificity: the more artists carry it, the less it says", () => {
		const me = artist("Me", {
			collaborators: [edge("artist", "Collab")],
			genres: [edge("genre", "Rare"), edge("genre", "Common")],
		});
		const withRare = artist("With Rare", {
			collaborators: [edge("artist", "Collab")],
			genres: [edge("genre", "Rare")],
		});
		const withCommon = artist("With Common", {
			collaborators: [edge("artist", "Collab")],
			genres: [edge("genre", "Common")],
		});
		const crowd = wide(5, { genres: [edge("genre", "Common")] });
		const out = computeSimilarFromGraph(me, [withRare, withCommon, ...crowd]);
		const score = (name: string) => out.find((c) => c.name === name)?.score;
		// Rare: 1 carrier -> 1 / log2(2) = 1. Common: 6 carriers (With Common + 5) -> 1 / log2(7).
		expect(score("With Rare")).toBeCloseTo(3 + 1, 10);
		expect(score("With Common")).toBeCloseTo(3 + 1 / Math.log2(7), 10);
		expect(out.map((c) => c.name)).toEqual(["With Rare", "With Common"]);
	});

	it("gives no similar artist from a genre carried by more than GENRE_MAX_CARRIERS artists alone", () => {
		const me = artist("Me", { genres: [edge("genre", "House")] });
		const crowd = wide(GENRE_MAX_CARRIERS + 1, { genres: [edge("genre", "House")] });
		expect(computeSimilarFromGraph(me, crowd)).toEqual([]);
		// Even two such wide genres together weigh 0 + 0.
		const meTwo = artist("Me", { genres: [edge("genre", "House"), edge("genre", "Pop")] });
		const both = wide(GENRE_MAX_CARRIERS + 1, { genres: [edge("genre", "House"), edge("genre", "Pop")] });
		expect(computeSimilarFromGraph(meTwo, both)).toEqual([]);
	});

	it("gives no similar artist from a label cited by more than LABEL_MAX_CARRIERS artists alone (a major)", () => {
		const me = artist("Me", { labels: [edge("label", "Island")] });
		const roster = wide(LABEL_MAX_CARRIERS + 1, { labels: [edge("label", "Island")] });
		expect(computeSimilarFromGraph(me, roster)).toEqual([]);
	});

	it("keeps an artist of a small label (at most LABEL_MAX_CARRIERS carriers), worth 2", () => {
		const me = artist("Me", { labels: [edge("label", "Hyperdub")] });
		const roster = wide(LABEL_MAX_CARRIERS, { labels: [edge("label", "Hyperdub")] });
		const out = computeSimilarFromGraph(me, roster);
		expect(out).toHaveLength(LABEL_MAX_CARRIERS);
		expect(out.every((c) => c.score === 2)).toBe(true);
	});

	it("does not keep one niche genre alone, but keeps a common collaborator", () => {
		const me = artist("Me", { collaborators: [edge("artist", "Collab")], genres: [edge("genre", "Idm")] });
		const nicheOnly = artist("Niche Only", { genres: [edge("genre", "Idm")] });
		const collaborator = artist("Collaborator", { collaborators: [edge("artist", "Collab")] });
		const out = computeSimilarFromGraph(me, [nicheOnly, collaborator]);
		expect(out.map((c) => c.name)).toEqual(["Collaborator"]);
	});

	it("keeps a candidate whose niche genres add up to MIN_GRAPH_SCORE", () => {
		const me = artist("Me", { genres: [edge("genre", "A"), edge("genre", "B")] });
		const twin = artist("Twin", { genres: [edge("genre", "A"), edge("genre", "B")] });
		const half = artist("Half", { genres: [edge("genre", "A")] });
		// A and B are carried by Twin only among `others` (n = 1 each, 1 / log2(2) = 1): 1 + 1 = MIN_GRAPH_SCORE.
		expect(MIN_GRAPH_SCORE).toBe(2);
		expect(computeSimilarFromGraph(me, [twin]).map((c) => c.name)).toEqual(["Twin"]);
		// With Half also carrying A (n = 2), Twin weighs 1 / log2(3) + 1 and falls under the threshold.
		expect(computeSimilarFromGraph(me, [twin, half])).toEqual([]);
	});

	it("never returns the artist, its aliases or its members, and drops candidates with no link", () => {
		const alias = artist("Alias", { collaborators: [edge("artist", "Collab")] });
		const member = artist("Member", { collaborators: [edge("artist", "Collab")] });
		const me = artist("Me", {
			collaborators: [edge("artist", "Collab")],
			aliases: [{ slug: alias.slug, type: "artist", name: "Alias" }],
			members: [{ slug: member.slug, type: "artist", name: "Member" }],
		});
		const unrelated = artist("Unrelated", { genres: [edge("genre", "Country")] });
		const real = artist("Real", { collaborators: [edge("artist", "Collab")] });
		expect(computeSimilarFromGraph(me, [me, alias, member, unrelated, real]).map((c) => c.name)).toEqual([
			"Real",
		]);
	});

	it("orders by score, then common genres, then name: alphabetical order no longer decides when scores differ", () => {
		const me = artist("Me", {
			collaborators: [edge("artist", "Collab")],
			genres: [edge("genre", "A"), edge("genre", "B")],
		});
		// All three share the collaborator (3). Zed also shares both niche genres, Mid one, Alpha none.
		const alpha = artist("Alpha", { collaborators: [edge("artist", "Collab")] });
		const mid = artist("Mid", { collaborators: [edge("artist", "Collab")], genres: [edge("genre", "A")] });
		const zed = artist("Zed", {
			collaborators: [edge("artist", "Collab")],
			genres: [edge("genre", "A"), edge("genre", "B")],
		});
		const out = computeSimilarFromGraph(me, [alpha, mid, zed, alpha]);
		expect(out.map((c) => c.name)).toEqual(["Zed", "Mid", "Alpha"]);
		expect(out[0]?.score).toBeGreaterThan(out[1]?.score ?? 0);
		expect(out[1]?.score).toBeGreaterThan(out[2]?.score ?? 0);
	});

	it("breaks an exact score tie by the number of common genres, then by name", () => {
		const me = artist("Me", { collaborators: [edge("artist", "Collab")], genres: [edge("genre", "House")] });
		// House is wide (weight 0): it adds nothing to the score but still counts as a common genre.
		const fillers = wide(GENRE_MAX_CARRIERS + 1, { genres: [edge("genre", "House")] });
		const zed = artist("Zed", {
			collaborators: [edge("artist", "Collab")],
			genres: [edge("genre", "House")],
		});
		const alpha = artist("Alpha", { collaborators: [edge("artist", "Collab")] });
		const beta = artist("Beta", { collaborators: [edge("artist", "Collab")] });
		const out = computeSimilarFromGraph(me, [beta, alpha, zed, ...fillers]);
		expect(out.map((c) => [c.name, c.score])).toEqual([
			["Zed", 3],
			["Alpha", 3],
			["Beta", 3],
		]);
	});
});

describe("resolveSimilarArtists", () => {
	const withMbid = artist("Kanye West", { mbid: KANYE });

	it("uses ListenBrainz, caps at 10 edges in score order, and carries the mbid", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(KANYE_ROWS));
		const out = await resolveSimilarArtists(withMbid, {
			cacheIndex: emptyIndex(),
			others: () => [],
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(out.source).toBe("listenbrainz");
		expect(out.edges).toHaveLength(10);
		expect(out.edges.slice(0, 3)).toEqual([
			{ slug: "artist:kendrick-lamar", type: "artist", name: "Kendrick Lamar", mbid: mbid(1) },
			{ slug: "artist:eminem", type: "artist", name: "Eminem", mbid: mbid(2) },
			{ slug: "artist:dr-dre", type: "artist", name: "Dr. Dre", mbid: mbid(3) },
		]);
		expect(out.edges.every((e) => e.mbid !== undefined)).toBe(true);
	});

	it("reuses the cache slug when the MBID is known to the cache index", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse([lbRow(1, "Kendrick Lamar", 10), lbRow(2, "Eminem", 9)]),
		);
		const out = await resolveSimilarArtists(withMbid, {
			cacheIndex: emptyIndex({ [mbid(1)]: "artist:kendrick-lamar--compton" as Slug }),
			others: () => [],
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(out.edges.map((e) => e.slug)).toEqual(["artist:kendrick-lamar--compton", "artist:eminem"]);
	});

	it("never derives a slug from a non-Latin name, but keeps it when the cache knows the MBID", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse([
				lbRow(1, "坂本龍一", 10),
				lbRow(2, "Mr. 坂本", 9),
				lbRow(3, "Шнуров", 8),
				lbRow(4, "Björk", 7),
				lbRow(5, "宇多田ヒカル", 6),
			]),
		);
		const out = await resolveSimilarArtists(withMbid, {
			cacheIndex: emptyIndex({ [mbid(5)]: "artist:hikaru-utada" as Slug }),
			others: () => [],
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(out.source).toBe("listenbrainz");
		expect(out.edges.map((e) => e.slug)).toEqual(["artist:bjork", "artist:hikaru-utada"]);
	});

	it("excludes the artist itself, its aliases and duplicates from ListenBrainz results", async () => {
		const me = artist("Kanye West", {
			mbid: KANYE,
			aliases: [{ slug: "artist:yeezy", type: "artist", name: "Yeezy" }],
		});
		const fetchMock = vi.fn(async () =>
			jsonResponse([
				lbRow(1, "Kanye West", 10),
				lbRow(2, "Yeezy", 9),
				lbRow(3, "Eminem", 8),
				lbRow(4, "Eminem", 7),
			]),
		);
		const out = await resolveSimilarArtists(me, {
			cacheIndex: emptyIndex(),
			others: () => [],
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(out.edges.map((e) => e.slug)).toEqual(["artist:eminem"]);
	});

	function graphFixture() {
		const me = artist("Me", { mbid: KANYE, collaborators: [edge("artist", "Go Between")] });
		const peer = artist("Peer", { collaborators: [edge("artist", "Go Between")], mbid: mbid(9) });
		return { me, peer };
	}

	it.each([
		["429", () => statusResponse(429)],
		["invalid JSON", () => jsonResponse({ not: "an array" })],
		["empty array", () => jsonResponse([])],
	])("falls back to the graph on ListenBrainz %s", async (_label, respond) => {
		const { me, peer } = graphFixture();
		const fetchMock = vi.fn(async () => respond());
		const out = await resolveSimilarArtists(me, {
			cacheIndex: emptyIndex(),
			others: () => [peer],
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(out.source).toBe("graph");
		expect(out.edges).toEqual([{ slug: peer.slug, type: "artist", name: "Peer", mbid: mbid(9) }]);
	});

	it("goes straight to the graph, with no network call, for an artist without mbid", async () => {
		const { peer } = graphFixture();
		const me = artist("Me", { collaborators: [edge("artist", "Go Between")] });
		const fetchMock = vi.fn();
		const out = await resolveSimilarArtists(me, {
			cacheIndex: emptyIndex(),
			others: () => [peer],
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(out.source).toBe("graph");
		expect(out.edges.map((e) => e.slug)).toEqual([peer.slug]);
	});

	it("keeps the real slug of a cached graph neighbour even when it is disambiguated", async () => {
		const me = artist("Me", { collaborators: [edge("artist", "Go Between")] });
		const pole = artist("Pole", { collaborators: [edge("artist", "Go Between")] });
		pole.slug = "artist:pole--stefan-betke" as Slug;
		const out = await resolveSimilarArtists(me, { cacheIndex: emptyIndex(), others: () => [pole] });
		expect(out.edges.map((e) => e.slug)).toEqual(["artist:pole--stefan-betke"]);
	});

	it("caps the graph fallback at 10 edges", async () => {
		const me = artist("Me", { collaborators: [edge("artist", "Go Between")] });
		const crowd = Array.from({ length: 15 }, (_, i) =>
			artist(`Peer ${String(i).padStart(2, "0")}`, {
				collaborators: [edge("artist", "Go Between")],
			}),
		);
		const out = await resolveSimilarArtists(me, { cacheIndex: emptyIndex(), others: () => crowd });
		expect(out.edges).toHaveLength(10);
	});

	it("reports source none when neither source has anything", async () => {
		const me = artist("Me", { mbid: KANYE });
		const fetchMock = vi.fn(async () => statusResponse(500));
		const out = await resolveSimilarArtists(me, {
			cacheIndex: emptyIndex(),
			others: () => [],
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(out).toEqual({ edges: [], source: "none" });
	});
});
