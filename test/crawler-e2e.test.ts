import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { CrawlOptions } from "../src/crawler.js";
import type { GenreSeeds } from "../src/genre-seeds.js";
import type { PipelineInput, PipelineResult } from "../src/pipeline.js";
import type { ArtistNode, GenreNode, NodePayload, ProjectNode, Slug, TrackNode } from "../src/types.js";
import { artistDraftFixture, genreDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-476: runPipeline stays the real one unless a test sets `pipelineStub.impl`. Only the crawl() tests
// of the TRA-476 block do; every other test in this file runs the whole pipeline over mocked boundaries.
const pipelineStub = vi.hoisted(() => ({
	impl: undefined as undefined | ((input: PipelineInput) => Promise<PipelineResult>),
	calls: [] as PipelineInput[],
}));
vi.mock("../src/pipeline.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/pipeline.js")>();
	return {
		...actual,
		runPipeline: (...args: Parameters<typeof actual.runPipeline>) => {
			if (!pipelineStub.impl) return actual.runPipeline(...args);
			pipelineStub.calls.push(args[0]);
			return pipelineStub.impl(args[0]);
		},
	};
});

// TRA-28 review: missing wiring test (i) -- crawl() (src/crawler.ts) builds its own GenreRegistry
// on its own NodeCache and must actually use it, both when materializing a node and when
// enqueueing that node's outbound edges (B1). `crawl` is imported dynamically, exactly like
// runPipeline in test/pipeline-e2e.test.ts: its module graph statically pulls in pipeline.js ->
// musicbrainz.js/tavily.js/local-fetcher.js/@google/genai, which must stay mocked -- see that
// file's comment on import-order hazards with Biome's sorter reordering "../src/..." ahead of
// "./helpers/...".
async function loadCrawl() {
	return await import("../src/crawler.js");
}

async function loadCli() {
	return await import("../src/cli.js");
}

const ELECTRONIC_MBID = "89255676-1f14-4dd8-bbad-fca839d6aff4";
const ELECTRONIC_QID = "Q9778";
const TIMEOUT_MS = 5_000;

function cliSeeds(): GenreSeeds {
	return {
		Q1: {
			genre: { slug: "genre:q1", name: "Q1", qid: "Q1" },
			anchors: [],
			targets: [],
		},
		Q2: {
			genre: { slug: "genre:q2", name: "Q2", qid: "Q2" },
			anchors: [],
			targets: [],
		},
	};
}

function genreNode(overrides: Partial<GenreNode> & { slug: Slug; name: string }): GenreNode {
	return {
		type: "genre",
		editorial_article: "A real long article about this genre, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_definition: "A short definition.",
		citations: [{ url: "https://example.com/genre" }],
		materialized_at: new Date().toISOString(),
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
		...overrides,
	};
}

function artistNode(overrides: Partial<ArtistNode> & { slug: Slug; name: string }): ArtistNode {
	return {
		type: "artist",
		editorial_article: "A real long article about this artist, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_bio: "A short bio.",
		citations: [{ url: "https://example.com/artist" }],
		materialized_at: new Date().toISOString(),
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
		...overrides,
	};
}

// TRA-252: only what preserveLiveNeighbors' cache.has() check needs -- a project node that
// exists in the cache so it counts as an "alive" landmark_projects target.
function projectNode(overrides: Partial<ProjectNode> & { slug: Slug; name: string }): ProjectNode {
	return {
		type: "project",
		editorial_article:
			"A real long article about this project, well past the eighty character floor. ".repeat(2),
		editorial_pitch: "A short pitch.",
		citations: [{ url: "https://example.com/project" }],
		materialized_at: new Date().toISOString(),
		artists: [],
		genres: [],
		tracklist: [],
		producers: [],
		personnel: [],
		related_projects: [],
		...overrides,
	};
}

describe("crawl() genre registry wiring (TRA-28 review)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-crawler-e2e-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it(
		"dedupes a canonicalized genre edge against the pre-seeded cache instead of chasing a name-derived duplicate",
		async () => {
			const cache = new NodeCache(dir);
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));

			installPipelineMocks({
				draft: artistDraftFixture(),
				mbGenres: [{ name: "electronic music", mbid: ELECTRONIC_MBID }],
			});
			const { crawl } = await loadCrawl();

			const logs: string[] = [];
			await crawl({
				seed: "artist:Fixture Artist",
				maxDepth: 1,
				maxNodes: 20,
				concurrency: 1,
				out: dir,
				deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
				logger: (s) => logs.push(s),
			});

			// The genre edge canonicalizes onto the pre-seeded "genre:electronic". The crawler's
			// own cache.has() dedup check must skip it -- keyed by the edge's own (canonical) slug,
			// not one re-derived from its name (TRA-28 review B1) -- rather than ever attempting to
			// materialize a second, name-derived "genre:electronic-music".
			expect(logs.some((l) => l.includes("skip cached genre:electronic"))).toBe(true);
			expect(logs.some((l) => l.includes("electronic-music"))).toBe(false);
			expect(await cache.has("genre:electronic-music")).toBe(false);
		},
		TIMEOUT_MS,
	);
});

