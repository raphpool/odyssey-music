import { GoogleGenAI, type Schema } from "@google/genai";
import { pipelineConfig, translationConfig } from "../config.js";
import type {
	GenerateJson,
	GenerateJsonRequest,
	GenerateJsonResult,
	ProviderFailureDetail,
} from "./translate-node.js";

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

/** Statuses that hold for the whole batch (model, key, rights): relaunching changes nothing (TRA-837). */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);
/** A 400 refuses this request; whether it refuses them all is for the batch to see (see `bad_request`). */
const BAD_REQUEST_STATUS = 400;
export const MAX_DETAIL_LENGTH = 200;

function statusOf(error: unknown): number | undefined {
	const status =
		typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
	return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/** The SDK puts the API's JSON body in `message`; the sentence inside it is what a human needs. */
function readableMessage(raw: string): string {
	try {
		const body: unknown = JSON.parse(raw);
		const inner = (body as { error?: { message?: unknown } } | null)?.error?.message;
		if (typeof inner === "string" && inner.trim() !== "") return inner;
	} catch {
		// Not JSON: a network or timeout error, whose text is already readable.
	}
	return raw;
}

/**
 * What an operator may read about a failure: the status and a one-line, truncated message. The key and the
 * request text are removed first and the cut comes last, so it can never leave half a secret behind. An
 * API error may echo the request (400) or a URL carrying the key.
 */
function describeFailure(error: unknown, secrets: readonly string[]): ProviderFailureDetail {
	let message = readableMessage(messageOf(error));
	for (const secret of secrets) if (secret !== "") message = message.replaceAll(secret, "[redacted]");
	message = message.replace(/\s+/g, " ").trim();
	if (message.length > MAX_DETAIL_LENGTH) message = `${message.slice(0, MAX_DETAIL_LENGTH)}…`;
	const status = statusOf(error);
	return status === undefined ? { message } : { status, message };
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
			const detail = describeFailure(error, [apiKey, request.prompt, request.systemInstruction]);
			const permanent = detail.status !== undefined && PERMANENT_STATUSES.has(detail.status);
			// A quota answer wins: it is the only refusal the batch may wait out.
			const reason = isQuotaError(error)
				? "quota_exhausted"
				: permanent
					? "provider_rejected"
					: detail.status === BAD_REQUEST_STATUS
						? "bad_request"
						: "provider_unavailable";
			return { ok: false, reason, detail };
		} finally {
			clearTimeout(timer);
		}
	}

	return async (request) => {
		let result = await attempt(request);
		// A refusal of the request is not retried: the second call would wait for the same answer.
		const refused = (r: GenerateJsonResult) =>
			!r.ok && (r.reason === "provider_rejected" || r.reason === "bad_request");
		for (let tries = 1; !result.ok && !refused(result) && tries < MAX_ATTEMPTS; tries++) {
			await new Promise((resolve) => setTimeout(resolve, pipelineConfig.retryDelayMs));
			result = await attempt(request);
		}
		return result;
	};
}
