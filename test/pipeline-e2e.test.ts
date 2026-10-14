import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry, parseGenreRedirects } from "../src/genre-registry.js";
import type { PipelineDeps } from "../src/pipeline.js";
import type { ArtistNode, GenreNode, Slug } from "../src/types.js";
import {
	artistDraftFixture,
	FIXTURE_WIKI_URL,
	genreDraftFixture,
	installPipelineMocks,
} from "./helpers/pipeline-mocks.js";

// TRA-25: end-to-end runPipeline harness, all four external boundaries mocked
// (tavily, local-fetcher, @google/genai, musicbrainz). No network call, no real API key —
// see test/helpers/pipeline-mocks.ts for what's mocked and why.
//
// runPipeline itself is imported dynamically (below), not statically, on purpose: its
// module graph pulls in the real musicbrainz.js/tavily.js/local-fetcher.js/@google/genai
// unless pipeline-mocks.ts's vi.mock() calls have already registered. ES modules evaluate
// in import-declaration order, and Biome's import sorter reorders "../src/..." ahead of
// "./helpers/..." — a static `import { runPipeline } from "../src/pipeline.js"` would get
// sorted above the mocks import and silently start making real network calls. `import
// type` is erased at compile time (order-irrelevant); only the dynamic import loads code.
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;

describe("runPipeline e2e (mocked boundaries)", () => {
	it("does not retry a transient Gemini failure when maxProviderAttempts is one (TRA-295)", async () => {
		const generateContent = vi.fn(async () => {
			throw new Error("503 unavailable");
		});
		installPipelineMocks({ draft: artistDraftFixture(), generateContent });
		const runPipeline = await loadRunPipeline();

		await expect(
			runPipeline({ type: "artist", name: "Fixture Artist" }, { ...DEPS, maxProviderAttempts: 1 }),
		).rejects.toThrow("503 unavailable");
		expect(generateContent).toHaveBeenCalledTimes(1);
	});

	it(
		"materializes an artist node, with genres[] reflecting the MusicBrainz mock",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect(result.node.type).toBe("artist");
			expect(result.node.slug).toBe("artist:fixture-artist");
			const artist = result.node as ArtistNode;
			// mbGenres default fixture: techno's real MBID, mapped to Q170611 in
			// data/genre-qid-map.json — resolved for real via genre-identity.ts.
			expect(artist.genres).toEqual([
				{ slug: "genre:techno", type: "genre", name: "Techno", qid: "Q170611" },
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"materializes a genre node, with related_genres/subgenres present",
		async () => {
			installPipelineMocks({ draft: genreDraftFixture() });
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "genre", name: "Fixture Genre" }, DEPS);

			expect(result.node.type).toBe("genre");
			const genre = result.node as GenreNode;
			expect(genre.related_genres.length).toBeGreaterThan(0);
			expect(genre.subgenres.length).toBeGreaterThan(0);
		},
		TIMEOUT_MS,
	);
});