describe("crawlGenreSeeds() (TRA-61)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-crawler-seeds-e2e-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("counts failed materializations against maxNodes and never reaches unbudgeted targets", async () => {
		installPipelineMocks({ draft: artistDraftFixture() });
		const { crawlGenreSeeds } = await loadCrawl();
		const seeds: GenreSeeds = {
			Q2913982: {
				genre: { slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q2913982" },
				anchors: [{ slug: "genre:hip-hop", name: "Hip hop", qid: "Q11401" }],
				targets: [{ type: "artist", name: "Fixture Artist", slug: "artist:fixture-artist" }],
			},
		};
		const logs: string[] = [];

		const result = await crawlGenreSeeds(
			{
				seed: "artist:unused",
				maxDepth: 0,
				maxNodes: 2,
				concurrency: 4,
				out: dir,
				deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
				logger: (line) => logs.push(line),
			},
			seeds,
		);

		expect(result.consumed).toBe(2);
		expect(result.calls).toBe(2);
		expect(result.failed).toBe(2);
		expect(result.refused).toBe(1);
		expect(logs.filter((line) => line.includes("[seed] materialize"))).toEqual([
			expect.stringContaining("anchor genre:Hip hop"),
			expect.stringContaining("genre genre:Trap Hip-Hop"),
		]);
		expect(logs.some((line) => line.includes("[seed] materialize target"))).toBe(false);
	});

	it(
		"refuses to write a node whose drafted name is not the same entity as requested (identity guard, TRA-XXX)",
		async () => {
			// genreDraftFixture()'s name field is always the fixed "Fixture Genre" — a stand-in
			// for a real crawl where the LLM draft (grounded in the wrong search results for an
			// ambiguous name) names a different entity than the one requested, e.g.
			// genre:afrobeats drifting to "Afrobeat".
			installPipelineMocks({ draft: genreDraftFixture() });
			const { crawlGenreSeeds } = await loadCrawl();
			const logs: string[] = [];
			const seeds: GenreSeeds = {
				Q25099840: {
					genre: { slug: "genre:afrobeats", name: "Afrobeats", qid: "Q25099840" },
					anchors: [],
					targets: [],
				},
			};

			const result = await crawlGenreSeeds(
				{
					seed: "genre:unused",
					maxDepth: 0,
					maxNodes: 1,
					concurrency: 1,
					out: dir,
					deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
					logger: (line) => logs.push(line),
				},
				seeds,
			);

			expect(result).toMatchObject({ calls: 1, consumed: 1, failed: 1, refused: 0 });
			expect(await new NodeCache(dir).has("genre:afrobeats")).toBe(false);
			expect(
				logs.some((line) => line.includes('identity drift: requested "Afrobeats", drafted "Fixture Genre"')),
			).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"attaches the folder's genre edge to a target the drafted node doesn't already cite (TRA-263)",
		async () => {
			// The folder's genre is pre-seeded in the cache (as its own earlier "genre" stage run
			// would have left it), so this run's only pipeline call is the target itself.
			// artistDraftFixture()'s genres field is [{ type: "genre", name: "Techno" }] -- it never
			// mentions "Gabber", the folder's own genre, reproducing the reported bug: the pipeline
			// draft cites a genre it independently found, but not the one this dossier already
			// verified for this target.
			const cache = new NodeCache(dir);
			await cache.write(genreNode({ slug: "genre:gabber", name: "Gabber", qid: "Q1085907" }));
			installPipelineMocks({ draft: artistDraftFixture() });
			const { crawlGenreSeeds } = await loadCrawl();
			const seeds: GenreSeeds = {
				Q1085907: {
					genre: { slug: "genre:gabber", name: "Gabber", qid: "Q1085907" },
					anchors: [],
					targets: [{ type: "artist", name: "Fixture Artist", slug: "artist:fixture-artist" }],
				},
			};

			const result = await crawlGenreSeeds(
				{
					seed: "artist:unused",
					maxDepth: 0,
					maxNodes: 2,
					concurrency: 1,
					out: dir,
					deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
				},
				seeds,
			);

			expect(result).toMatchObject({ calls: 1, consumed: 1, failed: 0, refused: 1 });
			const written = await cache.get("artist:fixture-artist");
			if (written.type !== "artist") throw new Error("expected artist node");
			expect(written.genres).toEqual(
				expect.arrayContaining([{ type: "genre", slug: "genre:gabber", name: "Gabber", qid: "Q1085907" }]),
			);
			// The drafted genre (Techno, independently found by the pipeline) is untouched --
			// this only adds the folder's own verified link, never replaces existing edges.
			expect(written.genres.some((edge) => edge.slug === "genre:techno")).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"does not duplicate the folder's genre edge when the drafted target already cites it",
		async () => {
			const cache = new NodeCache(dir);
			await cache.write(genreNode({ slug: "genre:gabber", name: "Gabber", qid: "Q1085907" }));
			installPipelineMocks({
				draft: artistDraftFixture({ genres: [{ type: "genre", name: "Gabber" }] }),
			});
			const { crawlGenreSeeds } = await loadCrawl();
			const seeds: GenreSeeds = {
				Q1085907: {
					genre: { slug: "genre:gabber", name: "Gabber", qid: "Q1085907" },
					anchors: [],
					targets: [{ type: "artist", name: "Fixture Artist", slug: "artist:fixture-artist" }],
				},
			};

			await crawlGenreSeeds(
				{
					seed: "artist:unused",
					maxDepth: 0,
					maxNodes: 2,
					concurrency: 1,
					out: dir,
					deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
				},
				seeds,
			);

			const written = await cache.get("artist:fixture-artist");
			if (written.type !== "artist") throw new Error("expected artist node");
			expect(written.genres.filter((edge) => edge.slug === "genre:gabber")).toHaveLength(1);
		},
		TIMEOUT_MS,
	);

	it(
		"never attaches a genre edge whose folder genre failed to materialize in this same run (no dangling reference)",
		async () => {
			// A single artist-shaped draft is reused for every call: the "genre" stage (input.type
			// "genre") fails schema validation against it and is never written, while the "target"
			// stage (input.type "artist") succeeds -- the folder's genre is not pre-seeded, so it
			// genuinely doesn't exist anywhere in the cache when the target is written.
			installPipelineMocks({ draft: artistDraftFixture() });
			const { crawlGenreSeeds } = await loadCrawl();
			const cache = new NodeCache(dir);
			const seeds: GenreSeeds = {
				Q1085907: {
					genre: { slug: "genre:gabber", name: "Gabber", qid: "Q1085907" },
					anchors: [],
					targets: [{ type: "artist", name: "Fixture Artist", slug: "artist:fixture-artist" }],
				},
			};

			const result = await crawlGenreSeeds(
				{
					seed: "artist:unused",
					maxDepth: 0,
					maxNodes: 2,
					concurrency: 1,
					out: dir,
					deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
				},
				seeds,
			);

			expect(result).toMatchObject({ calls: 2, consumed: 2, failed: 1, refused: 0 });
			expect(await cache.has("genre:gabber")).toBe(false);
			const written = await cache.get("artist:fixture-artist");
			if (written.type !== "artist") throw new Error("expected artist node");
			expect(written.genres.some((edge) => edge.slug === "genre:gabber")).toBe(false);
		},
		TIMEOUT_MS,
	);

	it("reuses an existing genre by QID instead of materializing a second node", async () => {
		const cache = new NodeCache(dir);
		await cache.write(genreNode({ slug: "genre:cached-trap", name: "Trap Hip-Hop", qid: "Q2913982" }));
		const { crawlGenreSeeds } = await loadCrawl();
		const logs: string[] = [];

		const result = await crawlGenreSeeds(
			{
				seed: "artist:unused",
				maxDepth: 0,
				maxNodes: 1,
				concurrency: 1,
				out: dir,
				deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
				logger: (line) => logs.push(line),
			},
			{
				Q2913982: {
					genre: { slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q2913982" },
					anchors: [],
					targets: [],
				},
			},
		);

		expect(result.calls).toBe(0);
		expect(result.consumed).toBe(0);
		expect(result.refused).toBe(1);
		expect(logs.some((line) => line.includes("skip cached genre genre:Trap Hip-Hop"))).toBe(true);
		expect(await cache.has("genre:trap-hip-hop")).toBe(false);
	});
});

describe("backfillSeedGenres() (TRA-263)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-crawler-backfill-e2e-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function seeds(): GenreSeeds {
		return {
			Q1085907: {
				genre: { slug: "genre:gabber", name: "Gabber", qid: "Q1085907" },
				anchors: [],
				targets: [{ type: "artist", name: "Fixture Artist", slug: "artist:fixture-artist" }],
			},
		};
	}

	it(
		"rewrites a cached target missing the folder's genre edge, byte-identical otherwise, and links the second run to 0 writes",
		async () => {
			const cache = new NodeCache(dir);
			await cache.write(genreNode({ slug: "genre:gabber", name: "Gabber", qid: "Q1085907" }));
			const original = artistNode({
				slug: "artist:fixture-artist",
				name: "Fixture Artist",
				genres: [{ type: "genre", slug: "genre:rave", name: "Rave" }],
			});
			await cache.write(original);
			const { backfillSeedGenres } = await loadCrawl();

			const result = await backfillSeedGenres(
				{
					seed: "genre-seeds",
					maxDepth: 0,
					maxNodes: 10,
					concurrency: 1,
					out: dir,
					deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
				},
				seeds(),
			);

			expect(result).toEqual({ backfilled: 1, alreadyLinked: 0, missing: 0 });
			const relinked = await cache.get("artist:fixture-artist");
			if (relinked.type !== "artist") throw new Error("expected artist node");
			expect(relinked.genres).toEqual([
				{ type: "genre", slug: "genre:rave", name: "Rave" },
				{ type: "genre", slug: "genre:gabber", name: "Gabber", qid: "Q1085907" },
			]);
			// Nothing else moved -- same values. toEqual compares object identity, not raw JSON
			// text, so it's unaffected by NodeCache.replace() re-serializing the node through
			// nodePayloadSchema (which can reorder keys on disk without changing any value).
			expect(relinked).toEqual({ ...original, genres: relinked.genres });

			// Idempotence: a second run finds the edge already there and writes nothing.
			const second = await backfillSeedGenres(
				{
					seed: "genre-seeds",
					maxDepth: 0,
					maxNodes: 10,
					concurrency: 1,
					out: dir,
					deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
				},
				seeds(),
			);
			expect(second).toEqual({ backfilled: 0, alreadyLinked: 1, missing: 0 });
			expect(await cache.get("artist:fixture-artist")).toEqual(relinked);
		},
		TIMEOUT_MS,
	);

	it("counts a target not yet present in the cache as missing, without writing anything", async () => {
		const cache = new NodeCache(dir);
		await cache.write(genreNode({ slug: "genre:gabber", name: "Gabber", qid: "Q1085907" }));
		const { backfillSeedGenres } = await loadCrawl();

		const result = await backfillSeedGenres(
			{
				seed: "genre-seeds",
				maxDepth: 0,
				maxNodes: 10,
				concurrency: 1,
				out: dir,
				deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
			},
			seeds(),
		);

		expect(result).toEqual({ backfilled: 0, alreadyLinked: 0, missing: 1 });
		expect(await cache.has("artist:fixture-artist")).toBe(false);
	});
});

