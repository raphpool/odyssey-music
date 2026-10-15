/**
 * Reusable mocks + fixtures for the runPipeline e2e harness (TRA-25).
 *
 * `runPipeline` (src/pipeline.ts) has external network boundaries: Tavily search,
 * the Firecrawl search fallback (TRA-242), the local page fetcher, the Gemini SDK, and
 * the MusicBrainz HTTP adapter. This module mocks those and nothing else —
 * `src/genre-identity.ts` and the genre catalog under `data/` are ours and run for real
 * against the committed files (CLAUDE.md: mock external boundaries, not code we own).
 *
 * Usage from a test file:
 *
 *   import { installPipelineMocks, artistDraftFixture } from "./helpers/pipeline-mocks.js";
 *   installPipelineMocks({ draft: artistDraftFixture() });
 *   const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, deps);
 *
 * Every boundary function starts out throwing "unexpected call: <name>" so an
 * incomplete fixture fails loudly instead of quietly returning `undefined` deep
 * inside canonicalizeDraft/enrichFromMusicBrainz. `installPipelineMocks` re-arms
 * only the calls the nominal artist/genre scenarios actually make.
 *
 * Caveat for future tests built on this harness: every MusicBrainz call inside
 * enrichFromMusicBrainz (src/pipeline.ts) is wrapped in a try/catch that only logs
 * and continues on failure — so an "unexpected call" thrown from an unarmed MB
 * export is swallowed there, not surfaced as a test failure. Assert the resulting
 * node shape precisely (as the artist test below does for `genres[].qid`) rather
 * than assuming a missing mock will always throw all the way out to the test.
 */
import { GoogleGenAI } from "@google/genai";
import { afterAll, vi } from "vitest";
import {
	fetchArtistDiscographyMb,
	fetchArtistEntityMb,
	fetchEntityGenresMb,
	fetchLabelEntityMb,
	fetchLabelMetaMb,
	fetchProjectMetaMb,
	fetchTrackMetaMb,
	findArtistMbidByName,
	findLabelMbidByName,
	findRecordingMbidByName,
	findReleaseGroupMbidByName,
} from "../../src/musicbrainz.js";
import { firecrawlSearch } from "../../src/tools/firecrawl-search.js";
import { localFetch } from "../../src/tools/local-fetcher.js";
import { tavilySearch } from "../../src/tools/tavily.js";
import type { NodeType } from "../../src/types.js";

// pipelineConfig (src/config.ts) reads GEMINI_API_KEY at module import time, and the
// nominal `runPipeline` call in these tests deliberately omits `deps.geminiApiKey` to
// exercise that env fallback (src/pipeline.ts:727). Stubbing here, before this file's
// own imports finish and long before the test file imports src/pipeline.js, guarantees
// config.ts sees the stubbed value the first (and only) time it reads process.env.
//
// vi.stubEnv mutates the real process.env, which is a single global object shared by
// the whole worker process — vitest.config.ts does not set `unstubEnvs: true`, so
// without an explicit unstub this would leak "test-gemini-key" into GEMINI_API_KEY for
// every other test file sharing the worker. afterAll here is scoped to whichever test
// file imports this module (vitest binds top-level hooks to the importing file's suite).
vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
afterAll(() => {
	vi.unstubAllEnvs();
});

function unexpectedCall(name: string): () => Promise<never> {
	return async () => {
		throw new Error(`unexpected call: ${name}(...)`);
	};
}

// --- Mock module factories -------------------------------------------------

vi.mock("../../src/tools/tavily.js", async (importOriginal) => {
	// rankResults/rankUrl are pure local sorting logic, not a network boundary — keep
	// the real implementation and mock only the actual HTTP call, tavilySearch.
	const actual = await importOriginal<typeof import("../../src/tools/tavily.js")>();
	return {
		...actual,
		tavilySearch: vi.fn(unexpectedCall("tavilySearch")),
	};
});

vi.mock("../../src/tools/firecrawl-search.js", () => ({
	firecrawlSearch: vi.fn(unexpectedCall("firecrawlSearch")),
}));

vi.mock("../../src/tools/local-fetcher.js", () => ({
	localFetch: vi.fn(unexpectedCall("localFetch")),
}));

vi.mock("@google/genai", () => ({
	GoogleGenAI: vi.fn(() => ({
		models: { generateContent: unexpectedCall("GoogleGenAI.models.generateContent") },
	})),
	// Real values from @google/genai's Type enum (src/pipeline.ts's schema builders read
	// GType.STRING/OBJECT/ARRAY at call time, before generateContent is ever invoked).
	Type: {
		TYPE_UNSPECIFIED: "TYPE_UNSPECIFIED",
		STRING: "STRING",
		NUMBER: "NUMBER",
		INTEGER: "INTEGER",
		BOOLEAN: "BOOLEAN",
		ARRAY: "ARRAY",
		OBJECT: "OBJECT",
		NULL: "NULL",
	},
}));

