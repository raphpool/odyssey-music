import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ApiEnv } from "../src/env.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry } from "../src/genre-registry.js";
import type { ArtistNode, GenreNode, Slug } from "../src/types.js";
import { artistDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-28 review: missing wiring test (ii) -- createMaterializeService (src/services/
// materialize-service.ts) must actually use the genreRegistry it's given, and that registry must
// be built on the SAME NodeCache instance handleMaterialize/runJit writes into (src/server.ts's
// contract). `createMaterializeService` is imported dynamically, exactly like runPipeline in
// test/pipeline-e2e.test.ts: its module graph statically pulls in pipeline.js ->
// musicbrainz.js/tavily.js/local-fetcher.js/@google/genai, which must stay mocked.
async function loadCreateMaterializeService() {
	return (await import("../src/services/materialize-service.js")).createMaterializeService;
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
