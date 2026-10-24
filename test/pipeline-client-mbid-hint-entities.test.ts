import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineDeps, PipelineInput } from "../src/pipeline.js";
import { artistDraftFixture, FIXTURE_WIKI_URL, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-680: the artist and label twin of test/pipeline-client-mbid-hint.test.ts (TRA-545). researchTarget used to
// look up the MusicBrainz entity of a client's mbid hint (disambiguation, country, founding year) and append it
// to the web search query *before* the server's own name resolution had confirmed that hint. A hint that
// designates another artist or label then steered the search, and so the editorial text, toward that other
// entity under the requested slug. TRA-546 already keeps such a hint off the node; this keeps it off the query.
// Same harness as the TRA-545 file (boundaries mocked, the rest real).

// runPipeline is imported dynamically so that pipeline-mocks.ts's vi.mock() calls are registered first
// (see the note at the top of test/pipeline-e2e.test.ts).
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;

/** What MB's own name resolution lands on for the requested entity. */
const RESOLVED_MBID = "aaaaaaaa-1111-4111-8111-000000000011";
/** A client hint designating another entity entirely. */
const HINT_MBID = "bbbbbbbb-1111-4111-8111-0000000000ff";

type Kind = "artist" | "label";

interface EntityFixture {
	mbid: string;
	name: string;
	country: string | null;
	founded: string | null;
	disambiguation: string | null;
}

const HINT_ENTITY: EntityFixture = {
	mbid: HINT_MBID,
	name: "Nobody",
	country: "ES",
	founded: "1972-05-01",
	disambiguation: "spanish makina outfit",
};
const OWN_ENTITY: EntityFixture = {
	mbid: RESOLVED_MBID,
	name: "Nobody",
	country: "FR",
	founded: "2004-01-01",
	disambiguation: null,
};

const LABEL_DRAFT = {
	name: "Nobody",
	editorial_article: "A fictional label invented for the mbid hint tests (TRA-680). ".repeat(2),
	citations: [{ url: FIXTURE_WIKI_URL, title: "Fixture Artist" }],
	editorial_description: "A fictional label.",
	genres: [],
	roster: [],
	notable_releases: [],
};

const KINDS: readonly {
	kind: Kind;
	draft: () => Record<string, unknown>;
	/** Strings that only the hint's entity carries: none may reach the search query when unconfirmed. */
	hintOnly: readonly string[];
	/** What the query holds once the hint is trusted. */
	hintQuery: string;
}[] = [
	{
		kind: "artist",
		draft: () => artistDraftFixture({ name: "Nobody" }),
		hintOnly: ["spanish makina outfit", "ES"],
		hintQuery: "Nobody artist music wiki discogs spanish makina outfit ES",
	},
	{
		kind: "label",
		draft: () => ({ ...LABEL_DRAFT }),
		hintOnly: ["spanish makina outfit", "ES", "1972"],
		hintQuery: "Nobody label music wiki discogs ES 1972 spanish makina outfit",
	},
];

async function mb() {
	return await import("../src/musicbrainz.js");
}

/**
 * Arms MusicBrainz for one entity: `resolved` is what the name resolution answers (null: no single match) and
 * `entityName` the name MB's own record for it carries. The entity endpoint answers per mbid, so the hint's
 * record and the resolved one never get mixed up.
 */
async function armMusicBrainz(kind: Kind, resolved: string | null, entityName = "Nobody") {
	const m = await mb();
	const entity = (mbid: string): EntityFixture => ({
		...(mbid.toLowerCase() === HINT_MBID ? HINT_ENTITY : OWN_ENTITY),
		mbid,
		name: entityName,
	});
	if (kind === "artist") {
		vi.mocked(m.resolveArtistDetailed).mockImplementation(async (name) => ({
			artist: resolved ? { mbid: resolved, name, kind: "person", disambiguation: null, area: null } : null,
			candidates: resolved ? 1 : 3,
			path: "name",
			unavailable: false,
			matchedWords: [],
		}));
		vi.mocked(m.fetchArtistEntityMb).mockImplementation(async (mbid) => ({ ...entity(mbid), area: null }));
	} else {
		vi.mocked(m.findLabelMbidByName).mockImplementation(async () => resolved);
		vi.mocked(m.fetchLabelEntityMb).mockImplementation(async (mbid) => entity(mbid));
		vi.mocked(m.fetchLabelMetaMb).mockImplementation(async () => ({ roster: [], notableReleases: [] }));
	}
	return m;
}

async function searchQuery(): Promise<string> {
	const { tavilySearch } = await import("../src/tools/tavily.js");
	expect(tavilySearch).toHaveBeenCalledTimes(1);
	return String(vi.mocked(tavilySearch).mock.calls[0]?.[1]);
}

describe.each(KINDS)("search query and a client's $kind mbid hint (TRA-680)", (spec) => {
	const input = (extra: Partial<PipelineInput>): PipelineInput => ({
		type: spec.kind,
		name: "Nobody",
		...extra,
	});
	const resolution = (m: Awaited<ReturnType<typeof mb>>) =>
		spec.kind === "artist" ? m.resolveArtistDetailed : m.findLabelMbidByName;
	const entityFetch = (m: Awaited<ReturnType<typeof mb>>) =>
		spec.kind === "artist" ? m.fetchArtistEntityMb : m.fetchLabelEntityMb;

	beforeEach(() => {
		installPipelineMocks({ draft: spec.draft() });
	});

	it(
		"leaves the hint's entity out of the query when MB resolves the name to another mbid",
		async () => {
			const m = await armMusicBrainz(spec.kind, RESOLVED_MBID);
			const runPipeline = await loadRunPipeline();

			await runPipeline(input({ mbid: HINT_MBID, mbidIsClientHint: true }), DEPS);

			const query = await searchQuery();
			for (const token of spec.hintOnly) expect(query).not.toContain(token);
			// The request itself still drives the search.
			expect(query).toBe(`Nobody ${spec.kind} music wiki discogs`);
			// Nothing about the hint's entity is looked up at all, neither for the query nor for the node.
			expect(vi.mocked(entityFetch(m))).not.toHaveBeenCalledWith(HINT_MBID);
		},
		TIMEOUT_MS,
	);

	it(
		"leaves the hint's entity out of the query when MB resolves nothing for the name",
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
			(vi.mocked(resolution(m)) as ReturnType<typeof vi.fn>).mockImplementation(async () => {
				throw new Error("MB 503");
			});
			const runPipeline = await loadRunPipeline();

			await runPipeline(input({ mbid: HINT_MBID, mbidIsClientHint: true }), DEPS);

			const query = await searchQuery();
			for (const token of spec.hintOnly) expect(query).not.toContain(token);
		},
		TIMEOUT_MS,
	);

	it(
		"keeps pinning the query on the hint's entity once MB resolves the name to that very mbid",
		async () => {
			await armMusicBrainz(spec.kind, HINT_MBID);
			const runPipeline = await loadRunPipeline();

			// Case-insensitive, like the confirmation that decides whether the node gets the mbid.
			await runPipeline(input({ mbid: HINT_MBID.toUpperCase(), mbidIsClientHint: true }), DEPS);

			expect(await searchQuery()).toBe(spec.hintQuery);
		},
		TIMEOUT_MS,
	);

	it(
		"keeps pinning the query on the mbid of a trusted caller, without asking MB to confirm it first",
		async () => {
			const m = await armMusicBrainz(spec.kind, RESOLVED_MBID);
			const runPipeline = await loadRunPipeline();

			await runPipeline(input({ mbid: HINT_MBID }), DEPS);

			expect(await searchQuery()).toBe(spec.hintQuery);
			expect(vi.mocked(resolution(m))).not.toHaveBeenCalled();
		},
		TIMEOUT_MS,
	);

	it(
		"pins nothing when the request carries no mbid, as before",
		async () => {
			const m = await armMusicBrainz(spec.kind, RESOLVED_MBID);
			const runPipeline = await loadRunPipeline();

			await runPipeline(input({}), DEPS);

			expect(await searchQuery()).toBe(`Nobody ${spec.kind} music wiki discogs`);
			expect(vi.mocked(entityFetch(m))).not.toHaveBeenCalledWith(HINT_MBID);
		},
		TIMEOUT_MS,
	);
});

describe("search query and a client's label mbid hint, name check (TRA-680)", () => {
	beforeEach(() => {
		installPipelineMocks({ draft: { ...LABEL_DRAFT } });
	});

	it(
		"leaves the hint's entity out of the query when the label it lands on is named otherwise",
		async () => {
			// MB's name search ranks the hint's label first, but its own record is "Nobody Fake Imprint": the
			// same check that refuses the node its mbid (TRA-546) refuses the query its metadata.
			await armMusicBrainz("label", HINT_MBID, "Nobody Fake Imprint");
			const runPipeline = await loadRunPipeline();

			await runPipeline({ type: "label", name: "Nobody", mbid: HINT_MBID, mbidIsClientHint: true }, DEPS);

			const query = await searchQuery();
			for (const token of ["spanish makina outfit", "ES", "1972"]) expect(query).not.toContain(token);
		},
		TIMEOUT_MS,
	);
});
