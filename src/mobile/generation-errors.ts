export type MobileGenerationErrorCode =
	| "invalid_request"
	| "idempotency_conflict"
	| "busy"
	| "job_expired"
	| "provider_quota_exhausted"
	| "provider_unavailable"
	| "internal_error"
	| "interrupted";

const STATUS_BY_CODE: Readonly<Record<MobileGenerationErrorCode, number>> = {
	invalid_request: 400,
	idempotency_conflict: 409,
	busy: 429,
	job_expired: 410,
	provider_quota_exhausted: 503,
	provider_unavailable: 503,
	internal_error: 500,
	interrupted: 500,
};

const MESSAGE_BY_CODE: Readonly<Record<MobileGenerationErrorCode, string>> = {
	invalid_request: "generation request is invalid",
	idempotency_conflict: "request_id is already associated with a different generation",
	busy: "generation service is busy",
	job_expired: "generation job has expired",
	provider_quota_exhausted: "generation provider quota is exhausted",
	provider_unavailable: "generation provider is temporarily unavailable",
	internal_error: "generation failed unexpectedly",
	interrupted: "generation was interrupted",
};

export class MobileGenerationError extends Error {
	readonly status: number;

	constructor(
		readonly code: MobileGenerationErrorCode,
		readonly retryable: boolean,
	) {
		super(MESSAGE_BY_CODE[code]);
		this.name = "MobileGenerationError";
		this.status = STATUS_BY_CODE[code];
	}
}

export function classifyGenerationFailure(error: unknown): MobileGenerationError {
	const value = error instanceof Error ? error : new Error(String(error));
	const code = "code" in value ? String(value.code) : "";
	const status = "status" in value ? Number(value.status) : 0;
	const text = `${code} ${value.name} ${value.message}`.toLowerCase();
	if (code === "RESOURCE_EXHAUSTED" || status === 429 || text.includes("quota")) {
		return new MobileGenerationError("provider_quota_exhausted", false);
	}
	if (
		value.name === "AbortError" ||
		["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"].includes(code) ||
		text.includes("timeout") ||
		text.includes("unavailable")
	) {
		return new MobileGenerationError("provider_unavailable", true);
	}
	return new MobileGenerationError("internal_error", false);
}
