import { describe, expect, it } from "vitest";
import type { PipelineDeps } from "../src/pipeline.js";
import type { ArtistNode, GenreNode } from "../src/types.js";
import { artistDraftFixture, genreDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

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
