import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ApiEnv } from "../src/env.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry } from "../src/genre-registry.js";
import type { ArtistNode, GenreNode, Slug } from "../src/types.js";
import { artistDraftFixture, genreDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-28 review: missing wiring test (ii) -- createMaterializeService (src/services/
// materialize-service.ts) must actually use the genreRegistry it's given, and that registry must
// be built on the SAME NodeCache instance handleMaterialize/runJit writes into (src/server.ts's
// contract). `createMaterializeService` is imported dynamically, exactly like runPipeline in
// test/pipeline-e2e.test.ts: its module graph statically pulls in pipeline.js ->
// musicbrainz.js/tavily.js/local-fetcher.js/@google/genai, which must stay mocked.
async function loadCreateMaterializeService() {
	return (await import("../src/services/materialize-service.js")).createMaterializeService;
}

// Same dynamic-import rationale as above: a static `import { tavilySearch } from
// "../src/tools/tavily.js"` would get sorted (by Biome) ahead of the "./helpers/..." import that
// registers the vi.mock for it, loading the real module before the mock is in place.
async function loadTavilySearch() {
	return (await import("../src/tools/tavily.js")).tavilySearch;
}

const ELECTRONIC_MBID = "89255676-1f14-4dd8-bbad-fca839d6aff4";
const ELECTRONIC_QID = "Q9778";
const ENV: ApiEnv = { GEMINI_API_KEY: "test", TAVILY_API_KEY: "test", FIRECRAWL_API_KEY: "test" };
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

describe("createMaterializeService genre registry wiring (TRA-28 review)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-materialize-service-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it(
		"canonicalizes a genre edge using a registry built on the same NodeCache handleMaterialize writes into",
		async () => {
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});

			installPipelineMocks({
				draft: artistDraftFixture(),
				mbGenres: [{ name: "electronic music", mbid: ELECTRONIC_MBID }],
			});
			const createMaterializeService = await loadCreateMaterializeService();
			const service = createMaterializeService({ cache, env: ENV, genreRegistry });

			const result = await service.handleMaterialize({ type: "artist", name: "Fixture Artist" });

			const artist = result.node as ArtistNode;
			expect(artist.genres[0]?.slug).toBe("genre:electronic");
			// The write really landed on the SAME cache instance the registry was built on -- not
			// a second, disconnected one that would defeat the whole point of injecting it.
			expect(await cache.has("artist:fixture-artist")).toBe(true);
		},
		TIMEOUT_MS,
	);
});

// TRA-29: the guard in handleMaterialize itself -- for a genre request not already hitting the
// cache under its name-derived slug, ask the registry for the canonical slug before minting. A
// broken guard must fail fast and never touch the network: every test here first arms tavilySearch
// to reject with a distinctive message, so a guard that wrongly falls through to runJit surfaces
// immediately instead of hanging on a real (mocked-away) pipeline call. Only the "fresh" test
// (which is SUPPOSED to reach the pipeline, for the canonical target) re-arms the full mock suite.
describe("createMaterializeService genre canonicalization guard (TRA-29)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-materialize-guard-"));
		cache = new NodeCache(dir);
		const tavilySearch = await loadTavilySearch();
		vi.mocked(tavilySearch)
			.mockReset()
			.mockImplementation(async () => {
				throw new Error("unexpected pipeline run");
			});
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function genreFileCount(): Promise<number> {
		try {
			return (await readdir(join(dir, "nodes", "genre"))).length;
		} catch {
			return 0;
		}
	}

	it(
		"serves the canonical node for a name hashing to a redirected loser slug, minting nothing",
		async () => {
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic" }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map<Slug, Slug>([["genre:electronic-music", "genre:electronic"]]),
			});
			const createMaterializeService = await loadCreateMaterializeService();
			const service = createMaterializeService({ cache, env: ENV, genreRegistry });
			const filesBefore = await genreFileCount();

			const result = await service.handleMaterialize({ type: "genre", name: "Electronic music" });

			expect(result.node.slug).toBe("genre:electronic");
			expect(result.source).toBe("cache");
			expect(await genreFileCount()).toBe(filesBefore);
		},
		TIMEOUT_MS,
	);

	it(
		"serves the canonical node via the qid index when no redirect exists",
		async () => {
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});
			const createMaterializeService = await loadCreateMaterializeService();
			const service = createMaterializeService({ cache, env: ENV, genreRegistry });

			const result = await service.handleMaterialize({ type: "genre", name: "Electronic music" });

			expect(result.node.slug).toBe("genre:electronic");
			expect(result.source).toBe("cache");
		},
		TIMEOUT_MS,
	);

	it(
		"leaves a request that already hashes to an existing slug unchanged",
		async () => {
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic" }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});
			const createMaterializeService = await loadCreateMaterializeService();
			const service = createMaterializeService({ cache, env: ENV, genreRegistry });

			const result = await service.handleMaterialize({ type: "genre", name: "Electronic" });

			expect(result.node.slug).toBe("genre:electronic");
			expect(result.source).toBe("cache");
		},
		TIMEOUT_MS,
	);

	it(
		"does not swallow a legitimate mint for a genre the registry cannot canonicalize",
		async () => {
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});
			const createMaterializeService = await loadCreateMaterializeService();
			const service = createMaterializeService({ cache, env: ENV, genreRegistry });

			await expect(
				service.handleMaterialize({ type: "genre", name: "Totally Unresolvable Fixture Genre" }),
			).rejects.toThrow("unexpected pipeline run");
		},
		TIMEOUT_MS,
	);

	it(
		"refreshes the canonical node, never the redirected loser, when fresh is requested",
		async () => {
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map<Slug, Slug>([["genre:electronic-music", "genre:electronic"]]),
			});
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Electronic",
					parent_genres: [],
					subgenres: [],
					related_genres: [],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});
			const createMaterializeService = await loadCreateMaterializeService();
			const service = createMaterializeService({ cache, env: ENV, genreRegistry });

			const result = await service.handleMaterialize(
				{ type: "genre", name: "Electronic music" },
				{ fresh: true },
			);

			expect(result.node.slug).toBe("genre:electronic");
			const tavilySearch = await loadTavilySearch();
			const [, query] = vi.mocked(tavilySearch).mock.calls.at(-1) ?? [];
			expect(query).toContain("Electronic");
			expect(query).not.toContain("Electronic music");
		},
		TIMEOUT_MS,
	);
});
