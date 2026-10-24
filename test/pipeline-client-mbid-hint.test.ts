import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MbCredit } from "../src/musicbrainz.js";
import type { PipelineDeps, PipelineInput } from "../src/pipeline.js";
import { installPipelineMocks, projectDraftFixture, trackDraftFixture } from "./helpers/pipeline-mocks.js";

// TRA-545: researchTarget used to look up the metadata of a client's mbid hint (artists, album, year) and
// append it to the web search query *before* the server's own resolution had confirmed that hint. A hint that
// designates another work then steered the search, and so the editorial text, toward that other work under
// the requested slug. The harness is the one of test/pipeline-e2e.test.ts (boundaries mocked, the rest real),
// kept in its own file so this ticket does not collide with the other suites that edit that one.

// runPipeline is imported dynamically so that pipeline-mocks.ts's vi.mock() calls are registered first
// (see the note at the top of test/pipeline-e2e.test.ts).
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;

const ROHFF: MbCredit = { mbid: "cccccccc-1111-4111-8111-000000000033", name: "Rohff" };
/** What MB's own resolution (title + credit) lands on for the requested work. */
const RESOLVED_MBID = "aaaaaaaa-1111-4111-8111-000000000011";
/** A client hint designating another work entirely: a Garbage recording / release group. */
const HINT_MBID = "bbbbbbbb-1111-4111-8111-0000000000ff";

const HINT_TRACK_META = {
	project: { mbid: "dddddddd-1111-4111-8111-000000000044", name: "Version 2.0" },
	label: null,
	artists: [{ mbid: "eeeeeeee-1111-4111-8111-000000000055", name: "Garbage" }],
	year: "1998",
	duration: null,
	producers: [],
	personnel: [],
};
const OWN_TRACK_META = {
	project: null,
	label: null,
	artists: [ROHFF],
	year: "2004",
	duration: null,
	producers: [],
	personnel: [],
};
const HINT_PROJECT_META = {
	tracks: [],
	label: null,
	artists: [{ mbid: "eeeeeeee-1111-4111-8111-000000000055", name: "Garbage" }],
	year: "1998",
	producers: [],
	personnel: [],
	primaryType: "Album",
};
const OWN_PROJECT_META = { ...HINT_PROJECT_META, artists: [ROHFF], year: "2004" };

type Kind = "track" | "project";

const KINDS: readonly {
	kind: Kind;
	name: string;
	draft: () => Record<string, unknown>;
	/** Strings that only the hint's entity carries: none may reach the search query when unconfirmed. */
	hintOnly: readonly string[];
	/** Strings that the hint's entity carries and that the query holds once the hint is trusted. */
	hintQuery: string;
}[] = [
	{
		kind: "track",
		name: "Le Bitume",
		draft: () => trackDraftFixture("Le Bitume", "Rohff"),
		hintOnly: ["Garbage", "Version 2.0"],
		hintQuery: "Garbage Version 2.0",
	},
	{
		kind: "project",
		name: "Le Bitume",
		draft: () => projectDraftFixture("Le Bitume", "Rohff"),
		hintOnly: ["Garbage", "1998"],
		hintQuery: "Garbage 1998",
	},
];

async function mb() {
	return await import("../src/musicbrainz.js");
}

/**
 * Arms MusicBrainz for one work: `resolved` is what the title + credit resolution answers (null: no single exact
 * match), and the metadata endpoint answers per mbid, so a hint and the resolved entity never get mixed up.
 */
async function armMusicBrainz(kind: Kind, resolved: string | null) {
	const m = await mb();
	const identity = resolved
		? {
				mbid: resolved,
				title: "Le Bitume",
				credit: [ROHFF],
				primaryType: null,
				firstReleaseDate: null,
				releaseGroupMbid: null,
			}
		: null;
	vi.mocked(kind === "track" ? m.resolveRecording : m.resolveReleaseGroup).mockImplementation(
		async () => identity,
	);
	vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);
	vi.mocked(m.fetchTrackMetaMb).mockImplementation(async (mbid) =>
		mbid.toLowerCase() === HINT_MBID ? HINT_TRACK_META : OWN_TRACK_META,
	);
	vi.mocked(m.fetchProjectMetaMb).mockImplementation(async (mbid) =>
		mbid.toLowerCase() === HINT_MBID ? HINT_PROJECT_META : OWN_PROJECT_META,
	);
	return m;
}

