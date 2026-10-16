import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ApiEnv } from "../src/env.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry } from "../src/genre-registry.js";
import type { ArtistNode, EdgeRef } from "../src/types.js";
import { artistDraftFixture, DEFAULT_ARTIST_MBID, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-480: createMaterializeService hands its similar-artists resolver to the pipeline, which keys the
// lookup on the server's MBID only. Dynamic import for the same reason as test/materialize-image.test.ts.
async function loadCreateMaterializeService() {
	return (await import("../src/services/materialize-service.js")).createMaterializeService;
}

const ENV: ApiEnv = { GEMINI_API_KEY: "test", TAVILY_API_KEY: "test", FIRECRAWL_API_KEY: "test" };
const TIMEOUT_MS = 5_000;
const SLUG = "artist:fixture-artist";
const CLIENT_MBID = "11111111-2222-4333-8444-555555555555";
const SIMILAR: EdgeRef = {
	type: "artist",
	slug: "artist:autechre",
	name: "Autechre",
	mbid: "164f0d73-1234-4e29-9e5f-0cc9bb7f8a57",
};

describe("similar_artists through createMaterializeService (TRA-480)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-materialize-similar-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function build(similarArtists: (artist: ArtistNode) => Promise<EdgeRef[]>) {
		const genreRegistry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const createMaterializeService = await loadCreateMaterializeService();
		return createMaterializeService({ cache, env: ENV, genreRegistry, similarArtists });
	}

	it(
		"writes the similar artists on the node file",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const similarArtists = vi.fn(async (_artist: ArtistNode) => [SIMILAR]);
			const service = await build(similarArtists);

			await service.handleMaterialize({ type: "artist", name: "Fixture Artist" });

			expect(((await cache.get(SLUG)) as ArtistNode).similar_artists).toEqual([SIMILAR]);
			expect(similarArtists.mock.calls[0]?.[0].mbid).toBe(DEFAULT_ARTIST_MBID);
		},
		TIMEOUT_MS,
	);

	it(
		"never looks recommendations up with a client's mbid that MusicBrainz did not confirm",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const m = await import("../src/musicbrainz.js");
			vi.mocked(m.fetchArtistEntityMb).mockImplementation(async () => null);
			const similarArtists = vi.fn(async (_artist: ArtistNode) => [] as EdgeRef[]);
			const service = await build(similarArtists);

			await service.handleMaterialize({ type: "artist", name: "Fixture Artist", mbid: CLIENT_MBID });

			expect(similarArtists).toHaveBeenCalledTimes(1);
			expect(similarArtists.mock.calls[0]?.[0].mbid).toBeUndefined();
		},
		TIMEOUT_MS,
	);

	it(
		"still writes the node when the resolver throws",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const service = await build(async () => {
				throw new Error("listenbrainz is down");
			});

			const result = await service.handleMaterialize({ type: "artist", name: "Fixture Artist" });

			expect(result.node.slug).toBe(SLUG);
			expect(((await cache.get(SLUG)) as ArtistNode).similar_artists).toEqual([]);
		},
		TIMEOUT_MS,
	);
});
