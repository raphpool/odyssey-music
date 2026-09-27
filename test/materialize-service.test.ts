import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { ApiEnv } from "../src/env.js";
import { BadRequestError } from "../src/errors.js";
import { createGenreResolver, loadGenreResolver } from "../src/genre-identity.js";
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
// Not in the real committed catalog (there is no "trap" entry there) -- a synthetic in-memory
// resolver (motif test/genre-identity.test.ts:15-25) is the only way to exercise the qid-index
// rule (rule 4) for a name the real data doesn't cover.
const FAKE_TRAP_QID = "Q999999";
const ENV: ApiEnv = { GEMINI_API_KEY: "test", TAVILY_API_KEY: "test", FIRECRAWL_API_KEY: "test" };
const TIMEOUT_MS = 5_000;

function buildTrapResolver() {
	return createGenreResolver({
		catalog: [{ slug: "trap", name: "Trap", wikidata_qid: FAKE_TRAP_QID }],
		mbidToQid: new Map(),
		aliases: new Map(),
	});
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

	it(
		"keeps concurrent web and mobile retry policies in separate in-flight work in either arrival order (TRA-295)",
		async () => {
			for (const order of ["web-first", "mobile-first"] as const) {
				const generateContent = vi.fn(async () => {
					throw new Error("503 unavailable");
				});
				installPipelineMocks({ draft: artistDraftFixture(), generateContent });
				const createMaterializeService = await loadCreateMaterializeService();
				const service = createMaterializeService({
					cache,
					env: ENV,
					genreRegistry: createGenreRegistry({
						cache,
						resolver: await loadGenreResolver(),
						redirects: new Map(),
					}),
				});
				const web = () => service.handleMaterialize({ type: "artist", name: `Fixture ${order}` });
				const mobile = () =>
					service.handleMaterialize(
						{ type: "artist", name: `Fixture ${order}` },
						{ reuseExisting: true, maxProviderAttempts: 1 },
					);
				const results = await Promise.allSettled(
					order === "web-first" ? [web(), mobile()] : [mobile(), web()],
				);
				expect(results.every((result) => result.status === "rejected")).toBe(true);
				// Web gets its normal second attempt and mobile gets exactly one; sharing an
				// inflight key would produce one or two calls depending on the arrival order.
				expect(generateContent).toHaveBeenCalledTimes(3);
			}
		},
		TIMEOUT_MS,
	);

	it(
		"shares case-normalized mobile identities in one paid materialization (TRA-295)",
		async () => {
			const paidCalls = vi.fn(async () => ({
				text: JSON.stringify(artistDraftFixture({ name: "Aphex Twin" })),
				usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 42 },
			}));
			installPipelineMocks({ draft: artistDraftFixture({ name: "Aphex Twin" }), generateContent: paidCalls });
			const createMaterializeService = await loadCreateMaterializeService();
			const service = createMaterializeService({
				cache,
				env: ENV,
				genreRegistry: createGenreRegistry({
					cache,
					resolver: await loadGenreResolver(),
					redirects: new Map(),
				}),
			});

			const results = await Promise.all([
				service.handleMaterialize(
					{ type: "artist", name: "Aphex Twin" },
					{ reuseExisting: true, maxProviderAttempts: 1 },
				),
				service.handleMaterialize(
					{ type: "artist", name: "Áphex   Twin" },
					{ reuseExisting: true, maxProviderAttempts: 1 },
				),
				service.handleMaterialize(
					{ type: "artist", name: "Aphex Twin", disambiguator: "()" },
					{ reuseExisting: true, maxProviderAttempts: 1 },
				),
			]);

			expect(paidCalls).toHaveBeenCalledTimes(1);
			expect(results.map((result) => result.node.slug)).toEqual([
				"artist:aphex-twin",
				"artist:aphex-twin",
				"artist:aphex-twin",
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"does not cross-share same-name work when effective MBID, QID or disambiguator differs (TRA-295)",
		async () => {
			const cases = [
				{
					label: "mbid",
					draft: artistDraftFixture(),
					left: {
						type: "artist" as const,
						name: "Same Identity",
						mbid: "11111111-1111-1111-1111-111111111111",
					},
					right: {
						type: "artist" as const,
						name: "Same Identity",
						mbid: "22222222-2222-2222-2222-222222222222",
					},
				},
				{
					label: "qid",
					draft: genreDraftFixture(),
					left: { type: "genre" as const, name: "Same Genre", qid: "Q1" },
					right: { type: "genre" as const, name: "Same Genre", qid: "Q2" },
				},
				{
					label: "disambiguator",
					draft: artistDraftFixture(),
					left: { type: "artist" as const, name: "Same Artist", disambiguator: "One" },
					right: { type: "artist" as const, name: "Same Artist", disambiguator: "Two" },
				},
			] as const;
			for (const scenario of cases) {
				const generateContent = vi.fn(async () => {
					throw new Error("503 unavailable");
				});
				installPipelineMocks({ draft: scenario.draft, generateContent });
				const createMaterializeService = await loadCreateMaterializeService();
				const service = createMaterializeService({
					cache,
					env: ENV,
					genreRegistry: createGenreRegistry({
						cache,
						resolver: await loadGenreResolver(),
						redirects: new Map(),
					}),
				});
				const results = await Promise.allSettled([
					service.handleMaterialize(scenario.left),
					service.handleMaterialize(scenario.right),
				]);
				expect(
					results.every((result) => result.status === "rejected"),
					scenario.label,
				).toBe(true);
				// Each independent web request retries once. A merged result would only call
				// Gemini twice and could write the other request's identity on success.
				expect(generateContent, scenario.label).toHaveBeenCalledTimes(4);
			}
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
		return (await cache.listSlugs()).filter((s) => s.startsWith("genre:")).length;
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
		"pins the canonical slug so a fresh refresh never mints a second file from the LLM draft's own name (BLOCK 1 regression)",
		async () => {
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map<Slug, Slug>([["genre:electronic-music", "genre:electronic"]]),
			});
			// The mocked draft deliberately names itself DIFFERENTLY from the canonical node's own
			// name ("Electronic music", not "Electronic"): without PipelineInput.slug pinned,
			// canonicalizeDraft re-derives "genre:electronic-music" from this name and mints a
			// second file -- this is exactly the bug BLOCK 1 fixed.
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Electronic music",
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
			expect(await genreFileCount()).toBe(1);
			expect(await cache.has("genre:electronic-music")).toBe(false);
			const tavilySearch = await loadTavilySearch();
			const [, query] = vi.mocked(tavilySearch).mock.calls.at(-1) ?? [];
			// The search query is built from the REQUEST's (rewritten) name, "Electronic" -- not
			// the LLM draft's own name -- so this is an exact match, not the substring check a
			// previous round of review flagged as tautological ("Electronic music" contains
			// "Electronic").
			expect(query).toBe("Electronic genre music wiki discogs");
		},
		TIMEOUT_MS,
	);

	it(
		"pins the slug when fresh is requested for an ALREADY-cached slug, with no canonicalization rewrite involved (review round 2 nit)",
		async () => {
			// No redirect, no qid-index detour: the request already hashes to "genre:electronic",
			// so the canonicalization guard above never runs (cache.has(slug) is true) -- the only
			// thing that can pin the slug here is the fresh/cached read below. Before the round-2
			// fix, `if (!fresh)` skipped that read entirely when opts.fresh === true, so pinnedSlug
			// stayed undefined and the renamed draft below minted a second "genre:electronic-music"
			// file instead of refreshing "genre:electronic" in place.
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Electronic music",
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

			const result = await service.handleMaterialize({ type: "genre", name: "Electronic" }, { fresh: true });

			expect(result.node.slug).toBe("genre:electronic");
			expect(await genreFileCount()).toBe(1);
			expect(await cache.has("genre:electronic-music")).toBe(false);
		},
		TIMEOUT_MS,
	);

	it(
		"pins the canonical slug when refreshing a stale canonical found via the qid index, with no explicit fresh (BLOCK 1 regression)",
		async () => {
			const staleAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString(); // > pipelineConfig.nodeTtlMs (12h)
			await cache.write(
				genreNode({
					slug: "genre:electronic",
					name: "Electronic",
					qid: ELECTRONIC_QID,
					materialized_at: staleAt,
				}),
			);
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Electronic music",
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

			const result = await service.handleMaterialize({ type: "genre", name: "Electronic music" });

			expect(result.node.slug).toBe("genre:electronic");
			expect(await genreFileCount()).toBe(1);
			expect(await cache.has("genre:electronic-music")).toBe(false);
			const refreshed = await cache.get("genre:electronic");
			expect(new Date(refreshed.materialized_at).getTime()).toBeGreaterThan(new Date(staleAt).getTime());
		},
		TIMEOUT_MS,
	);

	it(
		"skips the canonicalization guard entirely when a disambiguator is present",
		async () => {
			// A qid-index collision that would otherwise merge {name: "Trap", disambiguator: "EDM"}
			// onto the unrelated existing "genre:trap" (hip-hop) the moment their names resolve to
			// the same qid -- canonicalSlugFor's resolver lookup is name-only and blind to
			// disambiguator, which exists precisely to force a distinct node (slug.ts).
			await cache.write(genreNode({ slug: "genre:trap", name: "Trap", qid: FAKE_TRAP_QID }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: buildTrapResolver(),
				redirects: new Map(),
			});
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Trap",
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

			const result = await service.handleMaterialize({
				type: "genre",
				name: "Trap",
				disambiguator: "EDM",
			});

			expect(result.node.slug).toBe("genre:trap--edm");
			const untouched = await cache.get("genre:trap");
			expect(untouched.name).toBe("Trap");
		},
		TIMEOUT_MS,
	);

	it(
		"a canonical rewrite refresh carries the CANONICAL node's own mbid, ignoring a different client-supplied one (TRA-43 security fix, review round 1)",
		async () => {
			// SECURITY (2026-09-10): a canonical rewrite used to spread the client's `body`, so a
			// client mbid survived even though `name` had been realigned. NOT ELECTRONIC_MBID below
			// so this can't pass by coincidence.
			const CANONICAL_MBID = "11111111-1111-1111-1111-111111111111";
			await cache.write(
				genreNode({
					slug: "genre:electronic",
					name: "Electronic",
					qid: ELECTRONIC_QID,
					mbid: CANONICAL_MBID,
				}),
			);
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

			// fresh:true forces the refresh through runJit regardless of mbidMismatch.
			const result = await service.handleMaterialize(
				{
					type: "genre",
					name: "Electronic music",
					mbid: ELECTRONIC_MBID,
				},
				{ fresh: true },
			);

			expect(result.node.slug).toBe("genre:electronic");
			expect((result.node as GenreNode).mbid).toBe(CANONICAL_MBID);
		},
		TIMEOUT_MS,
	);

	it(
		"mints under the requested slug without throwing when the registry names a canonical slug absent from disk",
		async () => {
			// The redirect table names genre:electronic as canonical (e.g. surviving a cache prune),
			// but nothing was ever written there -- a single get().catch(isNotFoundError) must treat
			// that as "nothing to serve" and fall through to a normal mint, not raise.
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map<Slug, Slug>([["genre:electronic-music", "genre:electronic"]]),
			});
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Electronic music",
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

			const result = await service.handleMaterialize({ type: "genre", name: "Electronic music" });

			expect(result.node.slug).toBe("genre:electronic-music");
			expect(await cache.has("genre:electronic")).toBe(false);
		},
		TIMEOUT_MS,
	);
});

