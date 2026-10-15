import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheIndex } from "../src/cache-index.js";
import { listenBrainzConfig, musicBrainzConfig } from "../src/config.js";
import {
	computeSimilarFromGraph,
	fetchSimilarArtistsLb,
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
	it("scores 3 per collaborator, 2 per label and 1 per genre in common", () => {
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
		expect(computeSimilarFromGraph(me, [near])).toEqual([
			{ name: "Near", score: 3 + 2 + 2, slug: near.slug },
		]);
	});

	it("scores 4 for one shared collaborator and one shared genre", () => {
		const me = artist("Me", { collaborators: [edge("artist", "Collab")], genres: [edge("genre", "Idm")] });
		const other = artist("Other", {
			collaborators: [edge("artist", "Collab")],
			genres: [edge("genre", "Idm")],
			mbid: mbid(7),
		});
		expect(computeSimilarFromGraph(me, [other])).toEqual([
			{ name: "Other", score: 4, slug: other.slug, mbid: mbid(7) },
		]);
	});

	it("never returns the artist, its aliases or its members, and drops score 0", () => {
		const alias = artist("Alias", { genres: [edge("genre", "Idm")] });
		const member = artist("Member", { genres: [edge("genre", "Idm")] });
		const me = artist("Me", {
			genres: [edge("genre", "Idm")],
			aliases: [{ slug: alias.slug, type: "artist", name: "Alias" }],
			members: [{ slug: member.slug, type: "artist", name: "Member" }],
		});
		const unrelated = artist("Unrelated", { genres: [edge("genre", "Country")] });
		const real = artist("Real", { genres: [edge("genre", "Idm")] });
		expect(computeSimilarFromGraph(me, [me, alias, member, unrelated, real]).map((c) => c.name)).toEqual([
			"Real",
		]);
	});

	it("orders by score desc then name asc, and ignores duplicates in the iterable", () => {
		const me = artist("Me", { genres: [edge("genre", "A"), edge("genre", "B")] });
		const b = artist("Beta", { genres: [edge("genre", "A")] });
		const a = artist("Alpha", { genres: [edge("genre", "A")] });
		const top = artist("Top", { genres: [edge("genre", "A"), edge("genre", "B")] });
		expect(computeSimilarFromGraph(me, [b, a, top, a]).map((c) => [c.name, c.score])).toEqual([
			["Top", 2],
			["Alpha", 1],
			["Beta", 1],
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
		const me = artist("Me", { mbid: KANYE, genres: [edge("genre", "Idm")] });
		const peer = artist("Peer", { genres: [edge("genre", "Idm")], mbid: mbid(9) });
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
		const me = artist("Me", { genres: [edge("genre", "Idm")] });
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
		const me = artist("Me", { genres: [edge("genre", "Idm")] });
		const pole = artist("Pole", { genres: [edge("genre", "Idm")] });
		pole.slug = "artist:pole--stefan-betke" as Slug;
		const out = await resolveSimilarArtists(me, { cacheIndex: emptyIndex(), others: () => [pole] });
		expect(out.edges.map((e) => e.slug)).toEqual(["artist:pole--stefan-betke"]);
	});

	it("caps the graph fallback at 10 edges", async () => {
		const me = artist("Me", { genres: [edge("genre", "Idm")] });
		const crowd = Array.from({ length: 15 }, (_, i) =>
			artist(`Peer ${String(i).padStart(2, "0")}`, {
				genres: [edge("genre", "Idm")],
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
