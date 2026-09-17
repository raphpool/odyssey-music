import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { PipelineDeps } from "../src/pipeline.js";
import {
	artistDraftFixture,
	genreDraftFixture,
	installPipelineMocks,
	labelDraftFixture,
	projectDraftFixture,
	trackDraftFixture,
} from "./helpers/pipeline-mocks.js";

// TRA-239: boundary tests for the Anthropic model call in src/pipeline.ts (generateNodeDraft),
// covering the ticket's "Tests attendus" list — the request built (model, per-type schema,
// max_tokens), a valid structured response, a truncated/invalid response treated as a typed
// failure, and a typed SDK error propagating uncaught. All four external boundaries stay mocked
// (see test/helpers/pipeline-mocks.ts); no network call, no real API key.
//
// Both `runPipeline` and `Anthropic` (the default export of @anthropic-ai/sdk, mocked by
// pipeline-mocks.ts) are loaded dynamically, not statically, for the same reason
// test/pipeline-e2e.test.ts dynamically imports runPipeline: a static `import Anthropic from
// "@anthropic-ai/sdk"` at this file's top would get sorted by Biome ahead of the
// "./helpers/pipeline-mocks.js" import that registers the mock (external packages sort before
// relative imports), and would resolve the real, unmocked module before the mock is registered.
async function loadRunPipeline() {
	return (await import("../src/pipeline.js")).runPipeline;
}

async function loadDraftGenerationError() {
	return (await import("../src/pipeline.js")).DraftGenerationError;
}

async function loadAnthropic() {
	return (await import("@anthropic-ai/sdk")).default;
}

async function loadPipelineConfig() {
	return (await import("../src/config.js")).pipelineConfig;
}

const DEPS: PipelineDeps = { tavilyApiKey: "test", firecrawlApiKey: "test" };
const TIMEOUT_MS = 5_000;

/** Recursively collects any JSON Schema keyword NOT supported by Claude's structured outputs
 * (minItems/maxItems/minLength/maxLength/minimum/maximum/multipleOf), plus the Gemini-specific
 * `propertyOrdering` keyword this migration dropped — see the "Anthropic structured-output
 * schema builders" comment in src/pipeline.ts for the supported/unsupported keyword list. */
const UNSUPPORTED_KEYWORDS = [
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"multipleOf",
	"propertyOrdering",
];
function findUnsupportedKeywords(node: unknown, path = "$"): string[] {
	if (!node || typeof node !== "object") return [];
	const obj = node as Record<string, unknown>;
	const hits: string[] = [];
	for (const kw of UNSUPPORTED_KEYWORDS) {
		if (kw in obj) hits.push(`${path}.${kw}`);
	}
	if (obj.properties && typeof obj.properties === "object") {
		for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) {
			hits.push(...findUnsupportedKeywords(v, `${path}.properties.${k}`));
		}
	}
	if (obj.items) hits.push(...findUnsupportedKeywords(obj.items, `${path}.items`));
	return hits;
}

/** Captures the single request object passed to the mocked `client.messages.create(...)` for
 * the one runPipeline call made between this function running and its caller. */
