import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateJson, GenerateJsonRequest } from "../../src/translation/translate-node.js";
import { artistNode } from "../images/helpers.js";

// TRA-838: the model that translates. The Gemini provider is the external boundary and is replaced by a
// recorder; config, translator and pipeline wiring are the real modules, re-imported per env scenario.
const provider = vi.hoisted(() => ({ requests: [] as GenerateJsonRequest[] }));
vi.mock("../../src/translation/gemini-generate.js", () => ({
	createGeminiGenerateJson: (): GenerateJson => async (request) => {
		provider.requests.push(request);
		return { ok: false, reason: "provider_unavailable" };
	},
}));

const TRANSLATION_MODEL = "gemini-3.1-flash-lite";
const WRITING_MODEL = "gemini-2.5-flash-lite";

const node = artistNode("marlow-quartet", "Marlow Quartet", {
	editorial_bio: "A restless electronic project from Cornwall.",
	editorial_article: "Marlow Quartet is the project of Elias Marlow, a composer born in Cornwall.",
});

async function loadConfig(env: { translation?: string; writing?: string } = {}) {
	vi.resetModules();
	vi.stubEnv("GEMINI_TRANSLATION_MODEL", env.translation);
	vi.stubEnv("GEMINI_MODEL", env.writing);
	return import("../../src/config.js");
}

beforeEach(() => {
	provider.requests.length = 0;
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("translation model default (TRA-838)", () => {
	// 2026-11-26: with no variable the translation fell back on the writing model, gemini-2.5-flash-lite,
	// which new API keys can no longer reach (404) while the TRA-812 pilot was judged in gemini-3.1-flash-lite.
	it("is gemini-3.1-flash-lite when GEMINI_TRANSLATION_MODEL is unset", async () => {
		const { translationConfig } = await loadConfig();

		expect(translationConfig.model).toBe(TRANSLATION_MODEL);
	});

	it("is gemini-3.1-flash-lite when GEMINI_TRANSLATION_MODEL is blank", async () => {
		const { translationConfig } = await loadConfig({ translation: "  " });

		expect(translationConfig.model).toBe(TRANSLATION_MODEL);
	});

	it("lets GEMINI_TRANSLATION_MODEL take priority", async () => {
		const { translationConfig } = await loadConfig({ translation: "gemini-9-test" });

		expect(translationConfig.model).toBe("gemini-9-test");
	});

	it("does not follow GEMINI_MODEL any more", async () => {
		const { translationConfig } = await loadConfig({ writing: "gemini-writing-override" });

		expect(translationConfig.model).toBe(TRANSLATION_MODEL);
	});

	it("leaves the writing model alone", async () => {
		expect((await loadConfig()).pipelineConfig.defaultModel).toBe(WRITING_MODEL);
		expect((await loadConfig({ translation: "gemini-9-test" })).pipelineConfig.defaultModel).toBe(
			WRITING_MODEL,
		);
		expect((await loadConfig({ writing: "gemini-writing-override" })).pipelineConfig.defaultModel).toBe(
			"gemini-writing-override",
		);
	});
});

describe("model used by the write-time translation (TRA-838)", () => {
	it("asks the same model as the batch translator, the one the batch was judged in", async () => {
		await loadConfig();
		const { createNodeTranslator } = await import("../../src/translation/translate-node.js");
		const { makePipelineTranslator } = await import("../../src/translation/pipeline-translator.js");

		const batch: GenerateJson = async (request) => {
			provider.requests.push(request);
			return { ok: false, reason: "provider_unavailable" };
		};
		await createNodeTranslator({ generate: batch })(node, "fr");
		const batchModels = new Set(provider.requests.map((request) => request.model));
		provider.requests.length = 0;

		await makePipelineTranslator({ apiKey: "test" })(node);
		const pipelineModels = new Set(provider.requests.map((request) => request.model));

		expect(provider.requests.length).toBeGreaterThan(0);
		expect([...batchModels]).toEqual([TRANSLATION_MODEL]);
		expect([...pipelineModels]).toEqual([TRANSLATION_MODEL]);
	});

	it("keeps asking gemini-3.1-flash-lite when GEMINI_MODEL changes the writing model", async () => {
		await loadConfig({ writing: "gemini-writing-override" });
		const { makePipelineTranslator } = await import("../../src/translation/pipeline-translator.js");

		await makePipelineTranslator({ apiKey: "test" })(node);

		expect(provider.requests.length).toBeGreaterThan(0);
		expect(provider.requests.every((request) => request.model === TRANSLATION_MODEL)).toBe(true);
	});

	it("follows GEMINI_TRANSLATION_MODEL for the pipeline as for the batch", async () => {
		await loadConfig({ translation: "gemini-9-test" });
		const { makePipelineTranslator } = await import("../../src/translation/pipeline-translator.js");

		await makePipelineTranslator({ apiKey: "test" })(node);

		expect(provider.requests.every((request) => request.model === "gemini-9-test")).toBe(true);
	});
});