// TRA-43: body.slug/body.qid name the identity the calling edge (front chip, crawler frontier)
// already carries -- validated strictly before any I/O, then used as a lookup key, never a
// client-chosen write target (review round 1 security fix, see the tests below).
describe("createMaterializeService slug/qid identity (TRA-43)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-materialize-identity-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function buildService() {
		const genreRegistry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const createMaterializeService = await loadCreateMaterializeService();
		return createMaterializeService({ cache, env: ENV, genreRegistry });
	}

	it.each([
		["a path traversal fragment", "../x"],
		["the wrong type for the request", "artist:foo"],
		["an uppercase type", "Genre:foo"],
		["an uppercase body", "genre:Foo"],
		["too long (review round 1, nit: would otherwise 500, not 400)", `genre:${"a".repeat(5000)}`],
	])("rejects a slug that is %s, without touching the cache", async (_label, badSlug) => {
		const service = await buildService();
		const hasSpy = vi.spyOn(cache, "has");
		const getSpy = vi.spyOn(cache, "get");

		await expect(
			service.handleMaterialize({ type: "genre", name: "Fixture Genre", slug: badSlug }),
		).rejects.toThrow(BadRequestError);
		expect(hasSpy).not.toHaveBeenCalled();
		expect(getSpy).not.toHaveBeenCalled();
	});

	it("rejects a malformed qid, without touching the cache", async () => {
		const service = await buildService();
		const hasSpy = vi.spyOn(cache, "has");

		await expect(
			service.handleMaterialize({ type: "genre", name: "Fixture Genre", qid: "not-a-qid" }),
		).rejects.toThrow(BadRequestError);
		expect(hasSpy).not.toHaveBeenCalled();
	});

	it(
		"serves an existing node by qid even when the request's name doesn't resolve there, minting nothing",
		async () => {
			await cache.write(genreNode({ slug: "genre:club-dance", name: "Club/Dance", qid: "Q11787389" }));
			const service = await buildService();
			const tavilySearch = await loadTavilySearch();
			vi.mocked(tavilySearch)
				.mockReset()
				.mockImplementation(async () => {
					throw new Error("unexpected pipeline run");
				});

			const result = await service.handleMaterialize({
				type: "genre",
				name: "Dance",
				qid: "Q11787389",
			});

			expect(result.node.slug).toBe("genre:club-dance");
			expect(result.source).toBe("cache");
		},
		TIMEOUT_MS,
	);
	// SECURITY (2026-09-10): a stale `genre:techno` (nodeTtlMs=12h) + `{name: "Attacker Controlled
	// Topic", slug: "genre:techno"}` used to pin `slug` while keeping the client's own name -- an
	// arbitrary unauthenticated write into cache/ (POST /materialize has no auth), any node type.
	it(
		"THE REPRO: a stale node's own identity drives a body.slug refresh, never an attacker-supplied name",
		async () => {
			const staleAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString(); // > nodeTtlMs (12h)
			await cache.write(
				genreNode({ slug: "genre:techno", name: "Techno", qid: "Q170611", materialized_at: staleAt }),
			);
			const service = await buildService();
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Techno",
					parent_genres: [],
					subgenres: [],
					related_genres: [],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});

			const result = await service.handleMaterialize({
				type: "genre",
				name: "Attacker Controlled Topic",
				slug: "genre:techno",
			});

			expect(result.node.slug).toBe("genre:techno");
			// The refreshed node keeps ITS OWN name -- the attacker's `name` never lands on disk.
			expect(result.node.name).toBe("Techno");
			const tavilySearch = await loadTavilySearch();
			const [, query] = vi.mocked(tavilySearch).mock.calls.at(-1) ?? [];
			expect(query).toBe("Techno genre music wiki discogs");
			expect(query).not.toContain("Attacker");
		},
		TIMEOUT_MS,
	);

	it(
		"rejects a contradictory client mbid for an existing node without refreshing or overwriting it (TRA-295)",
		async () => {
			const CACHED_MBID = "22222222-2222-2222-2222-222222222222";
			await cache.write(
				genreNode({ slug: "genre:techno", name: "Techno", qid: "Q170611", mbid: CACHED_MBID }),
			);
			const service = await buildService();
			const tavilySearch = await loadTavilySearch();
			vi.mocked(tavilySearch)
				.mockReset()
				.mockImplementation(async () => {
					throw new Error("unexpected pipeline run");
				});

			await expect(
				service.handleMaterialize(
					{
						type: "genre",
						name: "Whatever The Client Calls It",
						slug: "genre:techno",
						mbid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
					},
					{ reuseExisting: true },
				),
			).rejects.toThrow(BadRequestError);
			expect(await cache.get("genre:techno")).toMatchObject({ mbid: CACHED_MBID, name: "Techno" });
		},
		TIMEOUT_MS,
	);

	it(
		"keeps an old cached node for reuseExisting while the default still refreshes it (TRA-295)",
		async () => {
			const staleAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
			await cache.write(
				genreNode({ slug: "genre:techno", name: "Techno", qid: "Q170611", materialized_at: staleAt }),
			);
			const service = await buildService();
			const tavilySearch = await loadTavilySearch();
			vi.mocked(tavilySearch)
				.mockReset()
				.mockImplementation(async () => {
					throw new Error("default refresh reached pipeline");
				});

			const reused = await service.handleMaterialize(
				{ type: "genre", name: "Techno" },
				{ reuseExisting: true },
			);
			expect(reused).toMatchObject({ source: "cache", node: { slug: "genre:techno" } });
			await expect(service.handleMaterialize({ type: "genre", name: "Techno" })).rejects.toThrow(
				"default refresh reached pipeline",
			);
		},
		TIMEOUT_MS,
	);

	it(
		"mints a brand-new node under the NAME-derived slug when body.slug names no existing/canonical node -- never pinning body.slug itself",
		async () => {
			const service = await buildService();
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Totally Unresolvable Fixture Genre",
					parent_genres: [],
					subgenres: [],
					related_genres: [],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});

			const result = await service.handleMaterialize({
				type: "genre",
				name: "Totally Unresolvable Fixture Genre",
				slug: "genre:some-entirely-different-slug",
				qid: "Q106528337",
			});

			expect(result.node.slug).toBe("genre:totally-unresolvable-fixture-genre");
			expect(await cache.has("genre:some-entirely-different-slug")).toBe(false);
			expect((result.node as GenreNode).qid).toBe("Q106528337");
		},
		TIMEOUT_MS,
	);
});

