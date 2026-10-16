import { describe, expect, it } from "vitest";
import { buildCrawlDeps, resolveSearchProvider } from "../src/cli.js";
import type { ApiEnv } from "../src/env.js";

// TRA-242: --search-provider is validated before loadEnv()/any network call. Only "tavily"
// and "firecrawl" are accepted; anything else is refused with a clear message.
describe("resolveSearchProvider", () => {
	it('accepts "tavily"', () => {
		expect(resolveSearchProvider("tavily")).toBe("tavily");
	});

	it('accepts "firecrawl"', () => {
		expect(resolveSearchProvider("firecrawl")).toBe("firecrawl");
	});

	it("rejects an unknown provider with a clear message", () => {
		expect(() => resolveSearchProvider("bing")).toThrow(/--search-provider/);
		expect(() => resolveSearchProvider("bing")).toThrow(/bing/);
	});

	it("rejects an empty string", () => {
		expect(() => resolveSearchProvider("")).toThrow(/--search-provider/);
	});
});

// TRA-242 review: the CLI action inlined the `deps` object literal it hands to
// crawl/crawlGenreSeeds/refreshGenre, so nothing asserted on it directly — dropping the
// `searchProvider` field from that literal left all 464 tests green. buildCrawlDeps is the
// action's own wiring, extracted so this exact regression has a test.
describe("buildCrawlDeps", () => {
	const env: ApiEnv = {
		GEMINI_API_KEY: "gemini-key",
		TAVILY_API_KEY: "tavily-key",
		FIRECRAWL_API_KEY: "firecrawl-key",
	};

	it('carries searchProvider "firecrawl" through into deps', () => {
		const deps = buildCrawlDeps("firecrawl", env);

		expect(deps.searchProvider).toBe("firecrawl");
		expect(deps.tavilyApiKey).toBe("tavily-key");
		expect(deps.firecrawlApiKey).toBe("firecrawl-key");
	});

	it('carries searchProvider "tavily" through into deps', () => {
		const deps = buildCrawlDeps("tavily", env);

		expect(deps.searchProvider).toBe("tavily");
	});

	// TRA-479: a crawl that writes into a cache directory gives its nodes an image; without one
	// (backfill and the like) the pipeline has no image step, as before.
	it("wires an image resolver only when the crawl has a cache directory", () => {
		expect(buildCrawlDeps("tavily", env, "/tmp/odyssey-cache").resolveImage).toBeTypeOf("function");
		expect(buildCrawlDeps("tavily", env).resolveImage).toBeUndefined();
	});

	// TRA-480: same condition for similar artists (the graph fallback reads the cache being written).
	it("wires a similar-artists resolver only when the crawl has a cache directory", () => {
		expect(buildCrawlDeps("tavily", env, "/tmp/odyssey-cache").similarArtists).toBeTypeOf("function");
		expect(buildCrawlDeps("tavily", env).similarArtists).toBeUndefined();
	});
});
