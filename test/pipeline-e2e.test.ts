import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeCache } from "../src/cache.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry, parseGenreRedirects } from "../src/genre-registry.js";
import type { MbCredit } from "../src/musicbrainz.js";
import type { PipelineDeps, PipelineInput } from "../src/pipeline.js";
import type { ArtistNode, GenreNode, LabelNode, ProjectNode, Slug, TrackNode } from "../src/types.js";
import {
	artistDraftFixture,
	FIXTURE_WIKI_URL,
	genreDraftFixture,
	installPipelineMocks,
	projectDraftFixture,
	trackDraftFixture,
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

	// TRA-456: similar_artists is filled after drafting (ListenBrainz / graph fallback), never by
	// the LLM — Gemini is not asked for it, and a draft without it must still validate.
	it(
		"leaves similar_artists out of the Gemini artist schema and defaults it to [] (TRA-456)",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const { makeNodeSchema } = await import("../src/pipeline.js");

			const { schema } = makeNodeSchema("artist");
			expect(Object.keys(schema.properties ?? {})).not.toContain("similar_artists");
			expect(schema.required ?? []).not.toContain("similar_artists");

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);
			expect((result.node as ArtistNode).similar_artists).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"drops a similar_artists emitted by the LLM draft (TRA-456)",
		async () => {
			installPipelineMocks({
				draft: artistDraftFixture({ similar_artists: [{ type: "artist", name: "Hallucinated Artist" }] }),
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect((result.node as ArtistNode).similar_artists).toEqual([]);
		},
		TIMEOUT_MS,
	);

	// TRA-458: Gemini double-escapes newlines in its JSON, so generated prose reaches
	// canonicalizeDraft with a literal backslash + "n". It must leave the pipeline as real breaks.
	it(
		"turns literal backslash-n in the article, teaser and text facts into real newlines (TRA-458)",
		async () => {
			const article =
				"Fixture Artist is a fictional electronic musician.\\n\\nSecond paragraph, written for the " +
				"runPipeline end-to-end test harness.\\n\\n\\n\\nThird paragraph with a trailing space. ";
			installPipelineMocks({
				draft: artistDraftFixture({
					editorial_article: article,
					editorial_bio: "Line one.\\nLine two.",
					origin: "Test fixture,\\nnowhere",
				}),
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			const artist = result.node as ArtistNode;
			expect(artist.editorial_article).toBe(
				"Fixture Artist is a fictional electronic musician.\n\nSecond paragraph, written for the " +
					"runPipeline end-to-end test harness.\n\nThird paragraph with a trailing space.",
			);
			expect(artist.editorial_bio).toBe("Line one.\nLine two.");
			expect(artist.origin).toBe("Test fixture,\nnowhere");
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

// TRA-462: work references are scoped by their primary artist, and a work nobody is credited for is
// dropped from the written node (the node itself is kept).
describe("scoped work edges (TRA-462)", () => {
	// Behind ODYSSEY_SCOPED_RELEASE_SLUGS, off by default until TRA-509 flips it.
	beforeEach(() => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it(
		"scopes an artist's track by the artist, filling a missing artist from the node",
		async () => {
			installPipelineMocks({
				draft: artistDraftFixture({
					name: "Rohff",
					notable_tracks: [{ type: "track", name: "Fitna" }],
					discography: [],
				}),
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Rohff" }, DEPS);

			const artist = result.node as ArtistNode;
			expect(artist.notable_tracks).toEqual([
				{ slug: "track:fitna--rohff", type: "track", name: "Fitna", artist: "Rohff" },
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"scopes a genre's landmark project by its artist and drops the same reference without one, with a log",
		async () => {
			installPipelineMocks({
				draft: genreDraftFixture({
					landmark_projects: [
						{ type: "project", name: "New Forms", artist: "Roni Size / Reprazent" },
						{ type: "project", name: "New Forms" },
					],
				}),
			});
			const runPipeline = await loadRunPipeline();
			const lines: string[] = [];

			const result = await runPipeline(
				{ type: "genre", name: "Fixture Genre" },
				{ ...DEPS, logger: (line) => lines.push(line) },
			);

			const genre = result.node as GenreNode;
			expect(genre.landmark_projects.map((e) => e.slug)).toEqual(["project:new-forms--roni-size-reprazent"]);
			expect(genre.landmark_projects[0]?.artist).toBe("Roni Size / Reprazent");
			expect(lines.some((l) => l.includes("edge dropped: no artist"))).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"scopes a project's tracklist by the project's first artist",
		async () => {
			installPipelineMocks({
				draft: {
					name: "Draft Project",
					editorial_article:
						"Draft Project is a fictional album invented for the runPipeline end-to-end harness (TRA-462). " +
						"No real-world facts are claimed here.",
					citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture Artist" }],
					editorial_pitch: "A fictional album used to test tracklist scoping.",
					artists: [{ type: "artist", name: "Autechre" }],
					genres: [],
					tracklist: [{ type: "track", name: "Gantz Graf" }],
					producers: [],
					related_projects: [],
				},
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "project", name: "Draft Project" }, DEPS);

			const project = result.node as ProjectNode;
			expect(project.tracklist.map((e) => e.slug)).toEqual(["track:gantz-graf--autechre"]);
			expect(project.tracklist[0]?.artist).toBe("Autechre");
		},
		TIMEOUT_MS,
	);

	// The MusicBrainz overrides replace these lists right after canonicalization; they must emit the same
	// scoped slugs, or one work ends up under two slugs (PR #421 review).
	const MB_ID = "11111111-2222-3333-4444-555555555555";
	const PROSE =
		"A fictional entity invented for the runPipeline end-to-end harness (TRA-462). No real-world facts are claimed here.";

	it(
		"keeps the discography scoped by the artist when MB resolves an mbid",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture({ name: "Rohff" }) });
			const runPipeline = await loadRunPipeline();
			const { fetchArtistDiscographyMb } = await import("../src/musicbrainz.js");
			vi.mocked(fetchArtistDiscographyMb).mockImplementation(async () => [
				{
					mbid: MB_ID,
					title: "La Fierté",
					firstReleaseDate: "2010-01-01",
					primaryType: "Album",
					secondaryTypes: [],
				},
			]);

			const result = await runPipeline({ type: "artist", name: "Rohff" }, DEPS);

			expect((result.node as ArtistNode).discography).toEqual([
				{
					slug: "project:la-fierte--rohff",
					type: "project",
					name: "La Fierté",
					artist: "Rohff",
					mbid: MB_ID,
					year: "2010",
					releaseType: "album",
				},
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"scopes an MB tracklist by the project's credited artist",
		async () => {
			installPipelineMocks({
				draft: {
					name: "New Forms",
					editorial_article: PROSE,
					citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture Artist" }],
					editorial_pitch: "A fictional album used to test MB tracklist scoping.",
					artists: [{ type: "artist", name: "Roni Size / Reprazent" }],
					genres: [],
					tracklist: [],
					producers: [],
					related_projects: [],
				},
			});
			const runPipeline = await loadRunPipeline();
			const { fetchProjectMetaMb } = await import("../src/musicbrainz.js");
			vi.mocked(fetchProjectMetaMb).mockImplementation(async () => ({
				tracks: [{ mbid: MB_ID, title: "Brown Paper Bag" }],
				label: null,
				artists: [],
				year: null,
				producers: [],
				personnel: [],
				primaryType: "Album",
			}));

			const result = await runPipeline({ type: "project", name: "New Forms", mbid: MB_ID }, DEPS);

			const project = result.node as ProjectNode;
			expect(project.tracklist).toEqual([
				{
					slug: "track:brown-paper-bag--roni-size-reprazent",
					type: "track",
					name: "Brown Paper Bag",
					artist: "Roni Size / Reprazent",
					mbid: MB_ID,
				},
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"scopes a label's MB release by its credit and drops one without a credit",
		async () => {
			installPipelineMocks({
				draft: {
					name: "Full Cycle",
					editorial_article: PROSE,
					citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture Artist" }],
					editorial_description: "A fictional label used to test MB release scoping.",
					genres: [],
					roster: [],
					notable_releases: [],
				},
			});
			const runPipeline = await loadRunPipeline();
			const { fetchLabelMetaMb } = await import("../src/musicbrainz.js");
			vi.mocked(fetchLabelMetaMb).mockImplementation(async () => ({
				roster: [],
				notableReleases: [
					{
						mbid: MB_ID,
						title: "New Forms",
						firstReleaseDate: "1997",
						credit: [{ mbid: "22222222-2222-3333-4444-555555555555", name: "Roni Size / Reprazent" }],
					},
					{
						mbid: "33333333-2222-3333-4444-555555555555",
						title: "Orphan",
						firstReleaseDate: "1998",
						credit: [],
					},
				],
			}));
			const lines: string[] = [];

			const result = await runPipeline(
				{ type: "label", name: "Full Cycle", mbid: MB_ID },
				{ ...DEPS, logger: (line) => lines.push(line) },
			);

			const label = result.node as LabelNode;
			expect(label.notable_releases.map((e) => e.slug)).toEqual(["project:new-forms--roni-size-reprazent"]);
			expect(lines.some((l) => l.includes("edge dropped: no artist") && l.includes("Orphan"))).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"empties members when an artist lists themselves",
		async () => {
			installPipelineMocks({
				draft: artistDraftFixture({ name: "Cartola", members: [{ type: "artist", name: "Cartola" }] }),
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Cartola" }, DEPS);

			expect((result.node as ArtistNode).members).toEqual([]);
		},
		TIMEOUT_MS,
	);
});

// ODYSSEY_SCOPED_RELEASE_SLUGS off (the default until TRA-509): same slugs as main, nothing dropped, so a
// merge on main changes no behaviour before the cache and /materialize are ready.
describe("scoped work edges, flag off (TRA-509)", () => {
	const MB_ID = "11111111-2222-3333-4444-555555555555";
	const PROSE =
		"A fictional entity invented for the runPipeline end-to-end harness (TRA-462). No real-world facts are claimed here.";

	beforeEach(() => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it(
		"keeps bare slugs on the MB discography and keeps a genre work that has no artist",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture({ name: "Rohff" }) });
			const runPipeline = await loadRunPipeline();
			const { fetchArtistDiscographyMb } = await import("../src/musicbrainz.js");
			vi.mocked(fetchArtistDiscographyMb).mockImplementation(async () => [
				{
					mbid: MB_ID,
					title: "La Fierté",
					firstReleaseDate: "2010-01-01",
					primaryType: "Album",
					secondaryTypes: [],
				},
			]);

			const result = await runPipeline({ type: "artist", name: "Rohff" }, DEPS);

			expect((result.node as ArtistNode).discography.map((e) => e.slug)).toEqual(["project:la-fierte"]);
			expect((result.node as ArtistNode).notable_tracks.map((e) => e.slug)).toEqual(["track:fixture-track"]);

			installPipelineMocks({
				draft: genreDraftFixture({
					landmark_projects: [{ type: "project", name: "New Forms" }],
				}),
			});
			const lines: string[] = [];
			const genre = await runPipeline(
				{ type: "genre", name: "Fixture Genre" },
				{ ...DEPS, logger: (line) => lines.push(line) },
			);
			expect((genre.node as GenreNode).landmark_projects.map((e) => e.slug)).toEqual(["project:new-forms"]);
			expect(lines.some((l) => l.includes("edge dropped"))).toBe(false);
		},
		TIMEOUT_MS,
	);

	it(
		"still empties members when an artist lists themselves",
		async () => {
			installPipelineMocks({
				draft: artistDraftFixture({ name: "Cartola", members: [{ type: "artist", name: "Cartola" }] }),
			});
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Cartola" }, DEPS);

			expect((result.node as ArtistNode).members).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"keeps bare slugs on an MB tracklist and on label releases, credited or not",
		async () => {
			installPipelineMocks({
				draft: {
					name: "New Forms",
					editorial_article: PROSE,
					citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture Artist" }],
					editorial_pitch: "A fictional album used to test MB tracklist slugs.",
					artists: [{ type: "artist", name: "Roni Size / Reprazent" }],
					genres: [],
					tracklist: [],
					producers: [],
					related_projects: [],
				},
			});
			const runPipeline = await loadRunPipeline();
			const { fetchProjectMetaMb, fetchLabelMetaMb } = await import("../src/musicbrainz.js");
			vi.mocked(fetchProjectMetaMb).mockImplementation(async () => ({
				tracks: [{ mbid: MB_ID, title: "Brown Paper Bag" }],
				label: null,
				artists: [],
				year: null,
				producers: [],
				personnel: [],
				primaryType: "Album",
			}));
			const project = await runPipeline({ type: "project", name: "New Forms", mbid: MB_ID }, DEPS);
			expect((project.node as ProjectNode).tracklist.map((e) => e.slug)).toEqual(["track:brown-paper-bag"]);

			installPipelineMocks({
				draft: {
					name: "Full Cycle",
					editorial_article: PROSE,
					citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture Artist" }],
					editorial_description: "A fictional label used to test MB release slugs.",
					genres: [],
					roster: [],
					notable_releases: [],
				},
			});
			vi.mocked(fetchLabelMetaMb).mockImplementation(async () => ({
				roster: [],
				notableReleases: [
					{ mbid: MB_ID, title: "Orphan", firstReleaseDate: "1998", credit: [] },
					{
						mbid: "22222222-2222-3333-4444-555555555555",
						title: "New Forms",
						firstReleaseDate: "1997",
						credit: [{ mbid: "33333333-2222-3333-4444-555555555555", name: "Roni Size / Reprazent" }],
					},
				],
			}));
			const label = await runPipeline({ type: "label", name: "Full Cycle", mbid: MB_ID }, DEPS);
			expect((label.node as LabelNode).notable_releases.map((e) => e.slug)).toEqual([
				"project:orphan",
				"project:new-forms",
			]);
		},
		TIMEOUT_MS,
	);
});

// TRA-473: the MusicBrainz identity of a work or an artist is stored on the node, the credit becomes
// `artists`, and the slug MB teaches wins over the one asked for. Boundaries are mocked; slugs, scopes
// and the order of enrichment steps are ours and run for real.
describe("MB identity at enrichment (TRA-473)", () => {
	const RECORDING_MBID = "aaaaaaaa-1111-4111-8111-000000000011";
	const RG_MBID = "bbbbbbbb-1111-4111-8111-000000000022";
	const ROHFF_MBID = "cccccccc-1111-4111-8111-000000000033";
	const RONI_MBID = "2eeba1d4-0000-4000-8000-000000000001";
	const SAKAMOTO_MBID = "dddddddd-1111-4111-8111-000000000044";

	const trackMeta = {
		project: null,
		label: null,
		artists: [],
		year: null,
		duration: null,
		producers: [],
		personnel: [],
	};
	const projectMeta = {
		tracks: [{ mbid: RECORDING_MBID, title: "Brown Paper Bag" }],
		label: null,
		artists: [],
		year: null,
		producers: [],
		personnel: [],
		primaryType: "Album",
	};

	async function mb() {
		return await import("../src/musicbrainz.js");
	}
	/** MusicBrainz answers: the recording / release group is found, with this credit. */
	async function resolvedWork(kind: "recording" | "releaseGroup", title: string, credit: MbCredit[]) {
		const m = await mb();
		const identity = {
			mbid: kind === "recording" ? RECORDING_MBID : RG_MBID,
			title,
			credit,
			primaryType: null,
			firstReleaseDate: null,
		};
		if (kind === "recording") vi.mocked(m.resolveRecording).mockImplementation(async () => identity);
		else vi.mocked(m.resolveReleaseGroup).mockImplementation(async () => identity);
		vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);
		vi.mocked(m.fetchTrackMetaMb).mockImplementation(async () => trackMeta);
		vi.mocked(m.fetchProjectMetaMb).mockImplementation(async () => projectMeta);
		return m;
	}

	describe("flag on", () => {
		beforeEach(() => {
			vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
		});
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it(
			"stores the recording's mbid and credit and keeps a slug that is already canonical",
			async () => {
				installPipelineMocks({ draft: trackDraftFixture("Fitna", "Rohff") });
				const m = await resolvedWork("recording", "Fitna", [{ mbid: ROHFF_MBID, name: "Rohff" }]);
				const { tavilySearch } = await import("../src/tools/tavily.js");
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline(
					{ type: "track", name: "Fitna", artist: "Rohff", slug: "track:fitna--rohff" },
					DEPS,
				);

				expect(result.slug).toBe("track:fitna--rohff");
				expect("requestedSlug" in result).toBe(false);
				const track = result.node as TrackNode;
				expect(track.mbid).toBe(RECORDING_MBID);
				expect(track.artists).toEqual([
					{ slug: "artist:rohff", type: "artist", name: "Rohff", mbid: ROHFF_MBID },
				]);
				// The credit hint reaches MusicBrainz and the web search.
				expect(vi.mocked(m.resolveRecording)).toHaveBeenCalledWith("Fitna", "Rohff");
				expect(vi.mocked(tavilySearch).mock.calls[0]?.[1]).toContain("Fitna Rohff");
			},
			TIMEOUT_MS,
		);

		it(
			"files a project under its MB credit, reports the slug it was asked for, and scopes the tracklist by it",
			async () => {
				installPipelineMocks({ draft: projectDraftFixture("New Forms", "Roni Size") });
				await resolvedWork("releaseGroup", "New Forms", [{ mbid: RONI_MBID, name: "Roni Size / Reprazent" }]);
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline(
					{
						type: "project",
						name: "New Forms",
						artist: "Roni Size",
						slug: "project:new-forms--roni-size",
					},
					DEPS,
				);

				expect(result.slug).toBe("project:new-forms--roni-size-reprazent");
				expect(result.requestedSlug).toBe("project:new-forms--roni-size");
				const project = result.node as ProjectNode;
				expect(project.slug).toBe("project:new-forms--roni-size-reprazent");
				expect(project.mbid).toBe(RG_MBID);
				expect(project.artists[0]).toMatchObject({ name: "Roni Size / Reprazent", mbid: RONI_MBID });
				expect(project.tracklist.map((e) => e.slug)).toEqual(["track:brown-paper-bag--roni-size-reprazent"]);
				expect(project.tracklist.every((e) => e.artist === "Roni Size / Reprazent")).toBe(true);
			},
			TIMEOUT_MS,
		);

		it(
			"does not report a requested slug when none was asked for",
			async () => {
				installPipelineMocks({ draft: projectDraftFixture("New Forms", "Roni Size") });
				await resolvedWork("releaseGroup", "New Forms", [{ mbid: RONI_MBID, name: "Roni Size" }]);
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline({ type: "project", name: "New Forms" }, DEPS);

				expect(result.slug).toBe("project:new-forms--roni-size");
				expect("requestedSlug" in result).toBe(false);
			},
			TIMEOUT_MS,
		);

		it(
			"reuses the cache's artist slug for a credit and scopes a non-Latin credit by the cached name",
			async () => {
				installPipelineMocks({ draft: projectDraftFixture("async", "Ryuichi Sakamoto") });
				await resolvedWork("releaseGroup", "async", [{ mbid: SAKAMOTO_MBID, name: "坂本龍一" }]);
				const runPipeline = await loadRunPipeline();
				const artistByMbid = vi.fn((mbid: string) =>
					mbid === SAKAMOTO_MBID
						? { slug: "artist:ryuichi-sakamoto" as Slug, name: "Ryuichi Sakamoto" }
						: null,
				);

				const result = await runPipeline(
					{ type: "project", name: "async", slug: "project:async--ryuichi-sakamoto" },
					{ ...DEPS, artistByMbid },
				);

				expect(result.slug).toBe("project:async--ryuichi-sakamoto");
				expect("requestedSlug" in result).toBe(false);
				const project = result.node as ProjectNode;
				expect(project.artists).toEqual([
					{ slug: "artist:ryuichi-sakamoto", type: "artist", name: "坂本龍一", mbid: SAKAMOTO_MBID },
				]);
				expect(project.tracklist.map((e) => e.slug)).toEqual(["track:brown-paper-bag--ryuichi-sakamoto"]);
			},
			TIMEOUT_MS,
		);

		it(
			"keeps the slug and the draft's artists, and does not fail, for a non-Latin credit the cache does not know",
			async () => {
				installPipelineMocks({ draft: projectDraftFixture("async", "Ryuichi Sakamoto") });
				await resolvedWork("releaseGroup", "async", [{ mbid: SAKAMOTO_MBID, name: "坂本龍一" }]);
				const runPipeline = await loadRunPipeline();
				const lines: string[] = [];

				const result = await runPipeline(
					{ type: "project", name: "async", slug: "project:async--ryuichi-sakamoto" },
					{ ...DEPS, logger: (line) => lines.push(line) },
				);

				expect(result.slug).toBe("project:async--ryuichi-sakamoto");
				expect("requestedSlug" in result).toBe(false);
				const project = result.node as ProjectNode;
				// The identity is certain, so the mbid stays; only the scope cannot be built.
				expect(project.mbid).toBe(RG_MBID);
				expect(project.artists.map((a) => a.name)).toEqual(["Ryuichi Sakamoto"]);
				// The MB track is dropped with its reason, never scoped by a name that cannot be slugged.
				expect(project.tracklist).toEqual([]);
				expect(lines.some((l) => l.includes("edge dropped: empty-artist"))).toBe(true);
			},
			TIMEOUT_MS,
		);

		it(
			"keeps the slug that was asked for and sets no mbid when MB cannot single the work out",
			async () => {
				installPipelineMocks({
					draft: projectDraftFixture("New Forms", "Roni Size", {
						tracklist: [{ type: "track", name: "Brown Paper Bag" }],
					}),
				});
				const m = await mb();
				vi.mocked(m.resolveReleaseGroup).mockImplementation(async () => null);
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline(
					{ type: "project", name: "New Forms", slug: "project:new-forms--roni-size" },
					DEPS,
				);

				expect(result.slug).toBe("project:new-forms--roni-size");
				expect("requestedSlug" in result).toBe(false);
				const project = result.node as ProjectNode;
				expect(project.mbid).toBeUndefined();
				// The LLM's own list stays, scoped by TRA-462's normalizeEdge from the draft's first artist.
				expect(project.tracklist.map((e) => e.slug)).toEqual(["track:brown-paper-bag--roni-size"]);
			},
			TIMEOUT_MS,
		);

		it(
			"survives MusicBrainz being down: requested slug, LLM edges, no mbid",
			async () => {
				installPipelineMocks({ draft: trackDraftFixture("Fitna", "Rohff") });
				const m = await mb();
				vi.mocked(m.resolveRecording).mockImplementation(async () => {
					throw new Error("MB 503");
				});
				const runPipeline = await loadRunPipeline();
				const lines: string[] = [];

				const result = await runPipeline(
					{ type: "track", name: "Fitna", artist: "Rohff", slug: "track:fitna--rohff" },
					{ ...DEPS, logger: (line) => lines.push(line) },
				);

				expect(result.slug).toBe("track:fitna--rohff");
				expect((result.node as TrackNode).mbid).toBeUndefined();
				expect((result.node as TrackNode).artists.map((a) => a.name)).toEqual(["Rohff"]);
				expect(lines.some((l) => l.includes("MB track enrich skipped"))).toBe(true);
			},
			TIMEOUT_MS,
		);

		it(
			"stores the artist's mbid and kind and attributes the discography to the artist",
			async () => {
				installPipelineMocks({ draft: artistDraftFixture({ name: "Roni Size", discography: [] }) });
				const m = await mb();
				vi.mocked(m.resolveArtistDetailed).mockImplementation(async () => ({
					artist: { mbid: RONI_MBID, name: "Roni Size", kind: "person", disambiguation: null, area: null },
					candidates: 1,
					path: "name",
					unavailable: false,
				}));
				vi.mocked(m.fetchArtistDiscographyMb).mockImplementation(async () => [
					{
						mbid: RG_MBID,
						title: "New Forms",
						firstReleaseDate: "1997-06-01",
						primaryType: "Album",
						secondaryTypes: [],
					},
				]);
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline({ type: "artist", name: "Roni Size" }, DEPS);

				const artist = result.node as ArtistNode;
				expect(artist.mbid).toBe(RONI_MBID);
				expect(artist.artist_kind).toBe("person");
				expect(artist.discography.map((e) => [e.slug, e.artist])).toEqual([
					["project:new-forms--roni-size", "Roni Size"],
				]);
				expect(result.slug).toBe("artist:roni-size");
			},
			TIMEOUT_MS,
		);

		it(
			"leaves an artist MB cannot single out without mbid, kind or MB discography",
			async () => {
				installPipelineMocks({ draft: artistDraftFixture({ name: "Homonym" }) });
				const m = await mb();
				vi.mocked(m.resolveArtistDetailed).mockImplementation(async () => ({
					artist: null,
					candidates: 3,
					path: "name",
					unavailable: false,
				}));
				const runPipeline = await loadRunPipeline();
				const lines: string[] = [];

				const result = await runPipeline(
					{ type: "artist", name: "Homonym" },
					{ ...DEPS, logger: (line) => lines.push(line) },
				);

				const artist = result.node as ArtistNode;
				expect(artist.mbid).toBeUndefined();
				expect(artist.artist_kind).toBeUndefined();
				expect(vi.mocked(m.fetchArtistDiscographyMb)).not.toHaveBeenCalled();
				expect(lines.some((l) => l.includes("left without MBID (candidates=3)"))).toBe(true);
			},
			TIMEOUT_MS,
		);

		it(
			"asks MB for the kind of an artist whose mbid the caller supplied",
			async () => {
				installPipelineMocks({ draft: artistDraftFixture({ name: "Reprazent" }) });
				const m = await mb();
				vi.mocked(m.fetchArtistEntityMb).mockImplementation(async () => ({
					mbid: RONI_MBID,
					name: "Reprazent",
					country: "GB",
					area: null,
					disambiguation: null,
					kind: "group",
				}));
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline({ type: "artist", name: "Reprazent", mbid: RONI_MBID }, DEPS);

				expect(vi.mocked(m.resolveArtistDetailed)).not.toHaveBeenCalled();
				expect((result.node as ArtistNode).mbid).toBe(RONI_MBID);
				expect((result.node as ArtistNode).artist_kind).toBe("group");
			},
			TIMEOUT_MS,
		);

		it(
			"scopes a label's release by the primary credit's cached name and slugs its roster from the cache",
			async () => {
				installPipelineMocks({
					draft: {
						name: "Milan Records",
						editorial_article:
							"A fictional label invented for the runPipeline end-to-end harness (TRA-473). No real-world facts are claimed here.",
						citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture Artist" }],
						editorial_description: "A fictional label.",
						genres: [],
						roster: [],
						notable_releases: [],
					},
				});
				const m = await mb();
				vi.mocked(m.fetchLabelMetaMb).mockImplementation(async () => ({
					roster: [{ mbid: SAKAMOTO_MBID, name: "坂本龍一" }],
					notableReleases: [
						{
							mbid: RG_MBID,
							title: "async",
							firstReleaseDate: "2017",
							credit: [{ mbid: SAKAMOTO_MBID, name: "坂本龍一" }],
						},
					],
				}));
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline(
					{ type: "label", name: "Milan Records", mbid: RONI_MBID },
					{
						...DEPS,
						artistByMbid: () => ({ slug: "artist:ryuichi-sakamoto" as Slug, name: "Ryuichi Sakamoto" }),
					},
				);

				const label = result.node as LabelNode;
				expect(label.notable_releases.map((e) => e.slug)).toEqual(["project:async--ryuichi-sakamoto"]);
				expect(label.roster.map((e) => e.slug)).toEqual(["artist:ryuichi-sakamoto"]);
			},
			TIMEOUT_MS,
		);
	});

	// Off (the default until TRA-509) the identity is still stored, but no slug moves: a merge on main must not
	// split a work between a bare and a scoped slug before the cache and /materialize are migrated.
	describe("flag off", () => {
		beforeEach(() => {
			vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
		});
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it(
			"stores the mbid and credit but keeps the slug asked for and bare tracklist slugs",
			async () => {
				installPipelineMocks({ draft: projectDraftFixture("New Forms", "Roni Size") });
				await resolvedWork("releaseGroup", "New Forms", [{ mbid: RONI_MBID, name: "Roni Size / Reprazent" }]);
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline(
					{ type: "project", name: "New Forms", artist: "Roni Size", slug: "project:new-forms" },
					DEPS,
				);

				expect(result.slug).toBe("project:new-forms");
				expect("requestedSlug" in result).toBe(false);
				const project = result.node as ProjectNode;
				expect(project.mbid).toBe(RG_MBID);
				expect(project.artists[0]?.name).toBe("Roni Size / Reprazent");
				expect(project.tracklist.map((e) => e.slug)).toEqual(["track:brown-paper-bag"]);
			},
			TIMEOUT_MS,
		);

		it(
			"keeps a work whose non-Latin credit cannot be slugged instead of aborting the enrichment",
			async () => {
				installPipelineMocks({
					draft: trackDraftFixture("Merry Christmas Mr. Lawrence", "Ryuichi Sakamoto"),
				});
				await resolvedWork("recording", "Merry Christmas Mr. Lawrence", [
					{ mbid: SAKAMOTO_MBID, name: "坂本龍一" },
				]);
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline(
					{ type: "track", name: "Merry Christmas Mr. Lawrence", slug: "track:merry-christmas-mr-lawrence" },
					DEPS,
				);

				expect(result.slug).toBe("track:merry-christmas-mr-lawrence");
				expect((result.node as TrackNode).mbid).toBe(RECORDING_MBID);
			},
			TIMEOUT_MS,
		);
	});
});

describe("recomputeCanonicalSlug (TRA-473)", () => {
	beforeEach(() => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "true");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const MBID = "11111111-2222-3333-4444-555555555555";
	async function recompute(
		node: Record<string, unknown>,
		input: PipelineInput,
		scope: string | undefined,
	): Promise<{ requested: Slug | undefined; slug: unknown; lines: string[] }> {
		const { recomputeCanonicalSlug } = await import("../src/pipeline.js");
		const lines: string[] = [];
		const requested = recomputeCanonicalSlug(node, input, scope, (l) => lines.push(l));
		return { requested, slug: node.slug, lines };
	}

	it("leaves a slug that already equals the canonical one", async () => {
		const r = await recompute(
			{ slug: "track:fitna--rohff", name: "Fitna", mbid: MBID },
			{ type: "track", name: "Fitna", slug: "track:fitna--rohff" },
			"Rohff",
		);
		expect(r).toMatchObject({ requested: undefined, slug: "track:fitna--rohff" });
	});

	it("writes under the canonical slug and returns the requested one when they differ", async () => {
		const r = await recompute(
			{ slug: "project:new-forms--roni-size", name: "New Forms", mbid: MBID },
			{ type: "project", name: "New Forms", slug: "project:new-forms--roni-size" },
			"Roni Size / Reprazent",
		);
		expect(r).toMatchObject({
			requested: "project:new-forms--roni-size",
			slug: "project:new-forms--roni-size-reprazent",
		});
	});

	it("moves a bare slug to the canonical one without reporting one nobody asked for", async () => {
		const r = await recompute(
			{ slug: "project:new-forms", name: "New Forms", mbid: MBID },
			{ type: "project", name: "New Forms" },
			"Roni Size",
		);
		expect(r).toMatchObject({ requested: undefined, slug: "project:new-forms--roni-size" });
	});

	it("never touches genres, artists or labels, whatever scope is offered", async () => {
		for (const type of ["genre", "artist", "label"] as const) {
			const r = await recompute(
				{ slug: `${type}:x`, name: "X", mbid: MBID },
				{ type, name: "X", slug: `${type}:x` as Slug },
				"Someone",
			);
			expect(r).toMatchObject({ requested: undefined, slug: `${type}:x` });
		}
	});

	it("keeps the slug of a work MB did not resolve (no mbid) or gave no scope", async () => {
		const input: PipelineInput = { type: "track", name: "Fitna", slug: "track:fitna--rohff" };
		expect((await recompute({ slug: input.slug, name: "Fitna" }, input, "Akuma")).slug).toBe(
			"track:fitna--rohff",
		);
		expect((await recompute({ slug: input.slug, name: "Fitna", mbid: MBID }, input, undefined)).slug).toBe(
			"track:fitna--rohff",
		);
	});

	it("keeps the slug and logs when the scope cannot be slugged", async () => {
		const input: PipelineInput = { type: "project", name: "async", slug: "project:async--ryuichi-sakamoto" };
		const r = await recompute({ slug: input.slug, name: "async", mbid: MBID }, input, "坂本龍一");
		expect(r.slug).toBe("project:async--ryuichi-sakamoto");
		expect(r.requested).toBeUndefined();
		expect(r.lines.join("\n")).toContain("empty-artist");
	});

	it("changes nothing with the flag off", async () => {
		vi.stubEnv("ODYSSEY_SCOPED_RELEASE_SLUGS", "false");
		const r = await recompute(
			{ slug: "project:new-forms", name: "New Forms", mbid: MBID },
			{ type: "project", name: "New Forms", slug: "project:new-forms" },
			"Roni Size",
		);
		expect(r).toMatchObject({ requested: undefined, slug: "project:new-forms" });
	});
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
