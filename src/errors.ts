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
