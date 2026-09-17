import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/env.js";

// TRA-242: TAVILY_API_KEY is only required when the search provider is (or defaults to)
// "tavily". GEMINI_API_KEY and FIRECRAWL_API_KEY stay required regardless of provider.
describe("loadEnv", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("requires TAVILY_API_KEY by default (searchProvider omitted)", () => {
		vi.stubEnv("GEMINI_API_KEY", "gemini-key");
		vi.stubEnv("TAVILY_API_KEY", "");
		vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-key");

		expect(() => loadEnv()).toThrow(/TAVILY_API_KEY/);
	});

	it('requires TAVILY_API_KEY when searchProvider is explicitly "tavily"', () => {
		vi.stubEnv("GEMINI_API_KEY", "gemini-key");
		vi.stubEnv("TAVILY_API_KEY", "");
		vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-key");

		expect(() => loadEnv({ searchProvider: "tavily" })).toThrow(/TAVILY_API_KEY/);
	});

	it('does not require TAVILY_API_KEY when searchProvider is "firecrawl"', () => {
		vi.stubEnv("GEMINI_API_KEY", "gemini-key");
		vi.stubEnv("TAVILY_API_KEY", "");
		vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-key");

		const env = loadEnv({ searchProvider: "firecrawl" });

		expect(env.GEMINI_API_KEY).toBe("gemini-key");
		expect(env.FIRECRAWL_API_KEY).toBe("firecrawl-key");
		expect(env.TAVILY_API_KEY).toBe("");
	});

	it('still requires GEMINI_API_KEY and FIRECRAWL_API_KEY when searchProvider is "firecrawl"', () => {
		vi.stubEnv("GEMINI_API_KEY", "");
		vi.stubEnv("TAVILY_API_KEY", "");
		vi.stubEnv("FIRECRAWL_API_KEY", "");

		expect(() => loadEnv({ searchProvider: "firecrawl" })).toThrow(/GEMINI_API_KEY/);
		expect(() => loadEnv({ searchProvider: "firecrawl" })).toThrow(/FIRECRAWL_API_KEY/);
	});

	it("succeeds with all three keys set and no searchProvider option (unchanged default behavior)", () => {
		vi.stubEnv("GEMINI_API_KEY", "gemini-key");
		vi.stubEnv("TAVILY_API_KEY", "tavily-key");
		vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-key");

		const env = loadEnv();

		expect(env).toEqual({
			GEMINI_API_KEY: "gemini-key",
			TAVILY_API_KEY: "tavily-key",
			FIRECRAWL_API_KEY: "firecrawl-key",
		});
	});
});