vi.mock("../../src/musicbrainz.js", () => ({
	findArtistMbidByName: vi.fn(unexpectedCall("findArtistMbidByName")),
	fetchArtistDiscographyMb: vi.fn(unexpectedCall("fetchArtistDiscographyMb")),
	fetchArtistEntityMb: vi.fn(unexpectedCall("fetchArtistEntityMb")),
	fetchEntityGenresMb: vi.fn(unexpectedCall("fetchEntityGenresMb")),
	findLabelMbidByName: vi.fn(unexpectedCall("findLabelMbidByName")),
	fetchLabelMetaMb: vi.fn(unexpectedCall("fetchLabelMetaMb")),
	fetchLabelEntityMb: vi.fn(unexpectedCall("fetchLabelEntityMb")),
	findRecordingMbidByName: vi.fn(unexpectedCall("findRecordingMbidByName")),
	fetchTrackMetaMb: vi.fn(unexpectedCall("fetchTrackMetaMb")),
	findReleaseGroupMbidByName: vi.fn(unexpectedCall("findReleaseGroupMbidByName")),
	fetchProjectMetaMb: vi.fn(unexpectedCall("fetchProjectMetaMb")),
}));

// --- Fixed search/fetch fixtures -------------------------------------------

/** The one search result + page pipeline.ts's research step will see. Wikipedia host
 * so `hasWiki` is true and `fetchTopKWithWiki` (default 1) fetches exactly this URL. */
export const FIXTURE_WIKI_URL = "https://en.wikipedia.org/wiki/Fixture_Artist";

const FIXTURE_SEARCH_RESULTS = [
	{
		title: "Fixture Artist - Wikipedia",
		url: FIXTURE_WIKI_URL,
		content: "Fixture Artist is a fictional musician invented for the runPipeline e2e test harness.",
	},
];

const FIXTURE_PAGE_MARKDOWN =
	"# Fixture Artist\n\nFixture Artist is a fictional electronic musician invented for the " +
	"runPipeline e2e test harness (TRA-25). This text exists only so canonicalizeDraft has " +
	"grounded corpus markdown to validate citations against.";

// A real MusicBrainz genre MBID mapped to a Wikidata QID in the committed
// data/genre-qid-map.json ("techno" -> Q170611), so the default fixture exercises the
// real qid-stamping path (genre-identity.ts + the catalog) end to end, not a fake mbid
// that happens to collide with the map by coincidence.
const DEFAULT_MB_GENRE_MBID = "41fe3260-fcc1-450b-bd5a-803886c56912";

export interface MockMbGenre {
	name: string;
	mbid?: string;
}

const DEFAULT_MB_GENRES: readonly MockMbGenre[] = [{ name: "techno", mbid: DEFAULT_MB_GENRE_MBID }];

export interface InstallPipelineMocksOptions {
	/** The raw JSON object the mocked Gemini call returns as `resp.text` (JSON.stringify'd). */
	draft: Record<string, unknown>;
	/** Optional Gemini boundary override for retry-policy regressions. */
	generateContent?: () => Promise<unknown>;
	/** MusicBrainz genre tags returned by fetchEntityGenresMb. Defaults to a single
	 * real techno tag with a QID-mapped mbid. */
	mbGenres?: readonly MockMbGenre[];
}

/**
 * (Re)installs all boundary mocks for one `runPipeline` call. Resets every
 * MusicBrainz export back to its "unexpected call" default first, then arms only the
 * calls the nominal artist scenario makes (findArtistMbidByName, fetchArtistDiscographyMb,
 * fetchEntityGenresMb) — every other MB export stays throwing, on purpose, until a future
 * ticket's test needs it.
 *
 * tavilySearch is armed with the fixture results (the default provider); firecrawlSearch
 * (TRA-242) is reset back to throwing "unexpected call" like the unused MB exports — a test
 * exercising `deps.searchProvider: "firecrawl"` must arm it itself, so an accidental
 * fallback to Tavily in a firecrawl-provider test still fails loudly, and every other
 * suite keeps proving firecrawlSearch is never called.
 */