describe("refreshGenre() (TRA-63)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-crawler-refresh-e2e-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("refreshes one cached genre with its existing slug and QID", async () => {
		const cache = new NodeCache(dir);
		await cache.write(
			genreNode({
				slug: "genre:trap-hip-hop",
				name: "Trap Hip-Hop",
				qid: "Q2913982",
				editorial_definition: "The old definition must be replaced.",
			}),
		);
		// Name matches the cached genre being refreshed — the identity guard (TRA-XXX) must
		// let a genuine refresh (same entity, updated content) through unchanged.
		installPipelineMocks({ draft: genreDraftFixture({ name: "Trap Hip-Hop" }) });
		const { refreshGenre } = await loadCrawl();

		const result = await refreshGenre(
			{
				seed: "genre:unused",
				maxDepth: 0,
				maxNodes: 1,
				concurrency: 4,
				out: dir,
				deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
			},
			"genre:trap-hip-hop",
		);

		const refreshed = await cache.get("genre:trap-hip-hop");
		if (refreshed.type !== "genre") throw new Error("expected refreshed genre");
		expect(result).toMatchObject({ calls: 1, consumed: 1, failed: 0, refused: 0 });
		expect(refreshed).toMatchObject({ slug: "genre:trap-hip-hop", qid: "Q2913982" });
		expect(refreshed.editorial_definition).not.toBe("The old definition must be replaced.");
	});

	it("keeps the cached genre when its refresh fails", async () => {
		const cache = new NodeCache(dir);
		const original = genreNode({
			slug: "genre:trap-hip-hop",
			name: "Trap Hip-Hop",
			qid: "Q2913982",
			editorial_definition: "The definition that must remain after failure.",
		});
		await cache.write(original);
		installPipelineMocks({ draft: artistDraftFixture() });
		const { refreshGenre } = await loadCrawl();

		const result = await refreshGenre(
			{
				seed: "genre:unused",
				maxDepth: 0,
				maxNodes: 1,
				concurrency: 1,
				out: dir,
				deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
			},
			"genre:trap-hip-hop",
		);

		expect(result).toMatchObject({ calls: 1, consumed: 1, failed: 1, refused: 0 });
		expect(await cache.get("genre:trap-hip-hop")).toEqual(original);
	});

	it("restores the cached genre when writing refreshed reverse edges fails", async () => {
		const cache = new NodeCache(dir);
		const original = genreNode({
			slug: "genre:trap-hip-hop",
			name: "Trap Hip-Hop",
			qid: "Q2913982",
			editorial_definition: "The definition that must survive a late cache write failure.",
		});
		await cache.write(original);
		const genreDir = join(dir, "nodes", "genre");
		await mkdir(genreDir, { recursive: true });
		await writeFile(join(genreDir, "electronic.json"), JSON.stringify({ type: "genre" }), "utf8");
		// Name matches the cached genre so the identity guard (TRA-XXX) doesn't short-circuit
		// before cache.replace runs — this test is specifically about the write failing, not
		// about identity drift.
		installPipelineMocks({ draft: genreDraftFixture({ name: "Trap Hip-Hop" }) });
		const { refreshGenre } = await loadCrawl();

		const result = await refreshGenre(
			{
				seed: "genre:unused",
				maxDepth: 0,
				maxNodes: 1,
				concurrency: 1,
				out: dir,
				deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
			},
			"genre:trap-hip-hop",
		);

		expect(result).toMatchObject({
			nodesWritten: 0,
			revUpdates: 0,
			calls: 1,
			consumed: 1,
			failed: 1,
			refused: 0,
			coverage: { total: 1, written: 0, failed: 1, refused: 0 },
		});
		expect(await cache.get("genre:trap-hip-hop")).toEqual(original);
	});

	it("refuses a refresh once the maxNodes budget is exhausted", async () => {
		const cache = new NodeCache(dir);
		const original = genreNode({ slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q2913982" });
		await cache.write(original);
		installPipelineMocks({ draft: genreDraftFixture() });
		const { refreshGenre } = await loadCrawl();

		const result = await refreshGenre(
			{
				seed: "genre:unused",
				maxDepth: 0,
				maxNodes: 0,
				concurrency: 1,
				out: dir,
				deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
			},
			"genre:trap-hip-hop",
		);

		expect(result).toMatchObject({ calls: 0, consumed: 0, failed: 0, refused: 1 });
		expect(await cache.get("genre:trap-hip-hop")).toEqual(original);
	});
});

