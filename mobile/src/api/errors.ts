export type ApiClientError = {
	kind: "api";
	status: number;
	code: string;
	retryable: boolean;
	message: string;
	retryAfterSeconds?: number;
};

export type LocalClientError = {
	kind: "network_error" | "timeout" | "cancelled" | "invalid_response" | "configuration";
	message: string;
};

export type ClientError = ApiClientError | LocalClientError;
export type ClientResult<T> =
	| { kind: "success"; value: T; etag?: string }
	| { kind: "error"; error: ClientError };
export type CatalogResult =
	| ClientResult<import("./contracts").Catalog>
	| { kind: "notModified"; etag: string };

const messages = {
	api: "The service cannot fulfil this request.",
	cancelled: "The request was cancelled.",
	configuration: "The application configuration is invalid.",
	invalid_response: "The service returned an invalid response.",
	network_error: "The network request failed.",
	timeout: "The request timed out.",
} as const;

export function localError(kind: LocalClientError["kind"]): LocalClientError {
	return { kind, message: messages[kind] };
}

export function apiError(
	status: number,
	code: string,
	remoteRetryable: boolean | undefined,
	retryAfterSeconds: number | undefined,
): ApiClientError {
	return {
		kind: "api",
		status,
		code,
		retryable:
			remoteRetryable ??
			(status === 429 || status === 500 || status === 503 || code === "catalog_unavailable"),
		message: status === 429 ? "Try again later." : messages.api,
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
	};
}
