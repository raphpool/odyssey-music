import { describe, expect, it, vi } from "vitest";
import type { PipelineDeps } from "../src/pipeline.js";
import type { ProjectNode } from "../src/types.js";
import {
	artistDraftFixture,
	EMPTY_PROJECT_META,
	installPipelineMocks,
	projectDraftFixture,
	trackDraftFixture,
} from "./helpers/pipeline-mocks.js";

// TRA-485: a project or track needs a credited artist when it is first created. The schema itself still
// accepts `artists: []` (legacy works are on disk without a credit, and a migration or an inverse
// emission must be able to rewrite one), so the constraint lives in runPipeline, where a node is born.
//
// pipeline.js is imported dynamically for the reason given in test/pipeline-e2e.test.ts: its module graph
// must load after the vi.mock() calls of ./helpers/pipeline-mocks.js.
async function loadPipeline() {
	return await import("../src/pipeline.js");
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;
const RG_MBID = "bbbbbbbb-1111-4111-8111-000000000022";
const RONI_MBID = "2eeba1d4-0000-4000-8000-000000000001";

/** MusicBrainz finds nothing for the work: no mbid, no credit. */
async function mbFindsNothing() {
	const m = await import("../src/musicbrainz.js");
	vi.mocked(m.resolveReleaseGroup).mockImplementation(async () => null);
	vi.mocked(m.resolveRecording).mockImplementation(async () => null);
	vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);
}

describe("a new project or track needs a credited artist (TRA-485)", () => {
	it(
		"refuses a project nobody credits, with a typed 502 error that names the work",
		async () => {
			installPipelineMocks({ draft: projectDraftFixture("Orphan Album", "x", { artists: [] }) });
			await mbFindsNothing();
			const { runPipeline, UncreditedWorkError } = await loadPipeline();

			const failure = await runPipeline({ type: "project", name: "Orphan Album" }, DEPS).catch((e) => e);

			expect(failure).toBeInstanceOf(UncreditedWorkError);
			expect(failure).toMatchObject({ status: 502, slug: "project:orphan-album", workType: "project" });
			expect(failure.message).toContain("project:orphan-album");
		},
		TIMEOUT_MS,
	);

	it(
		"refuses a track nobody credits",
		async () => {
			installPipelineMocks({ draft: trackDraftFixture("Orphan Song", "x", { artists: [] }) });
			await mbFindsNothing();
			const { runPipeline, UncreditedWorkError } = await loadPipeline();

			await expect(runPipeline({ type: "track", name: "Orphan Song" }, DEPS)).rejects.toBeInstanceOf(
				UncreditedWorkError,
			);
		},
		TIMEOUT_MS,
	);

	it(
		"stops before the image step, which costs third-party requests",
		async () => {
			installPipelineMocks({ draft: projectDraftFixture("Orphan Album", "x", { artists: [] }) });
			await mbFindsNothing();
			const { runPipeline } = await loadPipeline();
			const resolveImage = vi.fn(async () => null);

			await expect(
				runPipeline({ type: "project", name: "Orphan Album" }, { ...DEPS, resolveImage }),
			).rejects.toThrow("no credited artist");

			expect(resolveImage).not.toHaveBeenCalled();
		},
		TIMEOUT_MS,
	);

	it(
		"accepts a project the draft credits",
		async () => {
			installPipelineMocks({ draft: projectDraftFixture("New Forms", "Roni Size") });
			await mbFindsNothing();
			const { runPipeline } = await loadPipeline();

			const result = await runPipeline({ type: "project", name: "New Forms" }, DEPS);

			expect((result.node as ProjectNode).artists.map((a) => a.name)).toEqual(["Roni Size"]);
		},
		TIMEOUT_MS,
	);

	it(
		"accepts a project only MusicBrainz credits",
		async () => {
			installPipelineMocks({ draft: projectDraftFixture("New Forms", "x", { artists: [] }) });
			const m = await import("../src/musicbrainz.js");
			vi.mocked(m.resolveReleaseGroup).mockImplementation(async () => ({
				mbid: RG_MBID,
				title: "New Forms",
				credit: [{ mbid: RONI_MBID, name: "Roni Size" }],
				primaryType: null,
				firstReleaseDate: null,
				releaseGroupMbid: null,
			}));
			vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);
			vi.mocked(m.fetchProjectMetaMb).mockImplementation(async () => ({
				...EMPTY_PROJECT_META,
				tracks: [],
				artists: [],
				producers: [],
				personnel: [],
			}));
			const { runPipeline } = await loadPipeline();

			const result = await runPipeline({ type: "project", name: "New Forms" }, DEPS);

			expect((result.node as ProjectNode).artists.map((a) => a.name)).toEqual(["Roni Size"]);
		},
		TIMEOUT_MS,
	);

	it(
		"still lets a refresh rewrite a legacy work that has no credit, on the very slug it was asked about",
		async () => {
			installPipelineMocks({ draft: projectDraftFixture("Legacy Album", "x", { artists: [] }) });
			await mbFindsNothing();
			const { runPipeline } = await loadPipeline();

			const result = await runPipeline(
				{
					type: "project",
					name: "Legacy Album",
					slug: "project:legacy-album",
					refreshedSlug: "project:legacy-album",
				},
				DEPS,
			);

			expect(result.slug).toBe("project:legacy-album");
			expect((result.node as ProjectNode).artists).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"does not let a refresh excuse a node that lands on another slug",
		async () => {
			installPipelineMocks({ draft: projectDraftFixture("Legacy Album", "x", { artists: [] }) });
			await mbFindsNothing();
			const { runPipeline } = await loadPipeline();

			await expect(
				runPipeline(
					{
						type: "project",
						name: "Legacy Album",
						slug: "project:somewhere-else",
						refreshedSlug: "project:legacy-album",
					},
					DEPS,
				),
			).rejects.toThrow("no credited artist");
		},
		TIMEOUT_MS,
	);

	it(
		"does not apply to a node type that has no artists field",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const { runPipeline } = await loadPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect(result.node.type).toBe("artist");
		},
		TIMEOUT_MS,
	);
});
