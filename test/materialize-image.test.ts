import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ApiEnv } from "../src/env.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry } from "../src/genre-registry.js";
import { createImageService } from "../src/services/image-service.js";
import type { ArtistNode } from "../src/types.js";
import { artistDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-479: createMaterializeService hands its image resolver to the pipeline, and a node that gains
// an image is served by GET /image right away (the 24 h negative cache of TRA-475 must not outlive
// the write). Dynamic import for the same reason as test/materialize-service.test.ts.
async function loadCreateMaterializeService() {
	return (await import("../src/services/materialize-service.js")).createMaterializeService;
}

const ENV: ApiEnv = { GEMINI_API_KEY: "test", TAVILY_API_KEY: "test", FIRECRAWL_API_KEY: "test" };
const TIMEOUT_MS = 5_000;
const SLUG = "artist:fixture-artist";
const PHOTO = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Fixture_Artist.jpg";

describe("image at materialization, through createMaterializeService (TRA-479)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-materialize-image-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function build(opts: {
		resolveImage?: () => Promise<{ url: string; source: "wikidata-p18" } | null>;
	}) {
		const genreRegistry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const imageService = createImageService({ cache, redirects: new Map() });
		const createMaterializeService = await loadCreateMaterializeService();
		const service = createMaterializeService({
			cache,
			env: ENV,
			genreRegistry,
			// What src/server.ts wires: every write empties the image service's negative cache.
			invalidateCacheIndex: () => imageService.clearNegativeCache(),
			...(opts.resolveImage ? { resolveImage: opts.resolveImage } : {}),
		});
		return { service, imageService };
	}

	it(
		"writes the resolved image on the node file",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const resolveImage = vi.fn(async () => ({ url: PHOTO, source: "wikidata-p18" as const }));
			const { service } = await build({ resolveImage });

			await service.handleMaterialize({ type: "artist", name: "Fixture Artist" });

			const stored = (await cache.get(SLUG)) as ArtistNode;
			expect(stored.image_url).toBe(PHOTO);
			expect(stored.image_source).toBe("wikidata-p18");
			expect(resolveImage).toHaveBeenCalledTimes(1);
		},
		TIMEOUT_MS,
	);

	it(
		"still writes the node, without an image, when the resolver throws",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const { service } = await build({
				resolveImage: async () => {
					throw new Error("wikidata is down");
				},
			});

			const result = await service.handleMaterialize({ type: "artist", name: "Fixture Artist" });

			expect(result.node.slug).toBe(SLUG);
			const stored = (await cache.get(SLUG)) as ArtistNode;
			expect(stored.image_url).toBeUndefined();
		},
		TIMEOUT_MS,
	);

	it(
		"serves GET /image immediately after a no-match once a refresh gave the node an image",
		async () => {
			// First materialization has no resolver: the node is stored without an image.
			installPipelineMocks({ draft: artistDraftFixture() });
			const first = await build({});
			await first.service.handleMaterialize({ type: "artist", name: "Fixture Artist" });
			expect(await first.imageService.resolveDisplayImage(SLUG)).toMatchObject({
				image_url: null,
				source: "no-match",
			});

			// Same image service (and its remembered miss), now a refresh that resolves an image.
			installPipelineMocks({ draft: artistDraftFixture() });
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});
			const createMaterializeService = await loadCreateMaterializeService();
			const refresher = createMaterializeService({
				cache,
				env: ENV,
				genreRegistry,
				invalidateCacheIndex: () => first.imageService.clearNegativeCache(),
				resolveImage: async () => ({ url: PHOTO, source: "wikidata-p18" as const }),
			});
			await refresher.handleMaterialize(
				{ type: "artist", name: "Fixture Artist", slug: SLUG },
				{ fresh: true },
			);

			expect(await first.imageService.resolveDisplayImage(SLUG)).toEqual({
				slug: SLUG,
				image_url: PHOTO,
				source: "wikidata-p18",
				state: "found",
			});
		},
		TIMEOUT_MS,
	);
	describe("refresh (TRA-549)", () => {
		const NEW_PHOTO = "https://upload.wikimedia.org/wikipedia/commons/b/bc/Fixture_Artist_2.jpg";

		/** A node already in the cache with PHOTO, then `fresh` refreshed with the given resolver. */
		async function refreshWith(resolveImage: () => Promise<{ url: string; source: "wikidata-p18" } | null>) {
			installPipelineMocks({ draft: artistDraftFixture() });
			const seed = await build({
				resolveImage: async () => ({ url: PHOTO, source: "wikidata-p18" as const }),
			});
			await seed.service.handleMaterialize({ type: "artist", name: "Fixture Artist" });
			expect(((await cache.get(SLUG)) as ArtistNode).image_url).toBe(PHOTO);

			installPipelineMocks({ draft: artistDraftFixture() });
			const { service } = await build({ resolveImage });
			await service.handleMaterialize(
				{ type: "artist", name: "Fixture Artist", slug: SLUG },
				{ fresh: true },
			);
			return (await cache.get(SLUG)) as ArtistNode;
		}

		it(
			"keeps the stored image when the resolver finds nothing",
			async () => {
				const stored = await refreshWith(async () => null);
				expect(stored.image_url).toBe(PHOTO);
				expect(stored.image_source).toBe("wikidata-p18");
			},
			TIMEOUT_MS,
		);

		it(
			"keeps the stored image when the resolver throws",
			async () => {
				const stored = await refreshWith(async () => {
					throw new Error("wikidata is down");
				});
				expect(stored.image_url).toBe(PHOTO);
			},
			TIMEOUT_MS,
		);

		// 2026-10-16: this used to assert that a different client mbid dropped the image. Since TRA-546 (#475)
		// an artist or label that already carries an mbid keeps it whatever the request sends -- a client mbid
		// is a hint, never an identity change -- so such a refresh is the same entity and keeps its picture.
		// Symptom: the old premise left the stored image in place, failing this file on main after the merge.
		it(
			"keeps the stored image, and the cached mbid, when the refresh carries another client mbid",
			async () => {
				installPipelineMocks({ draft: artistDraftFixture() });
				const seed = await build({
					resolveImage: async () => ({ url: PHOTO, source: "wikidata-p18" as const }),
				});
				await seed.service.handleMaterialize({ type: "artist", name: "Fixture Artist" });
				const seeded = (await cache.get(SLUG)) as ArtistNode;
				const CACHED_MBID = "aaaaaaaa-1111-4111-8111-000000000001";
				await cache.write({ ...seeded, mbid: CACHED_MBID });

				installPipelineMocks({ draft: artistDraftFixture() });
				const { service } = await build({ resolveImage: async () => null });
				await service.handleMaterialize(
					{
						type: "artist",
						name: "Fixture Artist",
						slug: SLUG,
						mbid: "bbbbbbbb-2222-4222-8222-000000000002",
					},
					{ fresh: true },
				);

				const stored = (await cache.get(SLUG)) as ArtistNode;
				expect(stored.mbid).toBe(CACHED_MBID);
				expect(stored.image_url).toBe(PHOTO);
			},
			TIMEOUT_MS,
		);

		it(
			"replaces the stored image with a new valid one",
			async () => {
				const stored = await refreshWith(async () => ({ url: NEW_PHOTO, source: "wikidata-p18" as const }));
				expect(stored.image_url).toBe(NEW_PHOTO);
			},
			TIMEOUT_MS,
		);
	});
});
