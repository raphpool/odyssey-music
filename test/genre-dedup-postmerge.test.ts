/**
 * TRA-31: proves that after TRA-22's genre duplicate-merge migration, none of the pipeline's
 * genre-edge producers (a MusicBrainz tag, a Gemini draft, the Wikidata parent_genres catalog
 * backfill) or the materialize/read paths recreate a duplicate of a merged genre.
 *
 * This is the gate for TRA-22's --apply: that migration is destructive and is not authorized
 * to land until these six scenarios are green on main.
 *
 * Service assembly below reproduces src/server.ts:59-78 verbatim (verified by reading that
 * range on origin/main @ 498e8d3, 2026-09-10):
 *   const env = loadEnv();                                                             (:59)
 *   const cache = new NodeCache(CACHE_DIR);                                            (:60)
 *   const [genreRedirects, genreResolver] = await Promise.all([...]);                  (:65)
 *   const genreRegistry = createGenreRegistry({ cache, resolver, redirects });         (:66)
 *   const materializeService = createMaterializeService({ cache, env, genreRegistry }); (:77)
 *   const getNode = createNodeService({ cache, runJit: materializeService.runJit, redirects }); (:78)
 *
 * Two deliberate deviations from server.ts, both required to keep this test hermetic and
 * both with precedent in this test suite:
 *   - `env` is a literal ApiEnv, not loadEnv()'s process.env read (same as
 *     test/materialize-service.test.ts's ENV constant) -- no real API keys exist in CI.
 *   - `genreRedirects` comes from parseGenreRedirects() applied to an in-memory object shaped
 *     like TRA-22's data/genre-redirects.json, not loadGenreRedirects() reading a real file --
 *     this ticket is explicitly out of scope for running the real migration, and must not
 *     depend on its output existing on disk.
 * `genreResolver` is the real loadGenreResolver(), reading the committed data/ files, exactly
 * as server.ts does.
 *
 * Reuses the TRA-25 e2e harness (test/helpers/pipeline-mocks.ts): only Tavily, localFetch,
 * @google/genai and MusicBrainz are mocked. src/genre-identity.ts, src/genre-registry.ts and
 * the committed data/ catalog run for real, against the real files (CLAUDE.md: mock external
 * boundaries, not code or data we own).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDuplicateReport } from "../scripts/report-genre-duplicates.js";
import { NodeCache } from "../src/cache.js";
import type { ApiEnv } from "../src/env.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry, parseGenreRedirects } from "../src/genre-registry.js";
import type { ArtistNode, GenreNode, NodePayload } from "../src/types.js";
import { artistDraftFixture, genreDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// Dynamic imports, same rationale as test/pipeline-e2e.test.ts and test/materialize-service.test.ts:
// createMaterializeService's module graph statically pulls in pipeline.js ->
// musicbrainz.js/tavily.js/local-fetcher.js/@google/genai, which must stay mocked -- a static
// `import { createMaterializeService } from "../src/services/materialize-service.js"` would get
// sorted by Biome ahead of the "./helpers/..." import that registers those mocks.
//
// createNodeService (src/services/node-service.js) has no such import itself, but it DOES
// statically import `pipelineConfig` from src/config.ts, whose `geminiApiKey` field reads
// process.env.GEMINI_API_KEY exactly once, at module-evaluation time (src/config.ts:39).
// pipeline-mocks.ts's vi.stubEnv("GEMINI_API_KEY", ...) call only lands in time if config.ts is
// not evaluated before it -- so createNodeService must be loaded dynamically here too, after the
// "./helpers/pipeline-mocks.js" import above has already run its stubEnv. A static import of
// node-service.js here (even though it doesn't touch the mocked MB/Gemini/Tavily boundaries)
// would get sorted ahead of "./helpers/..." by Biome and load config.js too early, caching an
// empty geminiApiKey for the rest of the test run -- confirmed by first writing it that way and
// watching every runPipeline call fail with "GEMINI_API_KEY missing" (2026-09-10).
async function loadCreateMaterializeService() {
	return (await import("../src/services/materialize-service.js")).createMaterializeService;
}

async function loadCreateNodeService() {
	return (await import("../src/services/node-service.js")).createNodeService;
}

async function loadTavilySearch() {
	return (await import("../src/tools/tavily.js")).tavilySearch;
}

type CreateMaterializeService = Awaited<ReturnType<typeof loadCreateMaterializeService>>;
type CreateNodeService = Awaited<ReturnType<typeof loadCreateNodeService>>;

const ENV: ApiEnv = { GEMINI_API_KEY: "test", TAVILY_API_KEY: "test", FIRECRAWL_API_KEY: "test" };
const TIMEOUT_MS = 5_000;

// Real MusicBrainz genre MBIDs, read from the committed data/genre-qid-map.json (verified
// 2026-09-10 via `node -e '...'` against the actual file, not copied from memory):
//   mb_name "electronic" -> Q9778       (same QID as data/genre-catalog.json's "electronic-music"
//                                         entry, which is what TRA-22's fixture redirect targets)
//   mb_name "club"       -> Q11787389
//   mb_name "dance"      -> Q11787389   (same QID as "club" -- the pair scenario 6 exercises)
// The tag *name* the mock returns is independent of mb_name -- the resolver's step 1 keys off
// the mbid, never the free-text tag name (src/genre-identity.ts resolve()) -- so "electronic
// music" below is the display name a real MB "electronic" tag would carry, same convention as
// test/pipeline-e2e.test.ts's ELECTRONIC_MBID constant.
const ELECTRONIC_MBID = "89255676-1f14-4dd8-bbad-fca839d6aff4";
const ELECTRONIC_QID = "Q9778";
const CLUB_MBID = "bab69b07-8bb9-4415-b666-c37609cef80b";
const DANCE_MBID = "e5bba957-8c91-496a-a675-c6d0c6b51c33";
const CLUB_DANCE_QID = "Q11787389";
const IDM_QID = "Q660984";

/** Minimal valid GenreNode for seeding the "after merge" cache fixture, same motif as
 * test/pipeline-e2e.test.ts and test/materialize-service.test.ts's own genreNode() helpers. */
