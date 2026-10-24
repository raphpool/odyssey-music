import { describe, expect, it } from "vitest";
import type { PipelineDeps } from "../src/pipeline.js";
import type { ArtistNode } from "../src/types.js";
import { artistDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-557, end to end: the generation never writes two edges of one slug in a list. runPipeline is imported
// dynamically for the reason given in test/pipeline-e2e.test.ts (the mocks must be installed first).
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

const TIMEOUT_MS = 5_000;
const MBID_1 = "bbbbbbbb-1111-4111-8111-000000000001";
const MBID_2 = "bbbbbbbb-1111-4111-8111-000000000002";

describe("duplicate edges at generation (TRA-557)", () => {
	it(
		"writes one discography edge per slug, keeps the first on a tie, and logs the drop",
		async () => {
			installPipelineMocks({
				draft: artistDraftFixture({
					discography: [
						{ type: "project", name: "Fixture Album", artist: "Fixture Artist", mbid: MBID_1 },
						{ type: "project", name: "Fixture EP", artist: "Fixture Artist" },
						// Same title, another release group: one page.
						{ type: "project", name: "Fixture Album", artist: "Fixture Artist", mbid: MBID_2 },
					],
				}),
			});
			const runPipeline = await loadRunPipeline();
			const lines: string[] = [];
			const deps: PipelineDeps = {
				tavilyApiKey: "test",
				firecrawlApiKey: "test",
				logger: (line) => lines.push(line),
			};

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, deps);

			const discography = (result.node as ArtistNode).discography;
			const slugs = discography.map((e) => e.slug);
			expect(new Set(slugs).size).toBe(slugs.length);
			expect(discography).toHaveLength(2);
			expect(discography.find((e) => e.name === "Fixture Album")?.mbid).toBe(MBID_1);
			expect(lines.filter((l) => l.includes("duplicate edge dropped"))).toHaveLength(1);
			// The landmark is still a member of the deduplicated list.
			const landmark = (result.node as ArtistNode).landmark_project;
			expect(discography.some((e) => e.slug === landmark?.slug)).toBe(true);
		},
		TIMEOUT_MS,
	);
});