// TRA-28: wires src/genre-registry.ts (TRA-27) into runPipeline, between enrichFromMusicBrainz
// and validateNode. These four scenarios are the ticket's acceptance criteria — cache and
// registry are real (mkdtemp'd NodeCache, real loadGenreResolver() reading the committed
// data/ files), only the pipeline's four external boundaries stay mocked (see the harness
// comment above and test/helpers/pipeline-mocks.ts).
describe("genre registry wiring (TRA-28)", () => {
	// Real MusicBrainz MBID for the "electronic" genre tag (data/genre-qid-map.json), which
	// maps to Wikidata Q9778 — the same QID data/genre-catalog.json's "electronic music"
	// entry (slug "electronic-music") carries. Exercises the mbid-priority resolver path.
	const ELECTRONIC_MBID = "89255676-1f14-4dd8-bbad-fca839d6aff4";
	const ELECTRONIC_QID = "Q9778";

	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-pipeline-e2e-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** Minimal valid GenreNode for seeding the cache directly via cache.write(). */
	function genreNode(overrides: Partial<GenreNode> & { slug: Slug; name: string }): GenreNode {
		return {
			type: "genre",
			editorial_article:
				"A real long article about this genre, well past the eighty character floor. ".repeat(2),
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

	it(
		"canonicalizes an MB genre tag onto an existing node cached under another slug",
		async () => {
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: parseGenreRedirects({
					redirects: { "genre:electronic-music": "genre:electronic" },
				}),
			});
			const deps: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test", genreRegistry };
			installPipelineMocks({
				draft: artistDraftFixture(),
				mbGenres: [{ name: "electronic music", mbid: ELECTRONIC_MBID }],
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, deps);

			const artist = result.node as ArtistNode;
			expect(artist.genres[0]?.slug).toBe("genre:electronic");
			expect(artist.genres[0]?.qid).toBe(ELECTRONIC_QID);
		},
		TIMEOUT_MS,
	);

	it(
		"leaves an edge pointing at its own existing node unchanged, even without a redirect",
		async () => {
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));
			await cache.write(
				genreNode({ slug: "genre:electronic-music", name: "Electronic Music", qid: ELECTRONIC_QID }),
			);
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});
			const deps: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test", genreRegistry };
			installPipelineMocks({
				draft: artistDraftFixture(),
				mbGenres: [{ name: "electronic music", mbid: ELECTRONIC_MBID }],
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, deps);

			const artist = result.node as ArtistNode;
			expect(artist.genres[0]?.slug).toBe("genre:electronic-music");
		},
		TIMEOUT_MS,
	);

	it(
		"canonicalizes a Gemini draft's genre edge naming an existing genre under a variant name",
		async () => {
			await cache.write(genreNode({ slug: "genre:electronic", name: "Electronic", qid: ELECTRONIC_QID }));
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});
			const deps: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test", genreRegistry };
			installPipelineMocks({
				draft: genreDraftFixture({ related_genres: [{ type: "genre", name: "Electronic music" }] }),
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "genre", name: "Fixture Genre" }, deps);

			const genre = result.node as GenreNode;
			expect(genre.related_genres[0]?.slug).toBe("genre:electronic");
		},
		TIMEOUT_MS,
	);

	it(
		"leaves the name-derived slug untouched when runPipeline is called without a genreRegistry",
		async () => {
			// Non-regression: same cache/redirect setup as the first scenario, but deps omit
			// genreRegistry entirely — proves the dependency is truly optional (TRA-28 contract).
			installPipelineMocks({
				draft: artistDraftFixture(),
				mbGenres: [{ name: "electronic music", mbid: ELECTRONIC_MBID }],
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(
				{ type: "artist", name: "Fixture Artist" },
				{ tavilyApiKey: "test", firecrawlApiKey: "test" },
			);

			const artist = result.node as ArtistNode;
			expect(artist.genres[0]?.slug).toBe("genre:electronic-music");
		},
		TIMEOUT_MS,
	);

	it(
		"mints a fresh name-derived slug on an empty cache (rule 5), then a second run converges on it (rule 2)",
		async () => {
			// TRA-28 review: the four scenarios above all pre-seed the target node -- this is the
			// crawler's main window (a genre minted by one worker, referenced again before a
			// second worker/run has a chance to see it in cache): nothing to canonicalize against
			// yet, so the pipeline mints the name-derived slug same as always (rule 5); once that
			// node is actually persisted, a later run resolving the SAME mbid must converge on it
			// unchanged (rule 2), not mint yet another name-derived variant.
			const genreRegistry = createGenreRegistry({
				cache,
				resolver: await loadGenreResolver(),
				redirects: new Map(),
			});
			const deps: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test", genreRegistry };

			installPipelineMocks({
				draft: artistDraftFixture(),
				mbGenres: [{ name: "electronic music", mbid: ELECTRONIC_MBID }],
			});
			const runPipeline = await loadRunPipeline();

			const first = await runPipeline({ type: "artist", name: "Fixture Artist" }, deps);
			const firstArtist = first.node as ArtistNode;
			expect(firstArtist.genres[0]?.slug).toBe("genre:electronic-music");
			expect(firstArtist.genres[0]?.qid).toBe(ELECTRONIC_QID);
			await cache.write(first.node);

			installPipelineMocks({
				draft: artistDraftFixture({ name: "Fixture Artist Two" }),
				mbGenres: [{ name: "electronic music", mbid: ELECTRONIC_MBID }],
			});
			const second = await runPipeline({ type: "artist", name: "Fixture Artist Two" }, deps);
			const secondArtist = second.node as ArtistNode;
			expect(secondArtist.genres[0]?.slug).toBe("genre:electronic-music");
		},
		TIMEOUT_MS,
	);
});

// TRA-XXX: researchTarget only pinned track/project/label searches to the MBID's MB
// disambiguation before this fix — artist searches went out by name alone, so a homonym
// (e.g. "Tracy Onne", MB-tagged as a Spanish makina DJ) could pull up an unrelated
// Wikipedia page. With an mbid on the artist input, fetchArtistEntityMb's disambiguation
// (and country/area) must now flow into the query sent to the search provider.
describe("artist MB disambiguation hint (TRA-XXX)", () => {
	const ARTIST_MBID = "11111111-2222-3333-4444-555555555555";

	it(
		"appends the MB disambiguation to the search query for an artist input with an mbid",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const [{ tavilySearch }, { fetchArtistEntityMb }] = await Promise.all([
				import("../src/tools/tavily.js"),
				import("../src/musicbrainz.js"),
			]);
			vi.mocked(fetchArtistEntityMb).mockImplementation(async () => ({
				mbid: ARTIST_MBID,
				name: "Fixture Artist",
				country: "ES",
				area: null,
				disambiguation: "Spanish makina DJ",
			}));

			await runPipeline({ type: "artist", name: "Fixture Artist", mbid: ARTIST_MBID }, DEPS);

			expect(tavilySearch).toHaveBeenCalledTimes(1);
			const query = vi.mocked(tavilySearch).mock.calls[0]?.[1];
			expect(query).toContain("Spanish makina DJ");
			expect(query).toContain("ES");
		},
		TIMEOUT_MS,
	);
});

