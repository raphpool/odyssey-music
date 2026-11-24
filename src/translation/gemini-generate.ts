import { GoogleGenAI, type Schema } from "@google/genai";
import { pipelineConfig, translationConfig } from "../config.js";
import type { GenerateJson, GenerateJsonRequest, GenerateJsonResult } from "./translate-node.js";

// The only module of the translation feature that touches the Gemini SDK (TRA-807). It turns every provider
// failure into a typed result: the translator above it never sees an exception from the network.

const MAX_ATTEMPTS = 2;

interface UsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isQuotaError(error: unknown): boolean {
	const message = messageOf(error);
	// Word-bounded: a request id or byte count that merely contains the digits must not read as a quota error.
	return /\b429\b/.test(message) || message.includes("RESOURCE_EXHAUSTED");
}

/** Built on @google/genai: responseMimeType application/json, thinking disabled. */
export function createGeminiGenerateJson(apiKey: string): GenerateJson {
	if (!apiKey) throw new Error("GEMINI_API_KEY missing");
	const ai = new GoogleGenAI({ apiKey });

	async function attempt(request: GenerateJsonRequest): Promise<GenerateJsonResult> {
		// The abort signal frees the socket; the race guarantees the deadline even if the SDK ignores the signal.
		const controller = new AbortController();
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error(`gemini call timed out after ${translationConfig.timeoutMs}ms`));
			}, translationConfig.timeoutMs);
		});
		try {
			const call = ai.models.generateContent({
				model: request.model,
				contents: [{ role: "user", parts: [{ text: request.prompt }] }],
				config: {
					systemInstruction: request.systemInstruction,
					responseMimeType: "application/json",
					// The schema comes from the translator in the SDK's own dialect, as a plain object.
					responseSchema: request.responseSchema as Schema,
					temperature: request.temperature,
					// Same setting as the drafting call in pipeline.ts: no chain of thought for a constrained task.
					thinkingConfig: { thinkingBudget: 0 },
					abortSignal: controller.signal,
				},
			});
			// If the deadline wins, the late answer or rejection of the SDK call must not surface as unhandled.
			call.catch(() => {});
			const resp = await Promise.race([call, deadline]);
			const usage = (resp as { usageMetadata?: UsageMetadata }).usageMetadata;
			return {
				ok: true,
				text: resp.text ?? "",
				inputTokens: usage?.promptTokenCount ?? 0,
				outputTokens: usage?.candidatesTokenCount ?? 0,
			};
		} catch (error) {
			return { ok: false, reason: isQuotaError(error) ? "quota_exhausted" : "provider_unavailable" };
		} finally {
			clearTimeout(timer);
		}
	}

	return async (request) => {
		let result = await attempt(request);
		for (let tries = 1; !result.ok && tries < MAX_ATTEMPTS; tries++) {
			await new Promise((resolve) => setTimeout(resolve, pipelineConfig.retryDelayMs));
			result = await attempt(request);
		}
		return result;
	};
}