export function installPipelineMocks(options: InstallPipelineMocksOptions): void {
	const mbGenres = options.mbGenres ?? DEFAULT_MB_GENRES;

	vi.mocked(tavilySearch)
		.mockReset()
		.mockImplementation(async () => FIXTURE_SEARCH_RESULTS);

	resetToUnexpected(firecrawlSearch, "firecrawlSearch");

	vi.mocked(localFetch)
		.mockReset()
		.mockImplementation(async (url: string) => {
			if (url !== FIXTURE_WIKI_URL) throw new Error(`unexpected call: localFetch(${url})`);
			return {
				url,
				title: "Fixture Artist",
				markdown: FIXTURE_PAGE_MARKDOWN,
				httpStatus: 200,
				bytes: FIXTURE_PAGE_MARKDOWN.length,
			};
		});

	vi.mocked(GoogleGenAI)
		.mockReset()
		.mockImplementation(
			() =>
				({
					models: {
						generateContent: vi.fn(
							options.generateContent ??
								(async () => ({
									text: JSON.stringify(options.draft),
									usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 42 },
								})),
						),
					},
				}) as unknown as GoogleGenAI,
		);

	resetToUnexpected(findArtistMbidByName, "findArtistMbidByName");
	resetToUnexpected(fetchArtistDiscographyMb, "fetchArtistDiscographyMb");
	resetToUnexpected(fetchArtistEntityMb, "fetchArtistEntityMb");
	resetToUnexpected(fetchEntityGenresMb, "fetchEntityGenresMb");
	resetToUnexpected(findLabelMbidByName, "findLabelMbidByName");
	resetToUnexpected(fetchLabelMetaMb, "fetchLabelMetaMb");
	resetToUnexpected(fetchLabelEntityMb, "fetchLabelEntityMb");
	resetToUnexpected(findRecordingMbidByName, "findRecordingMbidByName");
	resetToUnexpected(fetchTrackMetaMb, "fetchTrackMetaMb");
	resetToUnexpected(findReleaseGroupMbidByName, "findReleaseGroupMbidByName");
	resetToUnexpected(fetchProjectMetaMb, "fetchProjectMetaMb");

	// Only the artist path (src/pipeline.ts enrichFromMusicBrainz) calls these three for
	// the nominal artist/genre fixtures — every other MB export stays throwing above.
	vi.mocked(findArtistMbidByName).mockImplementation(async () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
	vi.mocked(fetchArtistDiscographyMb).mockImplementation(async () => []);
	vi.mocked(fetchEntityGenresMb).mockImplementation(async () => [...mbGenres]);
}

/** Resets one MusicBrainz mock back to its default throwing implementation. */
function resetToUnexpected<TArgs extends unknown[], TReturn>(
	fn: (...args: TArgs) => Promise<TReturn>,
	name: string,
): void {
	vi.mocked(fn).mockReset();
	vi.mocked(fn).mockImplementation(unexpectedCall(name) as unknown as (...args: TArgs) => Promise<TReturn>);
}

// --- Node draft fixtures -----------------------------------------------------

export interface EdgeRefFixture {
	type: NodeType;
	name: string;
	/** Required on project/track references (TRA-462). */
	artist?: string;
}

/** A minimal artist draft valid against canonicalizeDraft + nodePayloadSchema (artistSchema). */
export function artistDraftFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "Fixture Artist",
		editorial_article:
			"Fixture Artist is a fictional electronic musician invented for the runPipeline " +
			"end-to-end test harness (TRA-25). No real-world facts are claimed here.",
		citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture Artist" }],
		editorial_bio: "Fictional electronic musician invented for the test harness.",
		origin: "Test fixture, nowhere",
		active_years: "2020-present",
		genres: [{ type: "genre", name: "Techno" }] satisfies EdgeRefFixture[],
		labels: [{ type: "label", name: "Fixture Label" }] satisfies EdgeRefFixture[],
		discography: [
			{ type: "project", name: "Fixture Album", artist: "Fixture Artist" },
			{ type: "project", name: "Fixture EP", artist: "Fixture Artist" },
		] satisfies EdgeRefFixture[],
		notable_tracks: [
			{ type: "track", name: "Fixture Track", artist: "Fixture Artist" },
		] satisfies EdgeRefFixture[],
		...overrides,
	};
}

/** A minimal genre draft valid against canonicalizeDraft + nodePayloadSchema (genreSchema). */
export function genreDraftFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "Fixture Genre",
		editorial_article:
			"Fixture Genre is a fictional music genre invented for the runPipeline end-to-end " +
			"test harness (TRA-25). It has no real-world referent.",
		citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture Artist" }],
		editorial_definition: "A fictional test genre with no real musical characteristics.",
		era: "2020s",
		origin: "Test fixture",
		sonic_markers: "None — fixture only.",
		parent_genres: [{ type: "genre", name: "Electronic" }] satisfies EdgeRefFixture[],
		subgenres: [{ type: "genre", name: "Fixture Subgenre" }] satisfies EdgeRefFixture[],
		related_genres: [
			{ type: "genre", name: "Techno" },
			{ type: "genre", name: "House" },
		] satisfies EdgeRefFixture[],
		key_artists: [{ type: "artist", name: "Fixture Artist" }] satisfies EdgeRefFixture[],
		key_labels: [{ type: "label", name: "Fixture Label" }] satisfies EdgeRefFixture[],
		landmark_tracks: [
			{ type: "track", name: "Fixture Track", artist: "Fixture Artist" },
		] satisfies EdgeRefFixture[],
		...overrides,
	};
}
