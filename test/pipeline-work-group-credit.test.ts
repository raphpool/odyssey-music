import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MbCredit, MbWorkResolution } from "../src/musicbrainz.js";
import type { PipelineDeps, PipelineInput } from "../src/pipeline.js";
import { installPipelineMocks, projectDraftFixture, trackDraftFixture } from "./helpers/pipeline-mocks.js";

// TRA-551: a work credited to a band the requested artist belongs to ("New Forms", credited "Roni Size /
// Reprazent", asked from Roni Size's page) is accepted by MBID at JIT. The pipeline reads the artist's
// memberships on demand, and only when MusicBrainz set an exact-title candidate aside for its credit AND the
// artist's mbid is known; the resolvers then accept the bands by MBID. Boundaries mocked as in
// test/pipeline-client-mbid-hint.test.ts; the picking rules themselves are covered in test/musicbrainz.test.ts.

// runPipeline is imported dynamically so that pipeline-mocks.ts's vi.mock() calls are registered first
// (see the note at the top of test/pipeline-e2e.test.ts).
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

async function mb() {
	return await import("../src/musicbrainz.js");
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;

const RONI_SIZE = "dddddddd-5555-4555-8555-000000000001";
const REPRAZENT: MbCredit = { mbid: "dddddddd-5555-4555-8555-000000000002", name: "Roni Size / Reprazent" };
/** Another band that carries the same name: MB files homonyms under their own mbid. */
const HOMONYM_BAND: MbCredit = {
	mbid: "dddddddd-5555-4555-8555-000000000003",
	name: "Roni Size / Reprazent",
};
const NEW_FORMS_MBID = "70fe8c14-6a76-33d5-a4f4-e2cb5556611f";

const NONE: MbWorkResolution = { identity: null, ambiguous: false, unavailable: false };
const NEW_FORMS: MbWorkResolution = {
	ambiguous: false,
	unavailable: false,
	identity: {
		mbid: NEW_FORMS_MBID,
		title: "New Forms",
		credit: [REPRAZENT],
		primaryType: null,
		firstReleaseDate: "1997-06-23",
		releaseGroupMbid: null,
	},
};

const TRACK_META = {
	project: null,
	label: null,
	artists: [REPRAZENT],
	year: "1997",
	duration: null,
	producers: [],
	personnel: [],
};
const PROJECT_META = {
	tracks: [],
	label: null,
	artists: [REPRAZENT],
	year: "1997",
	producers: [],
	personnel: [],
	primaryType: "Album",
};

type Kind = "track" | "project";

const KINDS: readonly { kind: Kind; draft: () => Record<string, unknown> }[] = [
	{ kind: "track", draft: () => trackDraftFixture("New Forms", "Roni Size") },
	{ kind: "project", draft: () => projectDraftFixture("New Forms", "Roni Size") },
];

/**
 * Arms the work resolvers like MusicBrainz answers: a first search answers `first` (an exact-title candidate set
 * aside for its credit shows in `discardedCredits`), the same search with the right band accepted by MBID returns
 * the work. `groups` is what the artist's profile lists (null: MB did not answer).
 */
async function arm(kind: Kind, first: MbWorkResolution, groups: MbCredit[] | null) {
	const m = await mb();
	const detailed = vi.mocked(kind === "track" ? m.resolveRecordingDetailed : m.resolveReleaseGroupDetailed);
	detailed.mockImplementation(async (_title, _artist, options) =>
		(options?.acceptCreditMbids ?? []).includes(REPRAZENT.mbid) ? NEW_FORMS : first,
	);
	const plain = vi.mocked(kind === "track" ? m.resolveRecording : m.resolveReleaseGroup);
	plain.mockImplementation(async () => null);
	vi.mocked(m.fetchArtistProfileMb).mockImplementation(async () =>
		groups === null
			? null
			: { mbid: RONI_SIZE, name: "Roni Size", kind: "person", disambiguation: null, area: null, groups },
	);
	vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);
	vi.mocked(m.fetchTrackMetaMb).mockImplementation(async () => TRACK_META);
	vi.mocked(m.fetchProjectMetaMb).mockImplementation(async () => PROJECT_META);
	return { m, detailed, plain };
}

