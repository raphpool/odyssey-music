import { describe, expect, it } from "vitest";
import type { PipelineDeps } from "../src/pipeline.js";
import { artistDraftFixture, installPipelineMocks } from "./helpers/pipeline-mocks.js";

// TRA-242: runPipeline's research step picks its search boundary from
// `deps.searchProvider` ("tavily" | "firecrawl", default "tavily"). Both boundaries are
// mocked (see test/helpers/pipeline-mocks.ts); these tests assert which one is actually
// called, not just that the pipeline completes.
//
// runPipeline is imported dynamically — same rationale as test/pipeline-e2e.test.ts:
// a static `import { runPipeline } from "../src/pipeline.js"` would get sorted by Biome
// ahead of the "./helpers/..." import that registers the vi.mock() calls, loading the
// real tavily.js/firecrawl-search.js before the mocks are in place.
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

async function loadSearchMocks() {
	const [{ tavilySearch }, { firecrawlSearch }] = await Promise.all([
		import("../src/tools/tavily.js"),
		import("../src/tools/firecrawl-search.js"),
	]);
	return { tavilySearch, firecrawlSearch };
}

const TIMEOUT_MS = 5_000;

describe("runPipeline search provider selection (TRA-242)", () => {
	it(
		'searchProvider: "firecrawl" calls firecrawlSearch, never tavilySearch',
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const { tavilySearch, firecrawlSearch } = await loadSearchMocks();
			const deps: PipelineDeps = {
				tavilyApiKey: "test",
				firecrawlApiKey: "test",
				searchProvider: "firecrawl",
			};

			await runPipeline({ type: "artist", name: "Fixture Artist" }, deps);

			expect(firecrawlSearch).toHaveBeenCalledTimes(1);
			expect(tavilySearch).not.toHaveBeenCalled();
		},
		TIMEOUT_MS,
	);

	it(
		"defaults to tavilySearch when searchProvider is omitted, never calling firecrawlSearch",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const { tavilySearch, firecrawlSearch } = await loadSearchMocks();
			const deps: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };

			await runPipeline({ type: "artist", name: "Fixture Artist" }, deps);

			expect(tavilySearch).toHaveBeenCalledTimes(1);
			expect(firecrawlSearch).not.toHaveBeenCalled();
		},
		TIMEOUT_MS,
	);

	it(
		'searchProvider: "tavily" explicitly still calls tavilySearch, never firecrawlSearch',
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();
			const { tavilySearch, firecrawlSearch } = await loadSearchMocks();
			const deps: PipelineDeps = {
				tavilyApiKey: "test",
				firecrawlApiKey: "test",
				searchProvider: "tavily",
			};

			await runPipeline({ type: "artist", name: "Fixture Artist" }, deps);

			expect(tavilySearch).toHaveBeenCalledTimes(1);
			expect(firecrawlSearch).not.toHaveBeenCalled();
		},
		TIMEOUT_MS,
	);
});