describe("refreshGenre() seed dossier QID + neighbor preservation (TRA-252)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-crawler-refresh-tra252-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const baseOpts = (dir: string): CrawlOptions => ({
		seed: "genre:unused",
		maxDepth: 0,
		maxNodes: 1,
		concurrency: 1,
		out: dir,
		deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
	});

	it("inherits the seed dossier's QID onto a refreshed node that has none cached yet", async () => {
		const cache = new NodeCache(dir);
		await cache.write(genreNode({ slug: "genre:trap-hip-hop", name: "Trap Hip-Hop" }));
		installPipelineMocks({ draft: genreDraftFixture({ name: "Trap Hip-Hop" }) });
		const { refreshGenre } = await loadCrawl();
		const folder: GenreSeeds[string] = {
			genre: { slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q2913982" },
			anchors: [],
			targets: [],
		};

		const result = await refreshGenre(baseOpts(dir), "genre:trap-hip-hop", folder);

		const refreshed = await cache.get("genre:trap-hip-hop");
		if (refreshed.type !== "genre") throw new Error("expected refreshed genre");
		expect(result).toMatchObject({ calls: 1, consumed: 1, failed: 0, refused: 0 });
		expect(refreshed.qid).toBe("Q2913982");
	});

	it("refuses a refresh whose dossier QID contradicts the cached node's QID, without writing", async () => {
		const cache = new NodeCache(dir);
		const original = genreNode({ slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q2913982" });
		await cache.write(original);
		// No mocks armed: a contradiction must be refused before any pipeline call, so an
		// "unexpected call" throw here would itself prove the guard ran too late.
		const { refreshGenre } = await loadCrawl();
		const folder: GenreSeeds[string] = {
			genre: { slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q9999999" },
			anchors: [],
			targets: [],
		};

		const result = await refreshGenre(baseOpts(dir), "genre:trap-hip-hop", folder);

		expect(result).toMatchObject({ calls: 0, consumed: 0, failed: 0, refused: 1 });
		expect(await cache.get("genre:trap-hip-hop")).toEqual(original);
	});

	it("keeps an old edge whose target is still cached (alive) that the fresh draft doesn't re-surface", async () => {
		const cache = new NodeCache(dir);
		await cache.write(projectNode({ slug: "project:old-alive-landmark", name: "Old Alive Landmark" }));
		await cache.write(
			genreNode({
				slug: "genre:trap-hip-hop",
				name: "Trap Hip-Hop",
				qid: "Q2913982",
				landmark_projects: [
					{ type: "project", name: "Old Alive Landmark", slug: "project:old-alive-landmark" },
				],
			}),
		);
		// landmark_projects isn't in the default fixture (and unlike parent_genres, an empty
		// list here isn't backfilled by pipeline.ts's Wikidata catalog step), so the fresh draft
		// has none of its own, isolating what the merge carries forward.
		installPipelineMocks({ draft: genreDraftFixture({ name: "Trap Hip-Hop" }) });
		const { refreshGenre } = await loadCrawl();

		await refreshGenre(baseOpts(dir), "genre:trap-hip-hop");

		const refreshed = await cache.get("genre:trap-hip-hop");
		if (refreshed.type !== "genre") throw new Error("expected refreshed genre");
		expect(refreshed.landmark_projects).toEqual([
			{ type: "project", name: "Old Alive Landmark", slug: "project:old-alive-landmark" },
		]);
	});

	it("does not duplicate an old edge the fresh draft already re-surfaces under the same slug", async () => {
		const cache = new NodeCache(dir);
		await cache.write(genreNode({ slug: "genre:old-alive-parent", name: "Old Alive Parent" }));
		await cache.write(
			genreNode({
				slug: "genre:trap-hip-hop",
				name: "Trap Hip-Hop",
				qid: "Q2913982",
				parent_genres: [{ type: "genre", name: "Old Alive Parent", slug: "genre:old-alive-parent" }],
			}),
		);
		// Fresh draft re-surfaces the very same parent under the same name/slug.
		installPipelineMocks({
			draft: genreDraftFixture({
				name: "Trap Hip-Hop",
				parent_genres: [{ type: "genre", name: "Old Alive Parent" }],
			}),
		});
		const { refreshGenre } = await loadCrawl();

		await refreshGenre(baseOpts(dir), "genre:trap-hip-hop");

		const refreshed = await cache.get("genre:trap-hip-hop");
		if (refreshed.type !== "genre") throw new Error("expected refreshed genre");
		expect(refreshed.parent_genres).toEqual([
			{ type: "genre", name: "Old Alive Parent", slug: "genre:old-alive-parent" },
		]);
	});

	// 2026-09-17 (review de #233): an inherited qid makes canonicalizeNodeEdges drop the fresh draft's
	// edge to an unmerged duplicate of that qid. The merge must not carry the cached one back in.
	it("drops an old edge pointing at an unmerged duplicate of the node's own qid", async () => {
		const cache = new NodeCache(dir);
		await cache.write(genreNode({ slug: "genre:trap-duplicate", name: "Trap Duplicate", qid: "Q2913982" }));
		await cache.write(
			genreNode({
				slug: "genre:trap-hip-hop",
				name: "Trap Hip-Hop",
				related_genres: [
					{ type: "genre", name: "Trap Duplicate", slug: "genre:trap-duplicate", qid: "Q2913982" },
				],
			}),
		);
		installPipelineMocks({ draft: genreDraftFixture({ name: "Trap Hip-Hop" }) });
		const { refreshGenre } = await loadCrawl();
		const folder: GenreSeeds[string] = {
			genre: { slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q2913982" },
			anchors: [],
			targets: [],
		};

		await refreshGenre(baseOpts(dir), "genre:trap-hip-hop", folder);

		const refreshed = await cache.get("genre:trap-hip-hop");
		if (refreshed.type !== "genre") throw new Error("expected refreshed genre");
		expect(refreshed.qid).toBe("Q2913982");
		expect(refreshed.related_genres.map((edge) => edge.slug)).not.toContain("genre:trap-duplicate");
	});

	// 2026-09-17 (2e review de #233): the pipeline resolves an edge's qid from its name when the edge
	// carries none, so a survivor without an inline qid could re-inject a duplicate of the node's own.
	it("drops an old edge with no inline qid whose name resolves to the node's own qid", async () => {
		const cache = new NodeCache(dir);
		await cache.write(genreNode({ slug: "genre:trap-dupe-no-qid", name: "Trap" }));
		await cache.write(
			genreNode({
				slug: "genre:trap-hip-hop",
				name: "Trap Hip-Hop",
				// No qid on the edge: the resolver maps the MusicBrainz genre "trap" to Q2913982.
				related_genres: [{ type: "genre", name: "Trap", slug: "genre:trap-dupe-no-qid" }],
			}),
		);
		installPipelineMocks({ draft: genreDraftFixture({ name: "Trap Hip-Hop" }) });
		const { refreshGenre } = await loadCrawl();
		const folder: GenreSeeds[string] = {
			genre: { slug: "genre:trap-hip-hop", name: "Trap Hip-Hop", qid: "Q2913982" },
			anchors: [],
			targets: [],
		};

		await refreshGenre(baseOpts(dir), "genre:trap-hip-hop", folder);

		const refreshed = await cache.get("genre:trap-hip-hop");
		if (refreshed.type !== "genre") throw new Error("expected refreshed genre");
		expect(refreshed.qid).toBe("Q2913982");
		expect(refreshed.related_genres.map((edge) => edge.slug)).not.toContain("genre:trap-dupe-no-qid");
	});

	it("drops an old edge whose target is no longer cached (dead)", async () => {
		const cache = new NodeCache(dir);
		await cache.write(
			genreNode({
				slug: "genre:trap-hip-hop",
				name: "Trap Hip-Hop",
				qid: "Q2913982",
				// project:old-dead-landmark was never written to this cache -- a dead neighbor.
				landmark_projects: [
					{ type: "project", name: "Old Dead Landmark", slug: "project:old-dead-landmark" },
				],
			}),
		);
		installPipelineMocks({ draft: genreDraftFixture({ name: "Trap Hip-Hop" }) });
		const { refreshGenre } = await loadCrawl();

		await refreshGenre(baseOpts(dir), "genre:trap-hip-hop");

		const refreshed = await cache.get("genre:trap-hip-hop");
		if (refreshed.type !== "genre") throw new Error("expected refreshed genre");
		expect(refreshed.landmark_projects).toEqual([]);
	});
});

describe("CLI genre seed mode (TRA-62)", () => {
	it("requires one family or genre selection and keeps the text mode distinct", async () => {
		const { program, resolveCliMode, runGenreSeedCrawl, selectGenreSeeds } = await loadCli();
		const genreSeedsPath = "data/genre-seeds.json";
		const runCommand = program.commands.find((command) => command.name() === "run");
		const familyMode = resolveCliMode({ genreSeeds: genreSeedsPath, family: "house-techno" });
		if (familyMode.kind !== "genre-seeds") throw new Error("expected genre seed mode");
		const selected = selectGenreSeeds(cliSeeds(), familyMode, {
			families: [{ key: "house-techno" }],
			genres: [{ id: "Q1", family: "house-techno" }],
		});

		expect(familyMode).toEqual({ kind: "genre-seeds", path: genreSeedsPath, family: "house-techno" });
		expect(Object.keys(selected)).toEqual(["Q1"]);
		expect(runCommand?.options.map((option) => option.long)).toEqual(
			expect.arrayContaining(["--genre-seeds", "--genre-id", "--family", "--refresh-genre"]),
		);
		expect(runCommand?.options.find((option) => option.long === "--max-nodes")?.mandatory).toBe(true);
		expect(runCommand?.options.find((option) => option.long === "--out")?.mandatory).toBe(true);

		let received: { options: CrawlOptions; seeds: GenreSeeds } | undefined;
		await runGenreSeedCrawl(
			{
				seed: "genre-seeds",
				maxDepth: 0,
				maxNodes: 3,
				concurrency: 1,
				out: "cache-output",
				deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
			},
			selected,
			async (options, seeds) => {
				received = { options, seeds };
				return {};
			},
		);
		expect(received).toMatchObject({ options: { maxNodes: 3, out: "cache-output" }, seeds: selected });
		expect(resolveCliMode({ seed: "artist:Fixture Artist", maxDepth: 2 })).toEqual({
			kind: "text",
			seed: "artist:Fixture Artist",
			maxDepth: 2,
		});
		expect(resolveCliMode({ refreshGenre: "genre:q1" })).toEqual({ kind: "genre-refresh", slug: "genre:q1" });
	});

	// TRA-252: --genre-seeds names the dossier registry to look the refreshed genre's QID up
	// in. It's compatible with --refresh-genre (unlike --genre-id/--family, still exclusive),
	// and findGenreSeedFolder locates the dossier by its own genre slug, not the taxonomy key.
	it("accepts --genre-seeds alongside --refresh-genre and resolves the matching dossier by slug", async () => {
		const { resolveCliMode, findGenreSeedFolder } = await loadCli();
		const genreSeedsPath = "data/genre-seeds.json";

		expect(resolveCliMode({ refreshGenre: "genre:q2", genreSeeds: genreSeedsPath })).toEqual({
			kind: "genre-refresh",
			slug: "genre:q2",
			genreSeedsPath,
		});
		expect(() =>
			resolveCliMode({ refreshGenre: "genre:q1", genreSeeds: genreSeedsPath, genreId: "Q1" }),
		).toThrow("exclusive of --genre-id and --family");

		expect(findGenreSeedFolder(cliSeeds(), "genre:q2")).toEqual(cliSeeds().Q2);
		expect(findGenreSeedFolder(cliSeeds(), "genre:unknown")).toBeUndefined();
	});

	it("rejects missing, conflicting, and text-only selectors before crawler setup", async () => {
		const { resolveCliMode } = await loadCli();
		const genreSeedsPath = "data/genre-seeds.json";

		expect(() => resolveCliMode({ genreSeeds: genreSeedsPath })).toThrow(
			"exactly one of --genre-id or --family",
		);
		expect(() =>
			resolveCliMode({ seed: "artist:Fixture Artist", genreSeeds: genreSeedsPath, genreId: "Q1" }),
		).toThrow("exclusive of --seed");
		expect(() =>
			resolveCliMode({ genreSeeds: genreSeedsPath, genreId: "Q1", family: "house-techno" }),
		).toThrow("exactly one of --genre-id or --family");
		expect(() => resolveCliMode({ family: "house-techno" })).toThrow("require --genre-seeds");
	});

	// TRA-263: --backfill-seed-genres only rewrites nodes already read from a --genre-seeds
	// plan -- it has no seed source of its own, so it can't run without one.
	it("rejects --backfill-seed-genres without --genre-seeds", async () => {
		const { resolveCliMode } = await loadCli();

		expect(() => resolveCliMode({ backfillSeedGenres: true, genreId: "Q1" })).toThrow(
			"--backfill-seed-genres requires --genre-seeds",
		);
		expect(() =>
			resolveCliMode({
				genreSeeds: "data/genre-seeds.json",
				genreId: "Q1",
				backfillSeedGenres: true,
			}),
		).not.toThrow();
	});
});

describe("CLI genre-seeds mode validates the taxonomy canonically (TRA-231)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-cli-taxonomy-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	// Fixtures live in a temp dir, never in data/genre-taxonomy.json.
	async function writeFixtures(taxonomy: unknown, seeds: unknown = {}): Promise<{ seedsPath: string }> {
		const seedsPath = join(dir, "genre-seeds.json");
		await writeFile(join(dir, "genre-taxonomy.json"), JSON.stringify(taxonomy), "utf8");
		await writeFile(seedsPath, JSON.stringify(seeds), "utf8");
		return { seedsPath };
	}

	// Bug reproduction (TRA-231): with an empty seeds file, loadGenreSeeds (src/genre-seeds.ts)
	// returns before ever validating the taxonomy, so the taxonomy load in cli.ts's genre-seeds
	// mode is the only gate. Before this fix, that gate was a local, homonymous
	// `loadGenreTaxonomy` doing minimal type-only parsing -- it silently accepted duplicate
	// genre ids, and the failure only surfaced later, confusingly, as selectGenreSeeds's own
	// "No genre seed found for --genre-id" (a duplicated id can never resolve a unique seed).
	it("rejects a taxonomy with duplicate genre ids using the canonical loader's message", async () => {
		const { resolveCliMode, readGenreTaxonomy } = await loadCli();
		const { seedsPath } = await writeFixtures({
			version: 2,
			families: [{ key: "house-techno", label: "House / Techno", order: 0 }],
			genres: [
				{ id: "Q1", qid: "Q1", name: "Foo", family: "house-techno", published: true },
				{ id: "Q1", qid: "Q1", name: "Bar", family: "house-techno", published: true },
			],
		});
		const mode = resolveCliMode({ genreSeeds: seedsPath, genreId: "Q1" });
		if (mode.kind !== "genre-seeds") throw new Error("expected genre seed mode");
		const taxonomyPath = join(dirname(mode.path), "genre-taxonomy.json");

		await expect(readGenreTaxonomy(taxonomyPath)).rejects.toThrow("Genre ids must be unique");
	});

	it("rejects a taxonomy genre referencing an undeclared family, distinct from the --family selector error", async () => {
		const { resolveCliMode, readGenreTaxonomy } = await loadCli();
		const { seedsPath } = await writeFixtures({
			version: 2,
			families: [{ key: "house-techno", label: "House / Techno", order: 0 }],
			genres: [{ id: "Q1", qid: "Q1", name: "Foo", family: "ghost-family", published: true }],
		});
		const mode = resolveCliMode({ genreSeeds: seedsPath, genreId: "Q1" });
		if (mode.kind !== "genre-seeds") throw new Error("expected genre seed mode");
		const taxonomyPath = join(dirname(mode.path), "genre-taxonomy.json");

		// Canonical message has no colon ("Unknown genre family <x>"). selectGenreSeeds's own
		// --family selector check throws a differently worded, colon-prefixed message
		// ("Unknown genre family: <x>") for an unrecognized --family flag -- easy to confuse
		// with this one, so pin the exact text.
		await expect(readGenreTaxonomy(taxonomyPath)).rejects.toThrow("Unknown genre family ghost-family");
	});

	it("keeps accepting a valid taxonomy and reaches genre-seed selection unchanged", async () => {
		const { resolveCliMode, readGenreTaxonomy, selectGenreSeeds } = await loadCli();
		const { loadGenreSeeds } = await import("../src/genre-seeds.js");
		const { seedsPath } = await writeFixtures(
			{
				version: 2,
				families: [{ key: "house-techno", label: "House / Techno", order: 0 }],
				genres: [{ id: "Q1", qid: "Q1", name: "Foo", family: "house-techno", published: true }],
			},
			{ Q1: { genre: { slug: "genre:foo", name: "Foo", qid: "Q1" }, targets: [], anchors: [] } },
		);
		const mode = resolveCliMode({ genreSeeds: seedsPath, genreId: "Q1" });
		if (mode.kind !== "genre-seeds") throw new Error("expected genre seed mode");
		const taxonomyPath = join(dirname(mode.path), "genre-taxonomy.json");

		const taxonomy = await readGenreTaxonomy(taxonomyPath);
		const seeds = await loadGenreSeeds(mode.path, taxonomyPath);
		const selected = selectGenreSeeds(seeds, mode, taxonomy);

		expect(Object.keys(selected)).toEqual(["Q1"]);
		expect(selected.Q1?.genre.qid).toBe("Q1");
	});
});

// TRA-476: a depth-1 crawl with the pipeline stubbed (Gemini and the MusicBrainz identity are not what is
// under test; the crawler's frontier and its repointing of the requesting edge are).
describe("crawl() artist context and edge reconciliation (TRA-476)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-crawler-tra476-"));
		pipelineStub.impl = undefined;
		pipelineStub.calls.length = 0;
	});

	afterEach(async () => {
		pipelineStub.impl = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	function trackNode(overrides: Partial<TrackNode> & { slug: Slug; name: string }): TrackNode {
		return {
			type: "track",
			editorial_article:
				"A real long article about this track, well past the eighty character floor. ".repeat(2),
			editorial_teaser: "A short teaser.",
			citations: [{ url: "https://example.com/track" }],
			materialized_at: new Date().toISOString(),
			artists: [],
			genres: [],
			producers: [],
			personnel: [],
			samples: [],
			sampled_by: [],
			remixed_by: [],
			...overrides,
		};
	}

	function stubResult(node: NodePayload, requestedSlug?: Slug): PipelineResult {
		return {
			node,
			slug: node.slug,
			...(requestedSlug ? { requestedSlug } : {}),
			metrics: {} as PipelineResult["metrics"], // the crawler never reads it
		};
	}

	async function runCrawl(seed: string, logs: string[] = []) {
		const { crawl } = await loadCrawl();
		return crawl({
			seed,
			maxDepth: 1,
			maxNodes: 20,
			concurrency: 1,
			out: dir,
			deps: { tavilyApiKey: "test", firecrawlApiKey: "test" },
			logger: (s) => logs.push(s),
		});
	}

	const FITNA_MBID = "11111111-2222-3333-4444-555555555555";

	it(
		"materializes Rohff's own Fitna next to Akuma's cached one, with the artist and mbid of the edge",
		async () => {
			const cache = new NodeCache(dir);
			const akumaFitna = trackNode({
				slug: "track:fitna--akuma",
				name: "Fitna",
				artists: [{ type: "artist", slug: "artist:akuma", name: "Akuma" }],
			});
			await cache.write(akumaFitna);
			const rohffFitna = trackNode({
				slug: "track:fitna--rohff",
				name: "Fitna",
				artists: [{ type: "artist", slug: "artist:rohff", name: "Rohff" }],
			});
			pipelineStub.impl = async (input) =>
				stubResult(
					input.type === "artist"
						? artistNode({
								slug: "artist:rohff",
								name: "Rohff",
								notable_tracks: [
									{
										type: "track",
										slug: "track:fitna--rohff",
										name: "Fitna",
										artist: "Rohff",
										mbid: FITNA_MBID,
									},
								],
							})
						: rohffFitna,
				);

			const result = await runCrawl("artist:Rohff");

			const trackCall = pipelineStub.calls.find((c) => c.type === "track");
			expect(trackCall).toMatchObject({
				slug: "track:fitna--rohff",
				name: "Fitna",
				artist: "Rohff",
				mbid: FITNA_MBID,
			});
			expect(await cache.has("track:fitna--rohff")).toBe(true);
			expect(await cache.get("track:fitna--akuma")).toEqual(akumaFitna);
			const rohff = await cache.get("artist:rohff");
			if (rohff.type !== "artist") throw new Error("expected artist node");
			expect(rohff.notable_tracks.map((e) => e.slug)).toEqual(["track:fitna--rohff"]);
			expect(result.reconciled).toBe(0);
		},
		TIMEOUT_MS,
	);

	it(
		"repoints the requesting edge to the canonical slug and credit the pipeline learned (Roni Size / Reprazent)",
		async () => {
			const NEW_FORMS_MBID = "66666666-7777-8888-9999-000000000000";
			const requested = "project:new-forms--roni-size" as Slug;
			const canonical = "project:new-forms--roni-size-reprazent" as Slug;
			pipelineStub.impl = async (input) =>
				input.type === "artist"
					? stubResult(
							artistNode({
								slug: "artist:roni-size",
								name: "Roni Size",
								discography: [
									{ type: "project", slug: requested, name: "New Forms", artist: "Roni Size", year: "1997" },
								],
							}),
						)
					: stubResult(
							projectNode({
								slug: canonical,
								name: "New Forms",
								mbid: NEW_FORMS_MBID,
								artists: [
									{ type: "artist", slug: "artist:roni-size-reprazent", name: "Roni Size / Reprazent" },
								],
							}),
							requested,
						);
			const logs: string[] = [];

			const result = await runCrawl("artist:Roni Size", logs);

			const cache = new NodeCache(dir);
			expect(result.reconciled).toBe(1);
			expect(result.reconcileFailed).toBe(0);
			// Rewriting the parent is not a materialization: it must not eat the maxNodes budget.
			expect(result.nodesWritten).toBe(2);
			expect(await cache.has(canonical)).toBe(true);
			expect(await cache.has(requested)).toBe(false);
			const parent = await cache.get("artist:roni-size");
			if (parent.type !== "artist") throw new Error("expected artist node");
			expect(parent.discography).toEqual([
				{
					type: "project",
					slug: canonical,
					name: "New Forms",
					artist: "Roni Size / Reprazent",
					mbid: NEW_FORMS_MBID,
					year: "1997",
				},
			]);
			// The invariant: no edge of the parent cites a slug without a file.
			for (const edge of parent.discography) expect(await cache.has(edge.slug)).toBe(true);
			expect(logs.some((l) => l.includes(`reconciled artist:roni-size.discography: ${requested}`))).toBe(
				true,
			);
		},
		TIMEOUT_MS,
	);
});
