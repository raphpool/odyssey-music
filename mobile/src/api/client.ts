import type { z } from "zod";

import { type PublicConfig, readPublicConfig } from "../config";
import {
	apiErrorSchema,
	catalogSchema,
	type Generation,
	generationResponseSchema,
	type ImageResponse,
	imageResponseSchema,
	type LinksResponse,
	linksResponseSchema,
	type NodeResponse,
	type NodeType,
	nodeResponseSchema,
	type SearchResponse,
	searchResponseSchema,
} from "./contracts";
import { apiError, type CatalogResult, type ClientResult, localError } from "./errors";

const GET_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 15_000;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type CatalogRequest = { etag?: string; hasCachedCopy?: boolean; signal?: AbortSignal };
export type CreateGenerationInput = {
	idempotencyKey: string;
	input: Record<string, unknown>;
	signal?: AbortSignal;
};
export type SearchRequest = { q: string; type?: NodeType; limit?: number; signal?: AbortSignal };
export type ApiClientOptions = { config?: PublicConfig; fetch?: FetchLike };

export type ApiClient = {
	getCatalog: (request?: CatalogRequest) => Promise<CatalogResult>;
	getNode: (slug: string, signal?: AbortSignal) => Promise<ClientResult<NodeResponse>>;
	getImage: (slug: string, signal?: AbortSignal) => Promise<ClientResult<ImageResponse>>;
	getLinks: (slug: string, signal?: AbortSignal) => Promise<ClientResult<LinksResponse>>;
	search: (request: SearchRequest) => Promise<ClientResult<SearchResponse>>;
	createGeneration: (input: CreateGenerationInput) => Promise<ClientResult<Generation>>;
	getGeneration: (requestId: string, signal?: AbortSignal) => Promise<ClientResult<Generation>>;
};

type RequestOptions = {
	body?: unknown;
	headers?: Record<string, string>;
	signal?: AbortSignal | undefined;
	timeoutMs: number;
};

function parseRetryAfter(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value)) return undefined;
	const seconds = Number(value);
	return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function isAbort(error: unknown): boolean {
	return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function requestUrl(baseUrl: string, path: string, params?: URLSearchParams): string {
	const base = new URL(baseUrl);
	const url = new URL(path, base);
	if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
		throw new Error("A controlled route escaped the configured API base URL.");
	}
	if (params !== undefined) url.search = params.toString();
	return url.toString();
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
	const configResult =
		options.config === undefined ? readPublicConfig() : { ok: true as const, value: options.config };
	const fetcher = options.fetch ?? globalThis.fetch;

	async function request<T>(
		method: "GET" | "POST",
		path: string,
		schema: z.ZodType<T>,
		options: RequestOptions,
		params?: URLSearchParams,
	): Promise<ClientResult<T> | { kind: "notModified"; etag?: string }> {
		if (!configResult.ok) return { kind: "error", error: localError("configuration") };
		if (options.signal?.aborted) return { kind: "error", error: localError("cancelled") };

		const controller = new AbortController();
		let timedOut = false;
		const onAbort = () => controller.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, options.timeoutMs);

		try {
			const response = await fetcher(requestUrl(configResult.value.apiBaseUrl, path, params), {
				method,
				headers: {
					Accept: "application/json",
					...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
					...options.headers,
				},
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
				signal: controller.signal,
			});
			if (response.status === 304) {
				const etag = response.headers.get("ETag");
				return etag === null ? { kind: "notModified" } : { kind: "notModified", etag };
			}
			const text = await response.text();
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				return { kind: "error", error: localError("invalid_response") };
			}
			if (!response.ok) {
				const parsedError = apiErrorSchema.safeParse(body);
				if (!parsedError.success) return { kind: "error", error: localError("invalid_response") };
				return {
					kind: "error",
					error: apiError(
						response.status,
						parsedError.data.error.code,
						parseRetryAfter(response.headers.get("Retry-After")),
					),
				};
			}
			const parsed = schema.safeParse(body);
			if (!parsed.success) return { kind: "error", error: localError("invalid_response") };
			const etag = response.headers.get("ETag");
			return etag === null
				? { kind: "success", value: parsed.data }
				: { kind: "success", value: parsed.data, etag };
		} catch (error) {
			if (timedOut) return { kind: "error", error: localError("timeout") };
			if (options.signal?.aborted || isAbort(error)) return { kind: "error", error: localError("cancelled") };
			return { kind: "error", error: localError("network_error") };
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	return {
		async getCatalog(requestOptions = {}) {
			const result = await request("GET", "catalog", catalogSchema, {
				headers:
					requestOptions.etag !== undefined && requestOptions.hasCachedCopy === true
						? { "If-None-Match": requestOptions.etag }
						: {},
				signal: requestOptions.signal,
				timeoutMs: GET_TIMEOUT_MS,
			});
			if (result.kind !== "notModified") return result;
			if (
				requestOptions.etag === undefined ||
				requestOptions.hasCachedCopy !== true ||
				result.etag === undefined
			) {
				return { kind: "error", error: localError("invalid_response") };
			}
			return { kind: "notModified", etag: result.etag };
		},
		getNode: async (slug, signal) => {
			const result = await request("GET", `nodes/${encodeURIComponent(slug)}`, nodeResponseSchema, {
				signal,
				timeoutMs: GET_TIMEOUT_MS,
			});
			return result.kind === "notModified"
				? { kind: "error", error: localError("invalid_response") }
				: result;
		},
		getImage: async (slug, signal) => {
			const result = await request("GET", `images/${encodeURIComponent(slug)}`, imageResponseSchema, {
				signal,
				timeoutMs: GET_TIMEOUT_MS,
			});
			return result.kind === "notModified"
				? { kind: "error", error: localError("invalid_response") }
				: result;
		},
		getLinks: async (slug, signal) => {
			const result = await request("GET", `links/${encodeURIComponent(slug)}`, linksResponseSchema, {
				signal,
				timeoutMs: GET_TIMEOUT_MS,
			});
			return result.kind === "notModified"
				? { kind: "error", error: localError("invalid_response") }
				: result;
		},
		search: async ({ q, type, limit, signal }) => {
			const params = new URLSearchParams({ q });
			if (type !== undefined) params.set("type", type);
			if (limit !== undefined) params.set("limit", String(limit));
			const result = await request(
				"GET",
				"search",
				searchResponseSchema,
				{ signal, timeoutMs: GET_TIMEOUT_MS },
				params,
			);
			return result.kind === "notModified"
				? { kind: "error", error: localError("invalid_response") }
				: result;
		},
		createGeneration: async ({ idempotencyKey, input, signal }) => {
			const result = await request("POST", "generations", generationResponseSchema, {
				body: { idempotency_key: idempotencyKey, input },
				signal,
				timeoutMs: POST_TIMEOUT_MS,
			});
			return result.kind === "notModified"
				? { kind: "error", error: localError("invalid_response") }
				: result;
		},
		getGeneration: async (requestId, signal) => {
			const result = await request(
				"GET",
				`generations/${encodeURIComponent(requestId)}`,
				generationResponseSchema,
				{
					signal,
					timeoutMs: GET_TIMEOUT_MS,
				},
			);
			return result.kind === "notModified"
				? { kind: "error", error: localError("invalid_response") }
				: result;
		},
	};
}