async function searchQuery(): Promise<string> {
	const { tavilySearch } = await import("../src/tools/tavily.js");
	expect(tavilySearch).toHaveBeenCalledTimes(1);
	return String(vi.mocked(tavilySearch).mock.calls[0]?.[1]);
}

describe.each(KINDS)("search query and a client's $kind mbid hint (TRA-545)", (spec) => {
	const input = (extra: Partial<PipelineInput>): PipelineInput => ({
		type: spec.kind,
		name: spec.name,
		artist: "Rohff",
		...extra,
	});

	beforeEach(() => {
		installPipelineMocks({ draft: spec.draft() });
	});

	it(
		"leaves the hint's entity out of the query when MB resolves the work to another mbid",
		async () => {
			const m = await armMusicBrainz(spec.kind, RESOLVED_MBID);
			const runPipeline = await loadRunPipeline();

			await runPipeline(input({ mbid: HINT_MBID, mbidIsClientHint: true }), DEPS);

			const query = await searchQuery();
			for (const token of spec.hintOnly) expect(query).not.toContain(token);
			// The request itself still drives the search.
			expect(query).toContain("Le Bitume Rohff");
			// Nothing about the hint's entity is looked up at all, neither for the query nor for the node.
			const metaFetch = spec.kind === "track" ? m.fetchTrackMetaMb : m.fetchProjectMetaMb;
			expect(vi.mocked(metaFetch)).not.toHaveBeenCalledWith(HINT_MBID);
		},
		TIMEOUT_MS,
	);

	it(
		"leaves the hint's entity out of the query when MB resolves nothing for the work",
		async () => {
			await armMusicBrainz(spec.kind, null);
			const runPipeline = await loadRunPipeline();

			await runPipeline(input({ mbid: HINT_MBID, mbidIsClientHint: true }), DEPS);

			const query = await searchQuery();
			for (const token of spec.hintOnly) expect(query).not.toContain(token);
		},
		TIMEOUT_MS,
	);

	it(
		"still searches, without the hint, when MB is unavailable for the resolution",
		async () => {
			const m = await armMusicBrainz(spec.kind, RESOLVED_MBID);
			vi.mocked(spec.kind === "track" ? m.resolveRecording : m.resolveReleaseGroup).mockImplementation(
				async () => {
					throw new Error("MB 503");
				},
			);
			const runPipeline = await loadRunPipeline();

			await runPipeline(input({ mbid: HINT_MBID, mbidIsClientHint: true }), DEPS);

			const query = await searchQuery();
			for (const token of spec.hintOnly) expect(query).not.toContain(token);
		},
		TIMEOUT_MS,
	);

	it(
		"keeps pinning the query on the hint's entity once MB resolves the work to that very mbid",
		async () => {
			await armMusicBrainz(spec.kind, HINT_MBID);
			const runPipeline = await loadRunPipeline();

			// Case-insensitive, like the confirmation that decides whether the node gets the mbid.
			await runPipeline(input({ mbid: HINT_MBID.toUpperCase(), mbidIsClientHint: true }), DEPS);

			expect(await searchQuery()).toContain(spec.hintQuery);
		},
		TIMEOUT_MS,
	);

	it(
		"keeps pinning the query on the mbid of a trusted caller, without asking MB to confirm it first",
		async () => {
			const m = await armMusicBrainz(spec.kind, RESOLVED_MBID);
			const runPipeline = await loadRunPipeline();

			await runPipeline(input({ mbid: HINT_MBID }), DEPS);

			expect(await searchQuery()).toContain(spec.hintQuery);
			expect(
				vi.mocked(spec.kind === "track" ? m.resolveRecording : m.resolveReleaseGroup),
			).not.toHaveBeenCalled();
		},
		TIMEOUT_MS,
	);

	it(
		"pins nothing when the request carries no mbid, as before",
		async () => {
			const m = await armMusicBrainz(spec.kind, RESOLVED_MBID);
			const runPipeline = await loadRunPipeline();

			await runPipeline(input({}), DEPS);

			expect(await searchQuery()).toBe(
				`Le Bitume Rohff ${spec.kind === "track" ? "track" : "album"} music wiki discogs`,
			);
			expect(
				vi.mocked(spec.kind === "track" ? m.fetchTrackMetaMb : m.fetchProjectMetaMb),
			).not.toHaveBeenCalledWith(HINT_MBID);
		},
		TIMEOUT_MS,
	);
});
