import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import { buildCacheIndex } from "../src/cache-index.js";
import type { ApiEnv } from "../src/env.js";
import { BadRequestError } from "../src/errors.js";
import { createGenreResolver, loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry } from "../src/genre-registry.js";
import type { ArtistNode, EdgeRef, GenreNode, ProjectNode, Slug, TrackNode } from "../src/types.js";
import {
	artistDraftFixture,
	EMPTY_PROJECT_META,
	genreDraftFixture,
	installPipelineMocks,
	projectDraftFixture,
	trackDraftFixture,
} from "./helpers/pipeline-mocks.js";

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
		"pins the canonical slug when refreshing an old canonical found via the qid index (BLOCK 1 regression)",
		async () => {
			// TRA-449: age no longer triggers a refresh, so the refresh is requested explicitly.
			const staleAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
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

			const result = await service.handleMaterialize(
				{ type: "genre", name: "Electronic music" },
				{ fresh: true },
			);

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
		// TRA-501: right type, non-empty body -- all that the old parseSlug-based rule asked for
		["a quote that closes an HTML attribute", 'genre:foo" onmouseover="alert(1)'],
		["whitespace in the body", "genre:foo bar"],
		["a trailing dash", "genre:foo-"],
		["a triple dash", "genre:foo---bar"],
		["two scope separators", "genre:foo--bar--baz"],
		["an empty body", "genre:"],
	])(
		"rejects a slug that is %s, without touching the cache or running the agent",
		async (_label, badSlug) => {
			const service = await buildService();
			const tavilySearch = await loadTavilySearch();
			vi.mocked(tavilySearch).mockClear();
			const hasSpy = vi.spyOn(cache, "has");
			const getSpy = vi.spyOn(cache, "get");

			await expect(
				service.handleMaterialize({ type: "genre", name: "Fixture Genre", slug: badSlug }),
			).rejects.toThrow(BadRequestError);
			expect(hasSpy).not.toHaveBeenCalled();
			expect(getSpy).not.toHaveBeenCalled();
			expect(vi.mocked(tavilySearch)).not.toHaveBeenCalled();
		},
	);

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
	// SECURITY (2026-09-10): a `genre:techno` refresh + `{name: "Attacker Controlled
	// Topic", slug: "genre:techno"}` used to pin `slug` while keeping the client's own name -- an
	// arbitrary unauthenticated write into cache/ (POST /materialize has no auth), any node type.
	// (Was triggered by the 12 h TTL; since TRA-449 only an explicit `fresh` refreshes.)
	it(
		"THE REPRO: a refreshed node's own identity drives a body.slug refresh, never an attacker-supplied name",
		async () => {
			const staleAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
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

			const result = await service.handleMaterialize(
				{
					type: "genre",
					name: "Attacker Controlled Topic",
					slug: "genre:techno",
				},
				{ fresh: true },
			);

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
		"serves a 30-day-old node as a cache hit without fresh, and never runs the pipeline (TRA-449)",
		async () => {
			const oldAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
			await cache.write(
				genreNode({ slug: "genre:techno", name: "Techno", qid: "Q170611", materialized_at: oldAt }),
			);
			const service = await buildService();
			const tavilySearch = await loadTavilySearch();
			vi.mocked(tavilySearch)
				.mockReset()
				.mockImplementation(async () => {
					throw new Error("unexpected pipeline run");
				});

			const result = await service.handleMaterialize({ type: "genre", name: "Techno" });

			expect(result.source).toBe("cache");
			expect(result.node.materialized_at).toBe(oldAt);
			expect(vi.mocked(tavilySearch)).not.toHaveBeenCalled();
			expect((await cache.get("genre:techno")).materialized_at).toBe(oldAt);
		},
		TIMEOUT_MS,
	);

	it(
		"re-runs the pipeline for a 30-day-old node when fresh is requested (TRA-449)",
		async () => {
			const oldAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
			await cache.write(
				genreNode({ slug: "genre:techno", name: "Techno", qid: "Q170611", materialized_at: oldAt }),
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

			const result = await service.handleMaterialize({ type: "genre", name: "Techno" }, { fresh: true });

			expect(result.source).toBe("jit");
			expect(new Date(result.node.materialized_at).getTime()).toBeGreaterThan(new Date(oldAt).getTime());
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
		"keeps an old cached node for reuseExisting, while an explicit fresh still refreshes it (TRA-295, TRA-449)",
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
			await expect(
				service.handleMaterialize({ type: "genre", name: "Techno" }, { fresh: true }),
			).rejects.toThrow("default refresh reached pipeline");
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
			const staleAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
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

			await service.handleMaterialize(
				{
					type: "genre",
					name: "Trap",
					slug: "genre:trap--edm",
					disambiguator: "EDM",
				},
				{ fresh: true },
			);

			const tavilySearch = await loadTavilySearch();
			const [, query] = vi.mocked(tavilySearch).mock.calls.at(-1) ?? [];
			// Before the fix, refreshIdentityFrom dropped the disambiguator entirely (the node
			// itself never stores one) -- the search query lost "EDM" on every body.slug refresh.
			expect(query).toContain("EDM");
		},
		TIMEOUT_MS,
	);
});

