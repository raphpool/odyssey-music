import { afterEach, describe, expect, it, vi } from "vitest";

// config.ts reads the environment at import time, so each case re-imports it after stubbing the variable.
async function loadUserAgent(override: string): Promise<string> {
	vi.resetModules();
	vi.stubEnv("MB_USER_AGENT", override);
	const { musicBrainzConfig } = await import("../src/config.js");
	return musicBrainzConfig.userAgent;
}

const DEFAULT_USER_AGENT = "odyssey-music/0.1 ( https://dropcliffs.com/labs/odyssey )";

describe("MusicBrainz User-Agent", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("defaults to an identifying string with a contact URL and no personal data (TRA-626)", async () => {
		const userAgent = await loadUserAgent("");
		expect(userAgent).not.toContain("@");
		expect(userAgent).toBe(DEFAULT_USER_AGENT);
	});

	it("is still overridden by MB_USER_AGENT", async () => {
		expect(await loadUserAgent("custom-agent/9 ( https://example.test )")).toBe(
			"custom-agent/9 ( https://example.test )",
		);
	});

	it("ignores a blank MB_USER_AGENT and falls back to the default", async () => {
		expect(await loadUserAgent("   ")).toBe(DEFAULT_USER_AGENT);
	});
});