function genreNode(overrides: Partial<GenreNode> & Pick<GenreNode, "slug" | "name">): GenreNode {
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

async function genreFileCount(cache: NodeCache): Promise<number> {
	return (await cache.listSlugs()).filter((slug) => slug.startsWith("genre:")).length;
}

// Mirrors scripts/report-genre-duplicates.ts's own main() (report-genre-duplicates.ts:180-184)
// exactly: list every slug, then read each node in full. Deliberately NOT a helper that
// swallows a read failure -- a corrupted cache file is exactly the kind of state this
// post-merge gate must surface, not paper over.
async function readAllNodes(cache: NodeCache): Promise<NodePayload[]> {
	const slugs = await cache.listSlugs();
	const nodes: NodePayload[] = [];
	for (const slug of slugs) nodes.push(await cache.get(slug));
	return nodes;
}

async function expectNoDuplicateGroups(cache: NodeCache): Promise<void> {
	const report = buildDuplicateReport(await readAllNodes(cache));
	expect(report.groups).toEqual([]);
}

describe("genre dedup post-merge gate (TRA-31) — gates TRA-22's --apply", () => {
	let dir: string;
	let cache: NodeCache;
	let materializeService: ReturnType<CreateMaterializeService>;
	let getNode: ReturnType<CreateNodeService>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-genre-dedup-postmerge-"));
		cache = new NodeCache(dir);
		// "After merge" fixture (ticket contract): TRA-22's migration would have left exactly
		// these two canonical genre nodes on disk, with the redirect table below mapping each
		// loser slug onto its survivor. Nothing else lives under nodes/genre/.
		await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));
		await cache.write(genreNode({ slug: "genre:idm", name: "IDM", qid: IDM_QID }));

		const redirects = parseGenreRedirects({
			redirects: {
				"genre:electronic-music": "genre:electronic",
				"genre:intelligent-dance-music": "genre:idm",
			},
		});
		const resolver = await loadGenreResolver();
		const genreRegistry = createGenreRegistry({ cache, resolver, redirects });

		const createMaterializeService = await loadCreateMaterializeService();
		materializeService = createMaterializeService({ cache, env: ENV, genreRegistry });
		const createNodeService = await loadCreateNodeService();
		getNode = createNodeService({ cache, runJit: materializeService.runJit, redirects });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it(
		"scenario 1 — MusicBrainz producer: an artist's MB genre tag for a merged loser resolves onto the survivor",
		async () => {
			const filesBefore = await genreFileCount(cache);
			installPipelineMocks({
				draft: artistDraftFixture(),
				mbGenres: [{ name: "electronic music", mbid: ELECTRONIC_MBID }],
			});

			const result = await materializeService.handleMaterialize({ type: "artist", name: "Fixture Artist" });

			const artist = result.node as ArtistNode;
			expect(artist.genres[0]?.slug).toBe("genre:electronic");
			// Artist node is new, but zero genre files are created — the artist merely references
			// the already-cached survivor.
			expect(await genreFileCount(cache)).toBe(filesBefore);
			await expectNoDuplicateGroups(cache);
		},
		TIMEOUT_MS,
	);

	it(
		"scenario 2 — Gemini producer: a freshly minted genre's related/subgenre edges resolve onto survivors",
		async () => {
			const filesBefore = await genreFileCount(cache);
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Fixture Genre",
					parent_genres: [],
					subgenres: [{ type: "genre", name: "Intelligent dance music" }],
					related_genres: [{ type: "genre", name: "Electronic music" }],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});

			const result = await materializeService.handleMaterialize({ type: "genre", name: "Fixture Genre" });

			const genre = result.node as GenreNode;
			expect(genre.related_genres.map((r) => r.slug)).toEqual(["genre:electronic"]);
			expect(genre.subgenres.map((s) => s.slug)).toEqual(["genre:idm"]);
			// Exactly +1: the new genre node itself. Its related/subgenre edges point at survivors
			// already on disk, they never mint new files of their own.
			expect(await genreFileCount(cache)).toBe(filesBefore + 1);
			await expectNoDuplicateGroups(cache);
		},
		TIMEOUT_MS,
	);

	it(
		"scenario 3 — catalog backfill: a Wikidata parent_genres backfill for a merged loser resolves onto the survivor",
		async () => {
			const filesBefore = await genreFileCount(cache);
			// data/genre-catalog.json's "acid" entry has exactly one parent, "electronic-music" —
			// the loser slug TRA-22 merges into genre:electronic (56 catalog entries share that
			// same parent; "acid" is picked because it has no data/genre-aliases.json entry, so its
			// own qid resolves via the resolver's step-2 exact catalog-name match, not an
			// alias/heuristic — verified 2026-09-10 against the real committed data files).
			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Acid",
					parent_genres: [],
					subgenres: [],
					related_genres: [],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});

			const result = await materializeService.handleMaterialize({ type: "genre", name: "Acid" });

			const genre = result.node as GenreNode;
			expect(genre.parent_genres.map((p) => p.slug)).toEqual(["genre:electronic"]);
			expect(genre.parent_genres.some((p) => p.slug === "genre:electronic-music")).toBe(false);
			expect(await genreFileCount(cache)).toBe(filesBefore + 1);
			await expectNoDuplicateGroups(cache);
		},
		TIMEOUT_MS,
	);

	it(
		"scenario 4 — materialize guard: requesting a merged loser by name serves the survivor from cache, minting nothing",
		async () => {
			const filesBefore = await genreFileCount(cache);
			// No installPipelineMocks() call in this test on purpose: the canonicalization guard in
			// handleMaterialize (src/services/materialize-service.ts) must serve the cached survivor
			// and never reach the pipeline at all. Arm tavilySearch to throw a distinctive error so a
			// guard regression that wrongly falls through to runJit fails loudly here instead of
			// hanging on (or silently satisfying) a stale mock from a previous test.
			const tavilySearch = await loadTavilySearch();
			vi.mocked(tavilySearch)
				.mockReset()
				.mockImplementation(async () => {
					throw new Error("unexpected pipeline run");
				});

			const result = await materializeService.handleMaterialize({ type: "genre", name: "Electronic music" });

			expect(result.node.slug).toBe("genre:electronic");
			expect(result.source).toBe("cache");
			expect(await genreFileCount(cache)).toBe(filesBefore);
			await expectNoDuplicateGroups(cache);
		},
		TIMEOUT_MS,
	);

	it(
		"scenario 5 — read path: getNode on a merged loser's slug is redirected to the survivor",
		async () => {
			const filesBefore = await genreFileCount(cache);
			// Same paranoia as scenario 4 — a plain read of a fresh cache node must never touch the
			// pipeline (node-service.ts's TTL-refresh branch is not supposed to trigger here).
			const tavilySearch = await loadTavilySearch();
			vi.mocked(tavilySearch)
				.mockReset()
				.mockImplementation(async () => {
					throw new Error("unexpected pipeline run");
				});

			const result = await getNode("genre:intelligent-dance-music");

			expect(result?.node.slug).toBe("genre:idm");
			expect(await genreFileCount(cache)).toBe(filesBefore);
			await expectNoDuplicateGroups(cache);
		},
		TIMEOUT_MS,
	);

	// FIXED (TRA-43, 2026-09-10): materializing "Dance" then "Club" by name used to fail against
	// real committed data -- handleMaterialize's genre guard had no qid/mbid, so
	// resolve({name:"Dance"}) matched the catalog's OWN "dance" entry (Q8195422, unrelated), and
	// resolve({name:"Club"}) found nothing -- two nodes for one MB identity. Requests below carry
	// the artist edge's own `slug`/`qid`, the way the front chip does (TRA-38). Per the
	// review-round-1 security fix, an unresolved `slug` is a lookup key only: request 1 mints
	// under the NAME-derived "genre:dance" (stamped via PipelineInput.qid); request 2's
	// `slug`/`qid` let the registry's qid index (rule 4) find that node and serve it from cache.
	it(
		"scenario 6 — two MusicBrainz tags sharing a QID converge onto one artist edge, and separate by-name materializations converge on one node",
		async () => {
			const filesBefore = await genreFileCount(cache);
			installPipelineMocks({
				draft: artistDraftFixture(),
				mbGenres: [
					{ name: "club", mbid: CLUB_MBID },
					{ name: "dance", mbid: DANCE_MBID },
				],
			});

			const artistResult = await materializeService.handleMaterialize({
				type: "artist",
				name: "Fixture Artist",
			});
			const artist = artistResult.node as ArtistNode;
			// TRA-36's shared batchMemo (src/genre-registry.ts canonicalizeGenreEdges): both tags
			// resolve to the same QID via mbid, so the second collapses onto the first's slug and is
			// de-duped away — one edge, not two.
			expect(artist.genres).toHaveLength(1);
			const edge = artist.genres[0];
			expect(edge?.qid).toBe(CLUB_DANCE_QID);
			// Narrow away `undefined` (exactOptionalPropertyTypes) so it passes straight through below.
			if (!edge?.slug) throw new Error("expected the deduped artist edge to carry a slug");
			const edgeSlug = edge.slug;

			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Dance",
					parent_genres: [],
					subgenres: [],
					related_genres: [],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});
			const danceResult = await materializeService.handleMaterialize({
				type: "genre",
				name: "Dance",
				slug: edgeSlug,
				qid: CLUB_DANCE_QID,
			});

			installPipelineMocks({
				draft: genreDraftFixture({
					name: "Club",
					parent_genres: [],
					subgenres: [],
					related_genres: [],
					key_artists: [],
					key_labels: [],
					landmark_tracks: [],
				}),
			});
			const clubResult = await materializeService.handleMaterialize({
				type: "genre",
				name: "Club",
				slug: edgeSlug,
				qid: CLUB_DANCE_QID,
			});

			expect(clubResult.node.slug).toBe(danceResult.node.slug);
			// Nit (review round 1): without these, this scenario stays green even if the guard
			// mints the WRONG qid, or request 2 mints a second file instead of hitting the cache.
			expect((danceResult.node as GenreNode).qid).toBe(CLUB_DANCE_QID);
			expect(clubResult.source).toBe("cache");
			expect(await genreFileCount(cache)).toBe(filesBefore + 1);
			await expectNoDuplicateGroups(cache);
		},
		TIMEOUT_MS,
	);
});