// TRA-45: four review-round-2 nits from TRA-43 (PR #37, raphpool/odyssey-music#37) that didn't
// fit its 600-line hard gate -- merged separately (Raph decision 2026-09-10). See
// src/services/materialize-service.ts's refreshIdentityFrom and runJit comments.
describe("createMaterializeService identity refinements (TRA-45)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-materialize-tra45-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function buildService() {
		const genreRegistry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const createMaterializeService = await loadCreateMaterializeService();
		return createMaterializeService({ cache, env: ENV, genreRegistry });
	}

	it(
		"point 1: ignores a client qid when a disambiguator is present, never stamping an unrelated cached node's qid",
		async () => {
			// "Q170611" is genre:techno's real committed qid (also used by
			// test/pipeline-genre-qid.test.ts's TRA-32 fixtures) -- a client sending {name,
			// disambiguator, qid: <that qid>} together must never mint a DISTINCT node (that's
			// what the disambiguator asserts) carrying an identity that belongs to a wholly
			// unrelated genre.
			await cache.write(genreNode({ slug: "genre:techno", name: "Techno", qid: "Q170611" }));
			const service = await buildService();
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Fake Genre",
					parent_genres: [],
					subgenres: [],
					related_genres: [],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});

			const result = await service.handleMaterialize({
				type: "genre",
				name: "Fake Genre",
				disambiguator: "xx",
				qid: "Q170611",
			});

			expect(result.node.slug).toBe("genre:fake-genre--xx");
			expect((result.node as GenreNode).qid).not.toBe("Q170611");
			const techno = await cache.get("genre:techno");
			expect(techno.name).toBe("Techno");
		},
		TIMEOUT_MS,
	);

	it(
		"point 2: reports a client disambiguator coherent with body.slug's own suffix, preserving it in the search query",
		async () => {
			const staleAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString(); // > nodeTtlMs (12h)
			await cache.write(
				genreNode({ slug: "genre:trap--edm", name: "Trap", qid: "Q47781397", materialized_at: staleAt }),
			);
			const service = await buildService();
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Trap",
					parent_genres: [],
					subgenres: [],
					related_genres: [],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});

			await service.handleMaterialize({
				type: "genre",
				name: "Trap",
				slug: "genre:trap--edm",
				disambiguator: "EDM",
			});

			const tavilySearch = await loadTavilySearch();
			const [, query] = vi.mocked(tavilySearch).mock.calls.at(-1) ?? [];
			// Before the fix, refreshIdentityFrom dropped the disambiguator entirely (the node
			// itself never stores one) -- the search query lost "EDM" on every body.slug refresh.
			expect(query).toContain("EDM");
		},
		TIMEOUT_MS,
	);
});
