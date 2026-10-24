export interface AppErrorOptions {
	status?: number;
	cause?: unknown;
}

export class AppError extends Error {
	status?: number;
	override cause?: unknown;

	constructor(message: string, options: AppErrorOptions = {}) {
		super(message);
		this.name = new.target.name;
		if (options.status !== undefined) this.status = options.status;
		if (options.cause !== undefined) this.cause = options.cause;
	}
}

export class NotFoundError extends AppError {
	constructor(message: string, options: AppErrorOptions = {}) {
		super(message, { ...options, status: options.status ?? 404 });
	}
}

export class ValidationError extends AppError {
	constructor(message: string, options: AppErrorOptions = {}) {
		super(message, { ...options, status: options.status ?? 400 });
	}
}

export class UpstreamError extends AppError {
	constructor(message: string, options: AppErrorOptions = {}) {
		super(message, { ...options, status: options.status ?? 502 });
	}
}

/**
 * TRA-485: a project or track came out of the pipeline with nobody credited. Nothing is written for it.
 * 2026-10-24: 92 projects and 38 tracks had been written with `artists: []` whenever neither the LLM nor
 * MusicBrainz named anyone; such a node is unreachable from any artist page. It extends UpstreamError so
 * `/materialize` answers 502 (the generation failed, the request was fine) and callers that already catch a
 * failed materialization (crawler, top-up) treat it like any other.
 */
export class UncreditedWorkError extends UpstreamError {
	constructor(
		readonly slug: string,
		readonly workType: "project" | "track",
	) {
		super(`Refusing to create ${slug}: the ${workType} has no credited artist`);
	}
}

export class BadRequestError extends AppError {
	constructor(message: string, options: AppErrorOptions = {}) {
		super(message, { ...options, status: options.status ?? 400 });
	}
}

export function isNotFoundError(error: unknown): error is NotFoundError {
	return (
		error instanceof NotFoundError ||
		(typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT")
	);
}