// TRA-459: with Wikipedia in the top 4, the corpus used to hold Wikipedia alone, so the
// node was written with a single citation. It now also reads the best non-Wikipedia,
// non-Reddit, non-streaming result, and canonicalizeDraft keeps at least two citations
// whenever the corpus has two pages.
describe("research corpus has at least two source pages (TRA-459)", () => {
	const WIKI_URL = FIXTURE_WIKI_URL;
	const DISCOGS_URL = "https://www.discogs.com/artist/1-Fixture-Artist";
	const SPOTIFY_URL = "https://open.spotify.com/artist/fixture";
	const REDDIT_URL = "https://www.reddit.com/r/fixture/comments/abc";

	function searchResult(url: string) {
		return { title: `Result ${url}`, url, content: `Snippet for ${url}` };
	}

	/** Arms the search + fetch boundaries; returns the localFetch mock to assert on. */
	async function armSources(urls: readonly string[]) {
		const [{ tavilySearch }, { localFetch }] = await Promise.all([
			import("../src/tools/tavily.js"),
			import("../src/tools/local-fetcher.js"),
		]);
		vi.mocked(tavilySearch).mockImplementation(async () => urls.map(searchResult));
		vi.mocked(localFetch).mockReset();
		vi.mocked(localFetch).mockImplementation(async (url: string) => ({
			url,
			title: `Page ${url}`,
			markdown: `Fixture Artist is a fictional electronic musician (source ${url}).`,
			httpStatus: 200,
			bytes: 64,
		}));
		return localFetch;
	}

	const fetchedUrls = (localFetch: Awaited<ReturnType<typeof armSources>>): string[] =>
		vi.mocked(localFetch).mock.calls.map((call) => call[0]);

	it(
		"reads Wikipedia and the best non-streaming result, and writes both as citations",
		async () => {
			installPipelineMocks({
				draft: artistDraftFixture({
					citations: [{ url: WIKI_URL }, { url: DISCOGS_URL }],
				}),
			});
			const localFetch = await armSources([WIKI_URL, DISCOGS_URL, SPOTIFY_URL]);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect(fetchedUrls(localFetch)).toEqual([WIKI_URL, DISCOGS_URL]);
			expect(result.node.citations.map((c) => c.url)).toEqual([WIKI_URL, DISCOGS_URL]);
		},
		TIMEOUT_MS,
	);

	it(
		"skips Reddit and streaming sites: Wikipedia alone, one citation",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const localFetch = await armSources([WIKI_URL, REDDIT_URL, SPOTIFY_URL]);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect(fetchedUrls(localFetch)).toEqual([WIKI_URL]);
			expect(result.node.citations.map((c) => c.url)).toEqual([WIKI_URL]);
		},
		TIMEOUT_MS,
	);

	it(
		"does not fetch a second Wikipedia page in place of an outlet",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const frWiki = "https://fr.wikipedia.org/wiki/Fixture_Artist";
			const localFetch = await armSources([WIKI_URL, frWiki, DISCOGS_URL]);
			const runPipeline = await loadRunPipeline();

			await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect(fetchedUrls(localFetch)).toEqual([WIKI_URL, DISCOGS_URL]);
		},
		TIMEOUT_MS,
	);

	it(
		"keeps the top 3 results when Wikipedia is absent (behavior unchanged)",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const allmusic = "https://www.allmusic.com/artist/fixture";
			const pitchfork = "https://pitchfork.com/features/fixture";
			const localFetch = await armSources([DISCOGS_URL, allmusic, pitchfork, SPOTIFY_URL]);
			const runPipeline = await loadRunPipeline();

			await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect(fetchedUrls(localFetch)).toEqual([DISCOGS_URL, allmusic, pitchfork]);
		},
		TIMEOUT_MS,
	);

	it(
		"completes a one-citation draft to two citations from the corpus, keeping the model's first",
		async () => {
			installPipelineMocks({
				draft: artistDraftFixture({ citations: [{ url: DISCOGS_URL, title: "Discogs" }] }),
			});
			await armSources([WIKI_URL, DISCOGS_URL, SPOTIFY_URL]);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect(result.node.citations.map((c) => c.url)).toEqual([DISCOGS_URL, WIKI_URL]);
			expect(result.node.citations[0]?.title).toBe("Discogs");
		},
		TIMEOUT_MS,
	);

	it(
		"never completes citations with a URL outside the corpus (search results never read)",
		async () => {
			installPipelineMocks({
				draft: artistDraftFixture({
					citations: [{ url: WIKI_URL }, { url: "https://invented.example.com/page" }],
				}),
			});
			await armSources([WIKI_URL, REDDIT_URL, SPOTIFY_URL]);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect(result.node.citations.map((c) => c.url)).toEqual([WIKI_URL]);
		},
		TIMEOUT_MS,
	);
});
