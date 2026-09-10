import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
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
	return (await import("../src/crawler.js")).crawl;
}

const ELECTRONIC_MBID = "89255676-1f14-4dd8-bbad-fca839d6aff4";
const ELECTRONIC_QID = "Q9778";
const TIMEOUT_MS = 5_000;

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
			const crawl = await loadCrawl();

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
