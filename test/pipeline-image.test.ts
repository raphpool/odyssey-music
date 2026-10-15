import { describe, expect, it, vi } from "vitest";
import type { PipelineDeps, PipelineInput } from "../src/pipeline.js";
import type { ProjectNode } from "../src/types.js";
import { installPipelineMocks, projectDraftFixture } from "./helpers/pipeline-mocks.js";

// TRA-479: the image is picked once, at materialization, from the node as MusicBrainz enriched it.
// The resolver is our own dependency, injected here: no provider is ever called.
//
// Kept apart from test/pipeline-e2e.test.ts (shared with the in-flight TRA-538 work); the same
// dynamic import applies, for the same reason (the pipeline-mocks vi.mock calls must register first).
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;
const RG_MBID = "bbbbbbbb-1111-4111-8111-000000000022";
const CAA_URL = `https://coverartarchive.org/release-group/${RG_MBID}/front-500`;
const INPUT: PipelineInput = { type: "project", name: "New Forms", artist: "Roni Size" };

/** MusicBrainz resolves the release group "New Forms" to RG_MBID, credited to Roni Size. */
async function resolvedProject() {
	installPipelineMocks({ draft: projectDraftFixture("New Forms", "Roni Size") });
	const m = await import("../src/musicbrainz.js");
	vi.mocked(m.resolveReleaseGroup).mockImplementation(async () => ({
		mbid: RG_MBID,
		title: "New Forms",
		credit: [{ mbid: "2eeba1d4-0000-4000-8000-000000000001", name: "Roni Size" }],
		primaryType: null,
		firstReleaseDate: null,
	}));
	vi.mocked(m.fetchEntityGenresMb).mockImplementation(async () => []);
	vi.mocked(m.fetchProjectMetaMb).mockImplementation(async () => ({
		tracks: [],
		label: null,
		artists: [],
		year: null,
		producers: [],
		personnel: [],
		primaryType: "Album",
	}));
}

describe("image at materialization (TRA-479)", () => {
	it(
		"sets image_url and image_source from the resolver, which sees the MBID MusicBrainz settled on",
		async () => {
			await resolvedProject();
			const resolveImage = vi.fn(async () => ({ url: CAA_URL, source: "caa" as const }));
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, { ...DEPS, resolveImage });

			const project = result.node as ProjectNode;
			expect(project.image_url).toBe(CAA_URL);
			expect(project.image_source).toBe("caa");
			expect(resolveImage).toHaveBeenCalledTimes(1);
			expect(resolveImage.mock.calls[0]).toEqual([
				expect.objectContaining({ type: "project", mbid: RG_MBID }),
			]);
		},
		TIMEOUT_MS,
	);

	it(
		"writes the node without an image when the resolver finds none",
		async () => {
			await resolvedProject();
			const lines: string[] = [];
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, {
				...DEPS,
				resolveImage: async () => null,
				logger: (line) => lines.push(line),
			});

			const project = result.node as ProjectNode;
			expect(project.image_url).toBeUndefined();
			expect(project.image_source).toBeUndefined();
			expect(lines.some((l) => l.includes("no image resolved"))).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"writes the node without an image, and logs, when the resolver throws",
		async () => {
			await resolvedProject();
			const lines: string[] = [];
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, {
				...DEPS,
				resolveImage: async () => {
					throw new Error("coverartarchive.org is down");
				},
				logger: (line) => lines.push(line),
			});

			expect((result.node as ProjectNode).image_url).toBeUndefined();
			expect(result.node.name).toBe("New Forms");
			expect(lines.some((l) => l.includes("image resolution skipped") && l.includes("is down"))).toBe(true);
		},
		TIMEOUT_MS,
	);

	it(
		"never writes a URL the allow-list refuses, and does not fail the node over it",
		async () => {
			for (const url of [
				"https://evil.example.com/cover.jpg",
				`https://coverartarchive.org:8443/release-group/${RG_MBID}/front-500`,
				`http://coverartarchive.org/release-group/${RG_MBID}/front-500`,
				"javascript:alert(1)",
			]) {
				await resolvedProject();
				const lines: string[] = [];
				const runPipeline = await loadRunPipeline();

				const result = await runPipeline(INPUT, {
					...DEPS,
					resolveImage: async () => ({ url, source: "caa" as const }),
					logger: (line) => lines.push(line),
				});

				expect((result.node as ProjectNode).image_url, url).toBeUndefined();
				expect(
					lines.some((l) => l.includes("image refused")),
					url,
				).toBe(true);
			}
		},
		TIMEOUT_MS,
	);

	it(
		"changes nothing when the deps carry no resolveImage",
		async () => {
			await resolvedProject();
			const lines: string[] = [];
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline(INPUT, { ...DEPS, logger: (line) => lines.push(line) });

			expect((result.node as ProjectNode).image_url).toBeUndefined();
			expect(lines.some((l) => l.includes("image"))).toBe(false);
		},
		TIMEOUT_MS,
	);
});
