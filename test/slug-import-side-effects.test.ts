import { afterEach, describe, expect, test, vi } from "vitest";

// TRA-528 deep review (2026-10-15): slug.ts imported config.ts, which freezes serverConfig / pipelineConfig
// at import time. cache.ts and schemas.ts import slug.ts, so config was evaluated before tests and the iOS
// contract harness had set GEMINI_API_KEY / PORT (58 failing tests, ios-check unable to start).
describe("importing the slug helpers does not evaluate config.ts", () => {
	afterEach(() => {
		vi.doUnmock("../src/config.js");
		vi.resetModules();
	});

	test.each(["../src/slug.js", "../src/schemas.js", "../src/cache.js"])("%s", async (module) => {
		vi.resetModules();
		vi.doMock("../src/config.js", () => {
			throw new Error("config.ts was evaluated");
		});
		await expect(import(/* @vite-ignore */ module)).resolves.toBeDefined();
	});

	test("config.ts still exports the flag, so pipeline.ts is unchanged", async () => {
		vi.resetModules();
		const config = await import("../src/config.js");
		const flags = await import("../src/flags.js");
		expect(config.scopedReleaseSlugsEnabled).toBe(flags.scopedReleaseSlugsEnabled);
	});
});
