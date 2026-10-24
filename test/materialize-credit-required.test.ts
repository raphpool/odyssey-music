import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ApiEnv } from "../src/env.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry } from "../src/genre-registry.js";
import { classifyGenerationFailure } from "../src/mobile/generation-errors.js";
import type { ProjectNode, Slug } from "../src/types.js";
import { installPipelineMocks, projectDraftFixture, trackDraftFixture } from "./helpers/pipeline-mocks.js";

// TRA-485: what the HTTP route and the mobile contract see when the pipeline refuses to create a work
// nobody is credited on. server.ts turns any AppError into its `status`; the mobile generation worker
// runs the failure through classifyGenerationFailure. Dynamic imports, for the reason given in
// test/materialize-service.test.ts: the module graph must load after the vi.mock() calls of the helpers.

const ENV: ApiEnv = { GEMINI_API_KEY: "test", TAVILY_API_KEY: "test", FIRECRAWL_API_KEY: "test" };
const TIMEOUT_MS = 5_000;
const PROSE = "A fictional work, long enough to satisfy the node schema. ".repeat(4);

describe("materialize service: a work nobody is credited on (TRA-485)", () => {
	let dir: string;
	let cache: NodeCache;
	const invalidateCacheIndex = vi.fn();

	beforeEach(async () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		dir = await mkdtemp(join(tmpdir(), "odyssey-materialize-uncredited-"));
		cache = new NodeCache(dir);
		invalidateCacheIndex.mockClear();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	async function buildService() {
		const genreRegistry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const { createMaterializeService } = await import("../src/services/materialize-service.js");
		return createMaterializeService({ cache, env: ENV, genreRegistry, invalidateCacheIndex });
	}

	/** The LLM names nobody and MusicBrainz finds no work. */
	async function nobodyCredits(draft: Record<string, unknown>) {
		installPipelineMocks({ draft });
		const mb = await import("../src/musicbrainz.js");
		vi.mocked(mb.resolveReleaseGroup).mockImplementation(async () => null);
		vi.mocked(mb.resolveRecording).mockImplementation(async () => null);
		vi.mocked(mb.fetchEntityGenresMb).mockImplementation(async () => []);
	}

	function legacyProject(slug: Slug): ProjectNode {
		return {
			type: "project",
			slug,
			name: "Legacy Album",
			editorial_article: PROSE,
			editorial_pitch: "A fixture album written before the credit rule.",
			citations: [{ url: "https://example.com/legacy-album" }],
			materialized_at: "2026-01-01T00:00:00.000Z",
			artists: [],
			genres: [],
			tracklist: [],
			producers: [],
			personnel: [],
			related_projects: [],
		};
	}

	it(
		"answers 502 for a new project and writes nothing",
		async () => {
			await nobodyCredits(projectDraftFixture("Orphan Album", "x", { artists: [] }));
			const service = await buildService();

			const failure = await service
				.handleMaterialize({ type: "project", name: "Orphan Album", artist: "Roni Size" })
				.catch((e) => e);

			// server.ts answers `e.status` for an AppError, 500 otherwise.
			expect(failure).toMatchObject({ name: "UncreditedWorkError", status: 502 });
			expect(await cache.listSlugs()).toEqual([]);
			expect(invalidateCacheIndex).not.toHaveBeenCalled();
		},
		TIMEOUT_MS,
	);

	it(
		"answers 502 for a new track and writes nothing",
		async () => {
			await nobodyCredits(trackDraftFixture("Orphan Song", "x", { artists: [] }));
			const service = await buildService();

			await expect(
				service.handleMaterialize({ type: "track", name: "Orphan Song", artist: "Roni Size" }),
			).rejects.toMatchObject({ status: 502 });

			expect(await cache.listSlugs()).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"creates a new project the draft credits",
		async () => {
			await nobodyCredits(projectDraftFixture("New Forms", "Roni Size"));
			const service = await buildService();

			const result = await service.handleMaterialize({
				type: "project",
				name: "New Forms",
				artist: "Roni Size",
			});

			expect(result.source).toBe("jit");
			expect(await cache.has(result.node.slug)).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"refreshes a legacy project without a credit in place when fresh is asked",
		async () => {
			const slug = "project:legacy-album--roni-size" as Slug;
			await cache.write(legacyProject(slug));
			await nobodyCredits(projectDraftFixture("Legacy Album", "x", { artists: [] }));
			const service = await buildService();

			const result = await service.handleMaterialize(
				{ type: "project", name: "Legacy Album", artist: "Roni Size" },
				{ fresh: true },
			);

			expect(result.source).toBe("jit");
			expect(result.node.slug).toBe(slug);
			const stored = (await cache.get(slug)) as ProjectNode;
			expect(stored.artists).toEqual([]);
			expect(stored.materialized_at).not.toBe("2026-01-01T00:00:00.000Z");
		},
		TIMEOUT_MS,
	);

	it(
		"does not let a refresh erase the credit of a work that has one",
		async () => {
			const slug = "project:legacy-album--roni-size" as Slug;
			const credited = {
				...legacyProject(slug),
				artists: [{ slug: "artist:roni-size" as Slug, type: "artist" as const, name: "Roni Size" }],
			};
			await cache.write(credited);
			await nobodyCredits(projectDraftFixture("Legacy Album", "x", { artists: [] }));
			const service = await buildService();

			await expect(
				service.handleMaterialize(
					{ type: "project", name: "Legacy Album", artist: "Roni Size" },
					{ fresh: true },
				),
			).rejects.toMatchObject({ status: 502 });

			expect(((await cache.get(slug)) as ProjectNode).artists.map((a) => a.slug)).toEqual([
				"artist:roni-size",
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"keeps serving a legacy project without a credit from the cache, without running the pipeline",
		async () => {
			const slug = "project:legacy-album--roni-size" as Slug;
			await cache.write(legacyProject(slug));
			await nobodyCredits(projectDraftFixture("Legacy Album", "x", { artists: [] }));
			const { tavilySearch } = await import("../src/tools/tavily.js");
			const service = await buildService();

			const result = await service.handleMaterialize({
				type: "project",
				name: "Legacy Album",
				artist: "Roni Size",
			});

			expect(result.source).toBe("cache");
			expect(vi.mocked(tavilySearch)).not.toHaveBeenCalled();
		},
		TIMEOUT_MS,
	);

	it(
		"reaches the mobile contract as a final internal_error, not a retryable provider failure",
		async () => {
			await nobodyCredits(projectDraftFixture("Orphan Album", "x", { artists: [] }));
			const service = await buildService();
			const failure = await service
				.handleMaterialize({ type: "project", name: "Orphan Album", artist: "Roni Size" })
				.catch((e) => e);

			expect(classifyGenerationFailure(failure)).toMatchObject({
				code: "internal_error",
				retryable: false,
				status: 500,
			});
		},
		TIMEOUT_MS,
	);
});