// TRA-477: a click on a work carries the artist of the page it came from. Behind
// ODYSSEY_SCOPED_RELEASE_SLUGS (TRA-509 flips it) the work is filed and matched by `<title>--<artist>`, and
// a node that does not credit the artist is never served for it. Boundaries (MusicBrainz, Gemini, search)
// are mocked; slugs, the cache, credit matching and edge repointing run for real.
describe("createMaterializeService artist context (TRA-477)", () => {
	const RG_MBID = "bbbbbbbb-1111-4111-8111-000000000022";
	const PROSE = "A fictional work invented for the artist-context tests (TRA-477). ".repeat(2);
	const NEW_FORMS = "project:new-forms--roni-size-reprazent" as Slug;
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		dir = await mkdtemp(join(tmpdir(), "odyssey-materialize-tra477-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	const ref = (
		name: string,
		slug: Slug,
		type: EdgeRef["type"] = "artist",
		extra: Partial<EdgeRef> = {},
	): EdgeRef => ({
		slug,
		type,
		name,
		...extra,
	});
	const base = (slug: Slug, name: string) => ({
		slug,
		name,
		editorial_article: PROSE,
		citations: [{ url: "https://example.com/x" }],
		materialized_at: new Date().toISOString(),
	});
	const list = { genres: [], producers: [], personnel: [] };

	function trackNode(slug: Slug, name: string, artists: EdgeRef[]): TrackNode {
		return {
			...base(slug, name),
			type: "track",
			editorial_teaser: "A fictional track.",
			artists,
			...list,
			samples: [],
			sampled_by: [],
			remixed_by: [],
		};
	}

	function projectNode(slug: Slug, name: string, artists: EdgeRef[]): ProjectNode {
		return {
			...base(slug, name),
			type: "project",
			editorial_pitch: "A fictional album.",
			artists,
			...list,
			tracklist: [],
			related_projects: [],
		};
	}

	function artistNode(slug: Slug, name: string, overrides: Partial<ArtistNode> = {}): ArtistNode {
		return {
			...base(slug, name),
			type: "artist",
			editorial_bio: "A fictional artist.",
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
		} as ArtistNode;
	}

	async function buildService(withIndex = false) {
		const genreRegistry = createGenreRegistry({
			cache,
			resolver: await loadGenreResolver(),
			redirects: new Map(),
		});
		const create = await loadCreateMaterializeService();
		return create({
			cache,
			env: ENV,
			genreRegistry,
			...(withIndex ? { getCacheIndex: () => buildCacheIndex(dir) } : {}),
		});
	}

	/** Gemini returns this draft; the spy shows what the pipeline actually asked it. */
	function geminiReturning(draft: Record<string, unknown>) {
		const generateContent = vi.fn(async () => ({
			text: JSON.stringify(draft),
			usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 42 },
		}));
		installPipelineMocks({ draft, generateContent });
		return generateContent;
	}

	async function noPipeline() {
		const tavilySearch = vi.mocked(await loadTavilySearch());
		tavilySearch.mockReset().mockImplementation(async () => {
			throw new Error("unexpected pipeline run");
		});
		return tavilySearch;
	}

	/** MusicBrainz resolves the release group "New Forms" (or, given an mbid, skips that) with this credit. */
	async function mbProject(credit: Array<{ mbid: string; name: string }>) {
		const mb = await import("../src/musicbrainz.js");
		vi.mocked(mb.resolveReleaseGroup).mockImplementation(async () => ({
			mbid: RG_MBID,
			title: "New Forms",
			credit,
			primaryType: null,
			firstReleaseDate: null,
		}));
		vi.mocked(mb.fetchEntityGenresMb).mockImplementation(async () => []);
		vi.mocked(mb.fetchProjectMetaMb).mockImplementation(async () => ({
			...EMPTY_PROJECT_META,
			tracks: [],
			artists: [],
			producers: [],
			personnel: [],
		}));
	}

	it(
		"files the work under the requested artist's scoped slug, never serving another artist's homonym",
		async () => {
			await cache.write(trackNode("track:fitna--akuma", "Fitna", [ref("Akuma", "artist:akuma")]));
			const generateContent = geminiReturning(trackDraftFixture("Fitna", "Rohff"));
			const service = await buildService();

			const result = await service.handleMaterialize({ type: "track", name: "Fitna", artist: "Rohff" });

			expect(result.source).toBe("jit");
			expect(result.node.slug).toBe("track:fitna--rohff");
			expect(await cache.has("track:fitna--akuma")).toBe(true);
			// The artist is also the credit hint of the search/prompt, not just of the slug.
			expect(JSON.stringify(generateContent.mock.calls[0])).toContain('artist=\\"Rohff\\"');
		},
		TIMEOUT_MS,
	);

	it(
		"ignores a client slug that names another artist's work",
		async () => {
			await cache.write(trackNode("track:fitna--akuma", "Fitna", [ref("Akuma", "artist:akuma")]));
			geminiReturning(trackDraftFixture("Fitna", "Rohff"));
			const service = await buildService();

			const result = await service.handleMaterialize({
				type: "track",
				name: "Fitna",
				artist: "Rohff",
				slug: "track:fitna--akuma",
			});

			expect(result).toMatchObject({ source: "jit", node: { slug: "track:fitna--rohff" } });
		},
		TIMEOUT_MS,
	);

	it(
		"serves a cached work to the artist it credits, or to a member of the group it credits, and to nobody else",
		async () => {
			await cache.write(artistNode("artist:roni-size", "Roni Size"));
			await cache.write(
				artistNode("artist:roni-size-reprazent", "Roni Size / Reprazent", {
					members: [ref("Roni Size", "artist:roni-size")],
				}),
			);
			await cache.write(
				projectNode(NEW_FORMS, "New Forms", [ref("Roni Size / Reprazent", "artist:roni-size-reprazent")]),
			);
			const tavilySearch = await noPipeline();
			const service = await buildService();

			for (const artist of ["Roni Size / Reprazent", "Roni Size"]) {
				const hit = await service.handleMaterialize({
					type: "project",
					name: "New Forms",
					artist,
					slug: NEW_FORMS,
				});
				expect(hit).toMatchObject({ source: "cache", node: { slug: NEW_FORMS } });
			}
			// No artist at all: the scoped slug is trusted as before.
			const bare = await service.handleMaterialize({ type: "project", name: "New Forms", slug: NEW_FORMS });
			expect(bare.source).toBe("cache");
			expect(tavilySearch).not.toHaveBeenCalled();

			geminiReturning(projectDraftFixture("New Forms", "Goldie"));
			const stranger = await service.handleMaterialize({
				type: "project",
				name: "New Forms",
				artist: "Goldie",
				slug: NEW_FORMS,
			});
			expect(stranger.node.slug).toBe("project:new-forms--goldie");
		},
		TIMEOUT_MS,
	);

	const RONI_ID = "2eeba1d4-0000-4000-8000-000000000001";
	/** Roni Size is a member of the group MusicBrainz credits New Forms to (plan decision 3). */
	async function writeReprazent() {
		await cache.write(
			artistNode("artist:roni-size-reprazent", "Roni Size / Reprazent", {
				members: [ref("Roni Size", "artist:roni-size")],
			}),
		);
	}

	it(
		"repoints the requesting edge when MusicBrainz credits the work to another name, and says so",
		async () => {
			const requested = "project:new-forms--roni-size" as Slug;
			await cache.write(
				artistNode("artist:roni-size", "Roni Size", {
					discography: [
						ref("New Forms", requested, "project"),
						// Same-slug entries that differ (committed lists have 84 of them) are left alone.
						ref("Poison", "project:poison--roni-size", "project", { mbid: RG_MBID }),
						ref("Poison (single)", "project:poison--roni-size", "project", { mbid: RONI_ID }),
					],
				}),
			);
			await writeReprazent();
			geminiReturning(projectDraftFixture("New Forms", "Roni Size"));
			await mbProject([{ mbid: RONI_ID, name: "Roni Size / Reprazent" }]);
			const service = await buildService();

			const result = await service.handleMaterialize({
				type: "project",
				name: "New Forms",
				artist: "Roni Size",
				source: { slug: "artist:roni-size", field: "discography" },
			});

			expect(result.node.slug).toBe(NEW_FORMS);
			expect(result.requested_slug).toBe(requested);
			const roni = (await cache.get("artist:roni-size")) as ArtistNode;
			expect(roni.discography.map((e) => [e.slug, e.name, e.mbid])).toEqual([
				[NEW_FORMS, "New Forms", undefined],
				["project:poison--roni-size", "Poison", RG_MBID],
				["project:poison--roni-size", "Poison (single)", RONI_ID],
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"never adds an edge, repoints a node into itself, or repoints into a field that does not take its type, and reports no requested_slug then",
		async () => {
			await cache.write(
				artistNode("artist:roni-size", "Roni Size", {
					discography: [ref("Other", "project:other--roni-size", "project")],
				}),
			);
			await writeReprazent();
			const service = await buildService();
			const getSpy = vi.spyOn(cache, "get");
			const replaceSpy = vi.spyOn(cache, "replace");
			const body = { type: "project", name: "New Forms", artist: "Roni Size" };
			const sources = [
				{ slug: "artist:roni-size", field: "discography" }, // holds no edge to the requested slug
				{ slug: "artist:roni-size", field: "notable_tracks" }, // takes tracks, not projects
				{ slug: NEW_FORMS, field: "related_projects" }, // the node itself
			];
			for (const source of sources) {
				geminiReturning(projectDraftFixture("New Forms", "Roni Size"));
				await mbProject([{ mbid: RONI_ID, name: "Roni Size / Reprazent" }]);
				const result = await service.handleMaterialize({ ...body, source }, { fresh: true });
				expect(result.requested_slug).toBeUndefined();
			}

			expect(replaceSpy).not.toHaveBeenCalled();
			// The type and self-edge checks come before the source node is even read.
			expect(getSpy.mock.calls.filter(([slug]) => slug === "artist:roni-size")).toHaveLength(1);
			expect(((await cache.get(NEW_FORMS)) as ProjectNode).related_projects).toEqual([]);
		},
		TIMEOUT_MS,
	);

	// Review of #452 (B1): the client's mbid names Akuma's recording while the click comes from Rohff.
	// MusicBrainz then credits Akuma, so the edge must not follow -- the reverse edges would put Rohff
	// among the artists of Akuma's track and every later honest click would be served Akuma's Fitna.
	it(
		"does not repoint an artist's edge onto a work that does not credit them, whatever mbid the client sends",
		async () => {
			const AKUMA_REC = "aaaaaaaa-0000-4000-8000-00000000aaaa";
			const akuma = trackNode("track:fitna--akuma", "Fitna", [ref("Akuma", "artist:akuma")]);
			await cache.write(akuma);
			await cache.write(
				artistNode("artist:rohff", "Rohff", {
					notable_tracks: [ref("Fitna", "track:fitna--rohff", "track")],
				}),
			);
			const mb = await import("../src/musicbrainz.js");
			const arm = () => {
				geminiReturning(trackDraftFixture("Fitna", "Rohff"));
				vi.mocked(mb.fetchEntityGenresMb).mockImplementation(async () => []);
				vi.mocked(mb.fetchTrackMetaMb).mockImplementation(async () => ({
					project: null,
					label: null,
					artists: [{ mbid: "aaaaaaaa-0000-4000-8000-0000000000a1", name: "Akuma" }],
					year: null,
					duration: null,
					producers: [],
					personnel: [],
				}));
			};
			arm();
			const service = await buildService();
			const body = {
				type: "track",
				name: "Fitna",
				artist: "Rohff",
				slug: "track:fitna--rohff",
				mbid: AKUMA_REC,
				source: { slug: "artist:rohff", field: "notable_tracks" },
			};

			// 1. Not cached under Rohff's slug: the pipeline moves the node onto Akuma's slug.
			const first = await service.handleMaterialize(body);
			expect(first.requested_slug).toBeUndefined();
			// 2. Even forced fresh, Akuma's node (found at the moved slug) is served, never overwritten.
			arm();
			await service.handleMaterialize(body, { fresh: true });

			const rohff = (await cache.get("artist:rohff")) as ArtistNode;
			expect(rohff.notable_tracks.map((e) => e.slug)).toEqual(["track:fitna--rohff"]);
			expect(await cache.get("track:fitna--akuma")).toEqual(akuma);
		},
		TIMEOUT_MS,
	);

	// TRA-538: a client mbid is a search hint, never an identity to stamp. Probe of the #452 review:
	// `track:garbage--rohff` created with the mbid of "Le Bitume" used to answer "Garbage" to every honest
	// click on "Le Bitume", because the cache index serves a node by its mbid.
	describe("a client mbid is only a hint (TRA-538)", () => {
		const BITUME = "cccccccc-1111-4111-8111-0000000000b1";
		const GARBAGE = "cccccccc-1111-4111-8111-0000000000b2";
		const ROHFF = "cccccccc-1111-4111-8111-0000000000a1";
		const trackMeta = {
			project: null,
			label: null,
			artists: [{ mbid: ROHFF, name: "Rohff" }],
			year: null,
			duration: null,
			producers: [],
			personnel: [],
		};

		async function armMb(resolve: () => Promise<ReturnType<typeof identityOf> | null>) {
			const mb = await importMb();
			vi.mocked(mb.resolveRecording).mockImplementation(resolve);
			vi.mocked(mb.fetchEntityGenresMb).mockImplementation(async () => []);
			vi.mocked(mb.fetchTrackMetaMb).mockImplementation(async () => trackMeta);
			return mb;
		}
		function importMb() {
			return import("../src/musicbrainz.js");
		}
		const identityOf = (mbid: string, title: string) => ({
			mbid,
			title,
			credit: [{ mbid: ROHFF, name: "Rohff" }],
			primaryType: null,
			firstReleaseDate: null,
		});

		it(
			"does not serve Garbage to an honest click on Le Bitume (reviewer probe)",
			async () => {
				// MusicBrainz knows no "Garbage" by Rohff: the client's mbid has nothing to be confirmed by.
				geminiReturning(trackDraftFixture("Garbage", "Rohff"));
				await armMb(async () => null);
				const service = await buildService(true);

				const planted = await service.handleMaterialize({
					type: "track",
					name: "Garbage",
					artist: "Rohff",
					mbid: BITUME,
				});
				expect(planted.node.slug).toBe("track:garbage--rohff");
				expect((planted.node as TrackNode).mbid).toBeUndefined();
				expect(((await cache.get("track:garbage--rohff")) as TrackNode).mbid).toBeUndefined();
				expect((await buildCacheIndex(dir)).byMbid(BITUME)).toBeNull();

				// The honest click on "Le Bitume": MB confirms its own mbid, a new node is minted.
				geminiReturning(trackDraftFixture("Le Bitume", "Rohff"));
				await armMb(async () => identityOf(BITUME, "Le Bitume"));
				const honest = await service.handleMaterialize({
					type: "track",
					name: "Le Bitume",
					artist: "Rohff",
					mbid: BITUME,
				});
				expect(honest.node).toMatchObject({
					slug: "track:le-bitume--rohff",
					name: "Le Bitume",
					mbid: BITUME,
				});
				expect(honest.source).not.toBe("cache");
			},
			TIMEOUT_MS,
		);

		// CI review of #460: the mbid a cached node carries was established by the server. A refresh must
		// not read it back as a client hint and drop it when MusicBrainz no longer singles the work out.
		describe("refreshing a node that already carries a server mbid", () => {
			const cachedBitume = () =>
				({
					...trackNode("track:le-bitume--rohff", "Le Bitume", [ref("Rohff", "artist:rohff")]),
					mbid: BITUME,
				}) as TrackNode;

			it(
				"keeps the mbid on fresh=1 without any client mbid, when MusicBrainz is ambiguous",
				async () => {
					await cache.write(cachedBitume());
					geminiReturning(trackDraftFixture("Le Bitume", "Rohff"));
					await armMb(async () => null);
					const service = await buildService(true);

					const result = await service.handleMaterialize(
						{ type: "track", name: "Le Bitume", slug: "track:le-bitume--rohff" },
						{ fresh: true },
					);

					expect(result.source).toBe("jit");
					expect((result.node as TrackNode).mbid).toBe(BITUME);
					expect(((await cache.get("track:le-bitume--rohff")) as TrackNode).mbid).toBe(BITUME);
					expect((await buildCacheIndex(dir)).byMbid(BITUME)).toBe("track:le-bitume--rohff");
				},
				TIMEOUT_MS,
			);

			it(
				"keeps the server mbid when the client sends another one: the client's stays a hint",
				async () => {
					await cache.write(cachedBitume());
					geminiReturning(trackDraftFixture("Le Bitume", "Rohff"));
					await armMb(async () => null);
					const service = await buildService(true);

					const result = await service.handleMaterialize(
						{
							type: "track",
							name: "Le Bitume",
							artist: "Rohff",
							slug: "track:le-bitume--rohff",
							mbid: GARBAGE,
						},
						{ fresh: true },
					);

					expect((result.node as TrackNode).mbid).toBe(BITUME);
					expect((await buildCacheIndex(dir)).byMbid(GARBAGE)).toBeNull();
				},
				TIMEOUT_MS,
			);
		});

		it(
			"writes no mbid when MusicBrainz resolves the work to another mbid than the client's",
			async () => {
				geminiReturning(trackDraftFixture("Garbage", "Rohff"));
				await armMb(async () => identityOf(GARBAGE, "Garbage"));
				const service = await buildService(true);

				const result = await service.handleMaterialize({
					type: "track",
					name: "Garbage",
					artist: "Rohff",
					mbid: BITUME,
				});

				// Neither the client's mbid nor, in its place, MusicBrainz's other answer.
				expect((result.node as TrackNode).mbid).toBeUndefined();
				expect((await buildCacheIndex(dir)).byMbid(BITUME)).toBeNull();
			},
			TIMEOUT_MS,
		);

		it(
			"stamps the mbid when MusicBrainz's own resolution lands on the client's hint",
			async () => {
				geminiReturning(trackDraftFixture("Le Bitume", "Rohff"));
				await armMb(async () => identityOf(BITUME, "Le Bitume"));
				const service = await buildService(true);

				const result = await service.handleMaterialize({
					type: "track",
					name: "Le Bitume",
					artist: "Rohff",
					mbid: BITUME.toUpperCase(),
				});

				expect((result.node as TrackNode).mbid).toBe(BITUME);
			},
			TIMEOUT_MS,
		);

		it(
			"does the same for a project: a release-group mbid MusicBrainz does not confirm is dropped",
			async () => {
				geminiReturning(projectDraftFixture("New Forms", "Roni Size"));
				const mb = await importMb();
				vi.mocked(mb.resolveReleaseGroup).mockImplementation(async () => null);
				const service = await buildService(true);

				const result = await service.handleMaterialize({
					type: "project",
					name: "New Forms",
					artist: "Roni Size",
					mbid: RG_MBID,
				});

				expect((result.node as ProjectNode).mbid).toBeUndefined();
				expect((await buildCacheIndex(dir)).byMbid(RG_MBID)).toBeNull();
			},
			TIMEOUT_MS,
		);

		it(
			"does not rewrite a cached work because the client sent another mbid (flag off, legacy refresh)",
			async () => {
				vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
				await cache.write({
					...trackNode("track:garbage", "Garbage", [ref("Garbage", "artist:garbage")]),
					mbid: GARBAGE,
				} as TrackNode);
				await noPipeline();
				const service = await buildService();

				const result = await service.handleMaterialize({ type: "track", name: "Garbage", mbid: BITUME });

				expect(result).toMatchObject({ source: "cache", node: { slug: "track:garbage", mbid: GARBAGE } });
			},
			TIMEOUT_MS,
		);

		it(
			"flag off: an unconfirmed client mbid is not stamped either (the /search chip path)",
			async () => {
				vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
				geminiReturning(trackDraftFixture("Garbage", "Rohff"));
				await armMb(async () => null);
				const service = await buildService();

				const result = await service.handleMaterialize({ type: "track", name: "Garbage", mbid: BITUME });

				expect((result.node as TrackNode).mbid).toBeUndefined();
			},
			TIMEOUT_MS,
		);
	});

	// Review of #452 (B2): the web front sends a scoped slug and no artist; the scope is the hint.
	it(
		"gives MusicBrainz the artist of a scoped slug sent without `artist`",
		async () => {
			await cache.write(trackNode("track:fitna--akuma", "Fitna", [ref("Akuma", "artist:akuma")]));
			geminiReturning(trackDraftFixture("Fitna", "Rohff"));
			const mb = await import("../src/musicbrainz.js");
			vi.mocked(mb.resolveRecording).mockImplementation(async (_title, hint) => {
				// Without a hint the only exact "Fitna" MusicBrainz knows is Akuma's.
				const credit = hint ? [] : [{ mbid: "aaaaaaaa-0000-4000-8000-0000000000a1", name: "Akuma" }];
				return hint
					? null
					: { mbid: RG_MBID, title: "Fitna", credit, primaryType: null, firstReleaseDate: null };
			});
			const service = await buildService();

			const result = await service.handleMaterialize({
				type: "track",
				name: "Fitna",
				slug: "track:fitna--rohff",
			});

			expect(vi.mocked(mb.resolveRecording).mock.calls[0]?.[1]).toBe("rohff");
			expect(result.node.slug).toBe("track:fitna--rohff");
		},
		TIMEOUT_MS,
	);

	const TRACK = { type: "track", name: "Fitna" };
	it.each([
		["a track without artist, mbid or slug", TRACK],
		["a track whose slug is not scoped", { ...TRACK, slug: "track:fitna" }],
		["a non-string artist", { ...TRACK, artist: 7 }],
		["a blank artist", { ...TRACK, artist: "  " }],
		["an artist with a control character", { ...TRACK, artist: "Roh\u0007ff" }],
		["an artist with no Latin letter", { ...TRACK, artist: "坂本龍一" }],
		["an artist over the length cap", { ...TRACK, artist: "a".repeat(201) }],
		[
			"a source with a non-canonical slug",
			{ ...TRACK, artist: "Rohff", source: { slug: "artist:../x", field: "notable_tracks" } },
		],
		[
			"a source field the type does not have",
			{ ...TRACK, artist: "Rohff", source: { slug: "artist:rohff", field: "tracklist" } },
		],
		[
			"an inherited source field",
			{ ...TRACK, artist: "Rohff", source: { slug: "artist:rohff", field: "constructor" } },
		],
		["an mbid that is not a UUID", { ...TRACK, artist: "Rohff", mbid: "not-a-uuid" }],
	])("answers 400 for %s, before any I/O", async (_label, body) => {
		const service = await buildService();
		const getSpy = vi.spyOn(cache, "get");

		await expect(service.handleMaterialize(body as never)).rejects.toThrow(BadRequestError);
		expect(getSpy).not.toHaveBeenCalled();
	});

	it(
		"answers from the cache for an mbid the cache index knows, but not for another node type",
		async () => {
			await cache.write({
				...projectNode(NEW_FORMS, "New Forms", [ref("Roni Size / Reprazent", "artist:roni-size-reprazent")]),
				mbid: RG_MBID,
			});
			const tavilySearch = await noPipeline();
			const service = await buildService(true);

			const known = await service.handleMaterialize({ type: "project", name: "X", mbid: RG_MBID });
			expect(known).toMatchObject({ source: "cache", node: { slug: NEW_FORMS } });
			expect(tavilySearch).not.toHaveBeenCalled();
			await expect(service.handleMaterialize({ type: "track", name: "X", mbid: RG_MBID })).rejects.toThrow(
				BadRequestError,
			);
		},
		TIMEOUT_MS,
	);

	it.each([
		["", {}],
		["with a disambiguator", { disambiguator: "Akuma" }],
	])(
		"refuses an uncached work asked for by mbid alone %s, before any paid call or write",
		async (_label, extra) => {
			const tavilySearch = await noPipeline();
			const service = await buildService();

			await expect(
				service.handleMaterialize({ type: "project", name: "Untold", mbid: RG_MBID, ...extra }),
			).rejects.toThrow(BadRequestError);
			expect(tavilySearch).not.toHaveBeenCalled();
			expect(await cache.has("project:untold--akuma")).toBe(false);
		},
	);

	it(
		"runs one pipeline per artist for concurrent same-title requests, and shares it for the same artist",
		async () => {
			const generateContent = geminiReturning(trackDraftFixture("Fitna", "Rohff"));
			const service = await buildService();

			const results = await Promise.all(
				["Rohff", "ROHFF", "Akuma"].map((artist) =>
					service.handleMaterialize({ type: "track", name: "Fitna", artist }),
				),
			);

			expect(results.map((r) => r.node.slug)).toEqual([
				"track:fitna--rohff",
				"track:fitna--rohff",
				"track:fitna--akuma",
			]);
			expect(generateContent).toHaveBeenCalledTimes(2);
		},
		TIMEOUT_MS,
	);

	describe("flag off (the default until TRA-509)", () => {
		beforeEach(() => {
			vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
		});

		it(
			"keeps the contract of a client that sends no context, and ignores one that does",
			async () => {
				geminiReturning(trackDraftFixture("Fitna", "Akuma"));
				const service = await buildService();

				const minted = await service.handleMaterialize({ type: "track", name: "Fitna" });
				expect(minted.node.slug).toBe("track:fitna");
				const again = await service.handleMaterialize({
					type: "track",
					name: "Fitna",
					artist: "Rohff",
					source: { slug: "artist:rohff", field: "notable_tracks" },
				});
				expect(again).toMatchObject({ source: "cache", node: { slug: "track:fitna" } });
				// A non-Latin artist cannot scope a slug, but with the flag off it scopes nothing: not a 400.
				await expect(
					service.handleMaterialize({ type: "track", name: "Fitna", artist: "坂本龍一" }),
				).resolves.toMatchObject({ node: { slug: "track:fitna" } });
			},
			TIMEOUT_MS,
		);
	});
});
