import { describe, expect, it } from "vitest";
import { resolveSearchProvider } from "../src/cli.js";

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
