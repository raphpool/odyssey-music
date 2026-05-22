export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
	child(context: Record<string, unknown>): Logger;
}

function write(
	level: LogLevel,
	context: Record<string, unknown>,
	message: string,
	meta?: Record<string, unknown>,
): void {
	const payload = { level, time: new Date().toISOString(), ...context, msg: message, ...(meta ?? {}) };
	const line = JSON.stringify(payload);
	if (level === "error" || level === "warn") console.error(line);
	else console.log(line);
}

function createLogger(context: Record<string, unknown> = {}): Logger {
	return {
		debug(message, meta) {
			write("debug", context, message, meta);
		},
		info(message, meta) {
			write("info", context, message, meta);
		},
		warn(message, meta) {
			write("warn", context, message, meta);
		},
		error(message, meta) {
			write("error", context, message, meta);
		},
		child(childContext) {
			return createLogger({ ...context, ...childContext });
		},
	};
}

export const logger = createLogger();