describe.each(KINDS)("$kind credited to a band of the requested artist (TRA-551)", ({ kind, draft }) => {
	const input = (extra: Partial<PipelineInput> = {}): PipelineInput => ({
		type: kind,
		name: "New Forms",
		artist: "Roni Size",
		artistMbid: RONI_SIZE,
		...extra,
	});
	const SET_ASIDE: MbWorkResolution = { ...NONE, discardedCredits: [REPRAZENT] };

	beforeEach(() => {
		installPipelineMocks({ draft: draft() });
	});

	it(
		"accepts the work by the mbid of a band the artist is a member of",
		async () => {
			const { m, detailed } = await arm(kind, SET_ASIDE, [REPRAZENT]);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(input(), DEPS);

			expect((result.node as { mbid?: string }).mbid).toBe(NEW_FORMS_MBID);
			expect(m.fetchArtistProfileMb).toHaveBeenCalledTimes(1);
			expect(m.fetchArtistProfileMb).toHaveBeenCalledWith(RONI_SIZE);
			// The same search, asked again with the band accepted: MBIDs only, never a name.
			expect(detailed).toHaveBeenCalledTimes(2);
			expect(detailed.mock.calls[0]?.[2]).toBeUndefined();
			expect(detailed.mock.calls[1]?.[2]).toEqual({ acceptCreditMbids: [REPRAZENT.mbid] });
		},
		TIMEOUT_MS,
	);

	it(
		"still refuses a homonym of the band: same name, other mbid",
		async () => {
			const { m, detailed } = await arm(kind, { ...NONE, discardedCredits: [HOMONYM_BAND] }, [REPRAZENT]);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(input(), DEPS);

			expect((result.node as { mbid?: string }).mbid).toBeUndefined();
			expect(m.fetchArtistProfileMb).toHaveBeenCalledTimes(1);
			// None of the artist's bands is among the credits set aside: nothing to accept, no second search.
			expect(detailed).toHaveBeenCalledTimes(1);
		},
		TIMEOUT_MS,
	);

	it(
		"leaves the work without mbid when the artist has no known membership (TRA-537 behaviour)",
		async () => {
			const { detailed } = await arm(kind, SET_ASIDE, []);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(input(), DEPS);

			expect((result.node as { mbid?: string }).mbid).toBeUndefined();
			expect(detailed).toHaveBeenCalledTimes(1);
		},
		TIMEOUT_MS,
	);

	it(
		"fails closed when MusicBrainz does not answer the memberships",
		async () => {
			const { m, detailed } = await arm(kind, SET_ASIDE, null);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(input(), DEPS);

			expect((result.node as { mbid?: string }).mbid).toBeUndefined();
			expect(m.fetchArtistProfileMb).toHaveBeenCalledTimes(1);
			expect(detailed).toHaveBeenCalledTimes(1);
		},
		TIMEOUT_MS,
	);

	it(
		"fails closed when the second search is unavailable",
		async () => {
			const { m, detailed } = await arm(kind, SET_ASIDE, [REPRAZENT]);
			detailed.mockImplementation(async (_title, _artist, options) =>
				options?.acceptCreditMbids ? { ...NONE, unavailable: true } : SET_ASIDE,
			);
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(input(), DEPS);

			expect((result.node as { mbid?: string }).mbid).toBeUndefined();
			expect(m.fetchArtistProfileMb).toHaveBeenCalledTimes(1);
		},
		TIMEOUT_MS,
	);

	describe("the extra memberships request is made only in the announced case", () => {
		const CASES: readonly { name: string; first: MbWorkResolution }[] = [
			{ name: "no exact-title candidate was set aside", first: NONE },
			{ name: "the first search found the work", first: NEW_FORMS },
			{ name: "the first search is ambiguous", first: { ...NONE, ambiguous: true } },
			{ name: "MusicBrainz was unavailable", first: { ...NONE, unavailable: true } },
		];

		it.each(CASES)(
			"not when $name",
			async ({ first }) => {
				const { m, detailed } = await arm(kind, first, [REPRAZENT]);
				const runPipeline = await loadRunPipeline();

				await runPipeline(input(), DEPS);

				expect(m.fetchArtistProfileMb).not.toHaveBeenCalled();
				// One search, as for any work: the second pass does not exist outside the announced case.
				expect(detailed).toHaveBeenCalledTimes(1);
			},
			TIMEOUT_MS,
		);

		it(
			"not when the artist's mbid is unknown: the plain resolver runs, exactly as before",
			async () => {
				const { m, detailed, plain } = await arm(kind, SET_ASIDE, [REPRAZENT]);
				const runPipeline = await loadRunPipeline();

				const { artistMbid: _unknown, ...withoutMbid } = input();
				await runPipeline(withoutMbid, DEPS);

				expect(m.fetchArtistProfileMb).not.toHaveBeenCalled();
				expect(detailed).not.toHaveBeenCalled();
				expect(plain).toHaveBeenCalledTimes(1);
			},
			TIMEOUT_MS,
		);

		it(
			"once, when an exact-title candidate was set aside for its credit and the artist's mbid is known",
			async () => {
				const { m } = await arm(kind, SET_ASIDE, [REPRAZENT]);
				const runPipeline = await loadRunPipeline();

				await runPipeline(input(), DEPS);

				expect(m.fetchArtistProfileMb).toHaveBeenCalledTimes(1);
			},
			TIMEOUT_MS,
		);
	});
});