async function captureRequest(): Promise<Record<string, unknown>> {
	const Anthropic = await loadAnthropic();
	const anthropicMock = vi.mocked(Anthropic);
	expect(anthropicMock).toHaveBeenCalledTimes(1);
	const clientInstance = anthropicMock.mock.results[0]?.value as {
		messages: { create: ReturnType<typeof vi.fn> };
	};
	const createMock = vi.mocked(clientInstance.messages.create);
	expect(createMock).toHaveBeenCalledTimes(1);
	return createMock.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("Anthropic model boundary — request construction (TRA-239)", () => {
	const cases: Array<{
		type: "artist" | "project" | "track" | "genre" | "label";
		draft: () => Record<string, unknown>;
		requiredExtra: string[];
	}> = [
		{
			type: "artist",
			draft: artistDraftFixture,
			requiredExtra: ["editorial_bio", "origin", "active_years", "genres", "labels", "discography"],
		},
		{
			type: "project",
			draft: projectDraftFixture,
			requiredExtra: ["editorial_pitch", "year", "artists", "label", "genres", "tracklist"],
		},
		{
			type: "track",
			draft: trackDraftFixture,
			requiredExtra: ["editorial_teaser", "year", "artists", "project", "genres"],
		},
		{
			type: "genre",
			draft: genreDraftFixture,
			requiredExtra: ["editorial_definition", "era", "related_genres", "key_artists", "key_labels"],
		},
		{
			type: "label",
			draft: labelDraftFixture,
			requiredExtra: ["editorial_description", "founded", "location", "genres", "roster", "notable_releases"],
		},
	];

	for (const { type, draft, requiredExtra } of cases) {
		it(
			`sends model, max_tokens, and a ${type} JSON Schema with additionalProperties:false and no unsupported keywords`,
			async () => {
				installPipelineMocks({ draft: draft() });
				const runPipeline = await loadRunPipeline();
				const pipelineConfig = await loadPipelineConfig();

				await runPipeline({ type, name: `Fixture ${type}` }, DEPS);
				const request = await captureRequest();

				expect(request.model).toBe("claude-haiku-4-5");
				expect(request.model).toBe(pipelineConfig.defaultModel);
				expect(request.max_tokens).toBe(pipelineConfig.maxOutputTokens);
				expect(typeof request.max_tokens).toBe("number");
				expect(request.max_tokens).toBeGreaterThan(0);
				// TRA-239 contract: no thinking param on this call.
				expect(request.thinking).toBeUndefined();

				const format = (request.output_config as { format?: Record<string, unknown> } | undefined)?.format;
				expect(format?.type).toBe("json_schema");
				const schema = format?.schema as Record<string, unknown>;
				expect(schema.type).toBe("object");
				expect(schema.additionalProperties).toBe(false);
				const required = schema.required as string[];
				expect(required).toEqual(expect.arrayContaining(["name", "editorial_article", "citations"]));
				expect(required).toEqual(expect.arrayContaining(requiredExtra));
				expect(findUnsupportedKeywords(schema)).toEqual([]);
			},
			TIMEOUT_MS,
		);
	}
});

describe("Anthropic model boundary — responses (TRA-239)", () => {
	it(
		"returns a valid node from a valid structured response, with usage-derived metrics",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const runPipeline = await loadRunPipeline();

			const result = await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);

			expect(result.node.type).toBe("artist");
			// installPipelineMocks' fixed usage.{input,output}_tokens (42/42, see that file).
			expect(result.metrics.inputTokens).toBe(42);
			expect(result.metrics.outputTokens).toBe(42);
			// Haiku 4.5 pricing (src/config.ts pricingConfig): $1/$5 per 1M input/output tokens.
			expect(result.metrics.costUsd).toBeCloseTo((42 * 1.0 + 42 * 5.0) / 1_000_000, 10);
		},
		TIMEOUT_MS,
	);

	it(
		"treats a max_tokens-truncated response as a typed DraftGenerationError, not a parse crash",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const Anthropic = await loadAnthropic();
			const DraftGenerationError = await loadDraftGenerationError();
			vi.mocked(Anthropic).mockImplementationOnce(
				() =>
					({
						messages: {
							create: vi.fn(async () => ({
								stop_reason: "max_tokens",
								// Deliberately still-parseable-looking but truncated mid-object, matching the
								// SDK's actual failure mode (see src/pipeline.ts's generateNodeDraft comment).
								content: [{ type: "text", text: '{"name": "Fixture Artist", "editorial_articl' }],
								usage: { input_tokens: 10, output_tokens: 10 },
							})),
						},
					}) as unknown as Anthropic,
			);
			const runPipeline = await loadRunPipeline();

			await expect(runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS)).rejects.toBeInstanceOf(
				DraftGenerationError,
			);
		},
		TIMEOUT_MS,
	);

	it(
		"treats unparsable JSON text as a typed DraftGenerationError",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const Anthropic = await loadAnthropic();
			const DraftGenerationError = await loadDraftGenerationError();
			vi.mocked(Anthropic).mockImplementationOnce(
				() =>
					({
						messages: {
							create: vi.fn(async () => ({
								stop_reason: "end_turn",
								content: [{ type: "text", text: "not json at all" }],
								usage: { input_tokens: 10, output_tokens: 10 },
							})),
						},
					}) as unknown as Anthropic,
			);
			const runPipeline = await loadRunPipeline();

			await expect(runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS)).rejects.toBeInstanceOf(
				DraftGenerationError,
			);
		},
		TIMEOUT_MS,
	);

	it(
		"propagates a typed Anthropic.APIError uncaught, never string-matched or swallowed",
		async () => {
			installPipelineMocks({ draft: artistDraftFixture() });
			const Anthropic = await loadAnthropic();
			// A real SDK error instance (RateLimitError extends APIError) — not a plain Error with a
			// similar message, so a test relying on string-matching the failure would not catch a
			// regression that re-throws a generic Error instead of propagating the typed one.
			const apiError = new Anthropic.RateLimitError(
				429,
				{ error: { message: "rate limited" } },
				"rate limited",
				new Headers(),
			);
			vi.mocked(Anthropic).mockImplementationOnce(
				() =>
					({
						messages: {
							create: vi.fn(async () => {
								throw apiError;
							}),
						},
					}) as unknown as Anthropic,
			);
			const runPipeline = await loadRunPipeline();

			let caught: unknown;
			try {
				await runPipeline({ type: "artist", name: "Fixture Artist" }, DEPS);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBe(apiError);
			expect(caught).toBeInstanceOf(Anthropic.APIError);
		},
		TIMEOUT_MS,
	);
});
