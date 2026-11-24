import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipelineConfig, translationConfig } from "../../src/config.js";
import { createGeminiGenerateJson } from "../../src/translation/gemini-generate.js";
import type { GenerateJsonRequest } from "../../src/translation/translate-node.js";

// The SDK is the external boundary: it is replaced, so no test here reaches the network.
const sdk = vi.hoisted(() => ({ generateContent: vi.fn(), constructed: vi.fn() }));
vi.mock("@google/genai", () => ({
	GoogleGenAI: vi.fn((options: unknown) => {
		sdk.constructed(options);
		return { models: { generateContent: sdk.generateContent } };
	}),
}));

const REQUEST: GenerateJsonRequest = {
	model: "gemini-test-model",
	systemInstruction: "Translate into French.",
	prompt: "Name: Marlow Quartet",
	responseSchema: { type: "OBJECT", properties: { teaser: { type: "STRING" } } },
	temperature: 0.2,
};
const ANSWER = {
	text: '{"teaser":"Bonjour"}',
	usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 },
};

/** Runs a call to completion with simulated timers, so retry delays and timeouts cost no real time. */
async function settle<T>(call: Promise<T>): Promise<T> {
	await vi.runAllTimersAsync();
	return call;
}

beforeEach(() => {
	vi.useFakeTimers();
	sdk.generateContent.mockReset();
	sdk.constructed.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("createGeminiGenerateJson", () => {
	it("throws on an empty key, since that is a broken invariant", () => {
		expect(() => createGeminiGenerateJson("")).toThrow();
	});

	it("builds the SDK client with the given key", () => {
		createGeminiGenerateJson("test-key");
		expect(sdk.constructed).toHaveBeenCalledWith({ apiKey: "test-key" });
	});

	it("passes the request to the SDK with JSON output and thinking disabled", async () => {
		sdk.generateContent.mockResolvedValue(ANSWER);
		const result = await settle(createGeminiGenerateJson("k")(REQUEST));
		expect(result).toEqual({ ok: true, text: ANSWER.text, inputTokens: 120, outputTokens: 45 });
		expect(sdk.generateContent).toHaveBeenCalledTimes(1);
		expect(sdk.generateContent).toHaveBeenCalledWith({
			model: REQUEST.model,
			contents: [{ role: "user", parts: [{ text: REQUEST.prompt }] }],
			config: {
				systemInstruction: REQUEST.systemInstruction,
				responseMimeType: "application/json",
				responseSchema: REQUEST.responseSchema,
				temperature: REQUEST.temperature,
				thinkingConfig: { thinkingBudget: 0 },
				abortSignal: expect.any(AbortSignal),
			},
		});
	});

	it("reports zero tokens and an empty text when the SDK omits them", async () => {
		sdk.generateContent.mockResolvedValue({});
		const result = await settle(createGeminiGenerateJson("k")(REQUEST));
		expect(result).toEqual({ ok: true, text: "", inputTokens: 0, outputTokens: 0 });
	});

	it.each([
		["RESOURCE_EXHAUSTED", "quota_exhausted"],
		["429 Too Many Requests", "quota_exhausted"],
		["network down: ECONNRESET", "provider_unavailable"],
		["503 UNAVAILABLE (request req-14290)", "provider_unavailable"],
		["503 UNAVAILABLE", "provider_unavailable"],
	])("retries once then gives up on %s", async (message, reason) => {
		sdk.generateContent.mockRejectedValue(new Error(message));
		const result = await settle(createGeminiGenerateJson("k")(REQUEST));
		expect(result).toEqual({ ok: false, reason });
		expect(sdk.generateContent).toHaveBeenCalledTimes(2);
	});

	it("succeeds when the retry after a 503 answers", async () => {
		sdk.generateContent.mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce(ANSWER);
		const call = createGeminiGenerateJson("k")(REQUEST);
		await vi.advanceTimersByTimeAsync(pipelineConfig.retryDelayMs - 1);
		expect(sdk.generateContent).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await call).toMatchObject({ ok: true, text: ANSWER.text });
		expect(sdk.generateContent).toHaveBeenCalledTimes(2);
	});

	it("aborts a call at the timeout, not before, and leaves no timer behind", async () => {
		sdk.generateContent.mockImplementation(() => new Promise(() => {}));
		const call = createGeminiGenerateJson("k")(REQUEST);
		await vi.advanceTimersByTimeAsync(translationConfig.timeoutMs - 1);
		const signal = sdk.generateContent.mock.calls[0]?.[0].config.abortSignal as AbortSignal;
		expect(signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signal.aborted).toBe(true);
		expect(await settle(call)).toEqual({ ok: false, reason: "provider_unavailable" });
		expect(sdk.generateContent).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never logs nor returns the text it sends, even when the SDK error echoes it", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation(() => {}),
		);
		sdk.generateContent.mockRejectedValue(new Error(`400 bad request: ${REQUEST.prompt}`));
		const result = await settle(createGeminiGenerateJson("k")(REQUEST));
		expect(JSON.stringify(result)).not.toContain(REQUEST.prompt);
		for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(REQUEST.prompt);
		for (const spy of spies) spy.mockRestore();
	});
});
