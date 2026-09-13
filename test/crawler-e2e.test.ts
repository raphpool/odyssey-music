import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { CrawlOptions } from "../src/crawler.js";
import type { GenreSeeds } from "../src/genre-seeds.js";
import type { GenreNode, Slug } from "../src/types.js";
import { artistDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

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
			expect.arrayContaining(["--genre-seeds", "--genre-id", "--family"]),
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
});
