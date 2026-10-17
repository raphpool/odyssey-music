import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheIndex } from "../src/cache-index.js";
import { listenBrainzConfig, musicBrainzConfig } from "../src/config.js";
import {
	computeSimilarFromGraph,
	fetchSimilarArtistsLb,
	GENRE_MAX_CARRIERS,
	GENRE_NICHE_MAX_CARRIERS,
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
	// TRA-603 (2026-10-17): a collaborator link (common or direct) weighs 3 and is enough alone; a genre weighs
	// 2 up to GENRE_NICHE_MAX_CARRIERS carriers (enough alone), 1 up to GENRE_MAX_CARRIERS, else 0; a label
	// counts (2) only next to a genre of at most GENRE_MAX_CARRIERS; the artist is not among the carriers.
	// Ties are no longer alphabetical. `wide(n, extra)` makes n fillers carrying the same links.
	const wide = (n: number, extra: Partial<ArtistNode>): ArtistNode[] =>
		Array.from({ length: n }, (_, i) => artist(`Filler ${String(i).padStart(3, "0")}`, extra));
	const genre = (name: string) => [edge("genre", name)];

	it("weighs 3 per common collaborator, 2 per niche genre and 2 per indie label next to a genre", () => {
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
			{ name: "Near", score: 3 + 2 + 2 + 2, slug: near.slug },
		]);
	});

	it("keeps a candidate with a common collaborator even when nothing else is shared", () => {
		const me = artist("Me", { collaborators: [edge("artist", "Collab")], genres: genre("Idm") });
		const other = artist("Other", { collaborators: [edge("artist", "Collab")], mbid: mbid(7) });
		expect(computeSimilarFromGraph(me, [other])).toEqual([
			{ name: "Other", score: 3, slug: other.slug, mbid: mbid(7) },
		]);
	});

	describe("direct link", () => {
		it("keeps the artist's own collaborator, with nothing else in common (a duo keeps its other half)", () => {
			const brown = artist("Rob Brown");
			const me = artist("Sean Booth", { collaborators: [edge("artist", "Rob Brown")] });
			expect(computeSimilarFromGraph(me, [brown])).toEqual([
				{ name: "Rob Brown", score: 3, slug: brown.slug },
			]);
		});

		it("keeps an artist who lists me among their collaborators, whichever side wrote it", () => {
			const golding = artist("Mike Golding", { collaborators: [edge("artist", "Steve Rutter")] });
			const me = artist("Steve Rutter");
			expect(computeSimilarFromGraph(me, [golding]).map((c) => [c.name, c.score])).toEqual([
				["Mike Golding", 3],
			]);
		});

		it("adds to the other links, and counts once when both sides name each other", () => {
			const me = artist("Me", { collaborators: [edge("artist", "Peer")], genres: genre("Niche") });
			const peer = artist("Peer", { collaborators: [edge("artist", "Me")], genres: genre("Niche") });
			expect(computeSimilarFromGraph(me, [peer]).map((c) => c.score)).toEqual([3 + 2]);
		});

		it("is not a link when the collaborator is an alias or a member (they never appear)", () => {
			const member = artist("Member");
			const me = artist("Me", {
				collaborators: [edge("artist", "Member")],
				members: [{ slug: member.slug, type: "artist", name: "Member" }],
			});
			expect(computeSimilarFromGraph(me, [member])).toEqual([]);
		});
	});

	describe("tiers of genre specificity", () => {
		it("keeps a candidate on a genre carried by GENRE_NICHE_MAX_CARRIERS artists or fewer, alone", () => {
			const me = artist("Me", { genres: genre("Black Metal") });
			const roster = wide(GENRE_NICHE_MAX_CARRIERS, { genres: genre("Black Metal") });
			const out = computeSimilarFromGraph(me, roster);
			expect(out).toHaveLength(GENRE_NICHE_MAX_CARRIERS);
			expect(out.every((c) => c.score === 2)).toBe(true);
		});

		it("does not keep one genre of GENRE_NICHE_MAX_CARRIERS + 1 carriers alone (weight 1 < MIN_GRAPH_SCORE)", () => {
			expect(MIN_GRAPH_SCORE).toBe(2);
			const me = artist("Me", { genres: genre("Idm") });
			const roster = wide(GENRE_NICHE_MAX_CARRIERS + 1, { genres: genre("Idm") });
			expect(computeSimilarFromGraph(me, roster)).toEqual([]);
		});

		it("keeps two genres of 11 to GENRE_MAX_CARRIERS carriers (1 + 1), up to the cap included", () => {
			const both = [edge("genre", "Idm"), edge("genre", "Ambient")];
			const me = artist("Me", { genres: both });
			const out = computeSimilarFromGraph(me, wide(GENRE_MAX_CARRIERS, { genres: both }));
			expect(out).toHaveLength(GENRE_MAX_CARRIERS);
			expect(out.every((c) => c.score === 2)).toBe(true);
		});

		it("gives nothing for a genre carried by more than GENRE_MAX_CARRIERS artists, two of them included", () => {
			const me = artist("Me", { genres: genre("House") });
			expect(computeSimilarFromGraph(me, wide(GENRE_MAX_CARRIERS + 1, { genres: genre("House") }))).toEqual(
				[],
			);
			const both = [edge("genre", "House"), edge("genre", "Pop")];
			expect(
				computeSimilarFromGraph(
					artist("Me", { genres: both }),
					wide(GENRE_MAX_CARRIERS + 1, { genres: both }),
				),
			).toEqual([]);
		});

		it("adds a niche genre (2) and a mid one (1)", () => {
			const me = artist("Me", { genres: [edge("genre", "Rare"), edge("genre", "Mid")] });
			const twin = artist("Twin", { genres: [edge("genre", "Rare"), edge("genre", "Mid")] });
			const crowd = wide(GENRE_NICHE_MAX_CARRIERS, { genres: genre("Mid") });
			expect(computeSimilarFromGraph(me, [twin, ...crowd]).find((c) => c.name === "Twin")?.score).toBe(2 + 1);
		});

		it("does not count the artist itself among the carriers: same answer on a new sheet and in the backfill", () => {
			const me = artist("Me", { genres: genre("Noise Rock") });
			// 10 other carriers: a niche. Counted with `me` they would be 11 and fall to weight 1, unkept.
			const crowd = wide(GENRE_NICHE_MAX_CARRIERS, { genres: genre("Noise Rock") });
			const onNewSheet = computeSimilarFromGraph(me, crowd);
			const inBackfill = computeSimilarFromGraph(me, [me, ...crowd]);
			expect(onNewSheet).toHaveLength(GENRE_NICHE_MAX_CARRIERS);
			expect(inBackfill).toEqual(onNewSheet);
		});

		it("does not count the artist itself among a label's carriers either", () => {
			const me = artist("Me", { labels: [edge("label", "Hyperdub")], genres: genre("Dubstep") });
			const roster = wide(LABEL_MAX_CARRIERS, {
				labels: [edge("label", "Hyperdub")],
				genres: genre("Dubstep"),
			});
			// 15 other artists cite the label; counted with `me` they would be 16 and the label would drop to 0.
			const onNewSheet = computeSimilarFromGraph(me, roster);
			expect(onNewSheet).toHaveLength(LABEL_MAX_CARRIERS);
			expect(computeSimilarFromGraph(me, [me, ...roster])).toEqual(onNewSheet);
		});
	});

	describe("labels", () => {
		it("never creates a similarity from a label alone, small or big", () => {
			const me = artist("Me", { labels: [edge("label", "Hyperdub")] });
			const smallRoster = wide(LABEL_MAX_CARRIERS, { labels: [edge("label", "Hyperdub")] });
			expect(computeSimilarFromGraph(me, smallRoster)).toEqual([]);
			const major = artist("Me", { labels: [edge("label", "Island")] });
			expect(
				computeSimilarFromGraph(major, wide(LABEL_MAX_CARRIERS + 1, { labels: [edge("label", "Island")] })),
			).toEqual([]);
		});

		it("keeps an artist of a small label (at most LABEL_MAX_CARRIERS) who also shares a genre: 1 + 2", () => {
			const me = artist("Me", { labels: [edge("label", "Hyperdub")], genres: genre("Dubstep") });
			const roster = wide(LABEL_MAX_CARRIERS, {
				labels: [edge("label", "Hyperdub")],
				genres: genre("Dubstep"),
			});
			const out = computeSimilarFromGraph(me, roster);
			expect(out).toHaveLength(LABEL_MAX_CARRIERS);
			expect(out.every((c) => c.score === 3)).toBe(true);
		});

		it("does not count a major's label (more than LABEL_MAX_CARRIERS) even next to a genre: score 1, not kept", () => {
			const me = artist("Me", { labels: [edge("label", "Atlantic")], genres: genre("Soul") });
			const roster = wide(LABEL_MAX_CARRIERS + 1, {
				labels: [edge("label", "Atlantic")],
				genres: genre("Soul"),
			});
			expect(computeSimilarFromGraph(me, roster)).toEqual([]);
		});

		it("does not count a label next to a wide genre only", () => {
			const me = artist("Me", { labels: [edge("label", "Hyperdub")], genres: genre("House") });
			const roster = [
				artist("Same Label", { labels: [edge("label", "Hyperdub")], genres: genre("House") }),
				...wide(GENRE_MAX_CARRIERS, { genres: genre("House") }),
			];
			expect(computeSimilarFromGraph(me, roster)).toEqual([]);
		});
	});

	it("never returns the artist, its aliases or its members, and drops candidates with no link", () => {
		const alias = artist("Alias", { collaborators: [edge("artist", "Collab")] });
		const member = artist("Member", { collaborators: [edge("artist", "Collab")] });
		const me = artist("Me", {
			collaborators: [edge("artist", "Collab")],
			aliases: [{ slug: alias.slug, type: "artist", name: "Alias" }],
			members: [{ slug: member.slug, type: "artist", name: "Member" }],
		});
		const unrelated = artist("Unrelated", { genres: genre("Country") });
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
		// All share the collaborator (3). Zed also shares both niche genres (+2 +2), Mid one (+2), Alpha none.
		const alpha = artist("Alpha", { collaborators: [edge("artist", "Collab")] });
		const mid = artist("Mid", { collaborators: [edge("artist", "Collab")], genres: genre("A") });
		const zed = artist("Zed", {
			collaborators: [edge("artist", "Collab")],
			genres: [edge("genre", "A"), edge("genre", "B")],
		});
		const out = computeSimilarFromGraph(me, [alpha, mid, zed, alpha]);
		expect(out.map((c) => [c.name, c.score])).toEqual([
			["Zed", 7],
			["Mid", 5],
			["Alpha", 3],
		]);
	});

	it("breaks an exact score tie by the number of common genres (a wide one counts), then by name", () => {
		const me = artist("Me", { collaborators: [edge("artist", "Collab")], genres: genre("House") });
		// House is wide (weight 0): it adds nothing to the score but still counts as a common genre.
		const fillers = wide(GENRE_MAX_CARRIERS + 1, { genres: genre("House") });
		const zed = artist("Zed", { collaborators: [edge("artist", "Collab")], genres: genre("House") });
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
