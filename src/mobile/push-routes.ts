import type { IncomingMessage, ServerResponse } from "node:http";
import { type PushStore, PushStoreError } from "./push-store.js";

const MAX_BODY_BYTES = 8 * 1024;
const SUBSCRIPTIONS_PATH = "/mobile/v1/push/subscriptions";

export interface MobilePushRouteRequest {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
}

export interface MobilePushRoutes {
	handle(request: MobilePushRouteRequest): Promise<boolean>;
}

export interface MobilePushRoutesDependencies {
	store?: PushStore;
}

export function createMobilePushRoutes(dependencies: MobilePushRoutesDependencies): MobilePushRoutes {
	return {
		async handle({ req, res, url }): Promise<boolean> {
			if (!url.pathname.startsWith(SUBSCRIPTIONS_PATH)) return false;
			if (!dependencies.store) {
				writeError(res, 503, "push_unavailable", "push subscriptions are temporarily unavailable");
				return true;
			}
			if (url.search || !isSubscriptionPath(url.pathname)) {
				writeError(res, 404, "not_found", "mobile resource not found");
				return true;
			}
			const id = routeSubscriptionId(url.pathname);
			try {
				if (id === null) {
					if (req.method !== "POST") return methodNotAllowed(res, "POST");
					const input = parseCreateBody(await readLimitedJson(req));
					const result = await dependencies.store.create({ ...input, secret: requireBearer(req) });
					writeJson(res, result.kind === "created" ? 201 : 200, toResponse(result.subscription));
					return true;
				}
				const subscriptionId = decodeSubscriptionId(id);
				if (req.method === "PUT") {
					const input = parseUpdateBody(await readLimitedJson(req));
					const result = await dependencies.store.update({
						...input,
						subscriptionId,
						secret: requireBearer(req),
					});
					writeJson(res, 200, toResponse(result));
					return true;
				}
				if (req.method === "DELETE") {
					await dependencies.store.remove({ subscriptionId, secret: requireBearer(req) });
					res.statusCode = 204;
					res.end();
					return true;
				}
				return methodNotAllowed(res, "PUT, DELETE");
			} catch (error) {
				writeStoreError(res, error);
				return true;
			}
		},
	};
}

function isSubscriptionPath(pathname: string): boolean {
	return pathname === SUBSCRIPTIONS_PATH || /^\/mobile\/v1\/push\/subscriptions\/[^/]+$/.test(pathname);
}

function routeSubscriptionId(pathname: string): string | null {
	if (pathname === SUBSCRIPTIONS_PATH) return null;
	return pathname.slice(`${SUBSCRIPTIONS_PATH}/`.length);
}

function decodeSubscriptionId(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new PushStoreError("invalid_subscription", "push subscription id is invalid");
	}
}

function requireBearer(req: IncomingMessage): string {
	const header = req.headers.authorization;
	if (typeof header !== "string") throw new PushStoreError("unauthorized", "authorization is required");
	const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
	if (!match?.[1]) throw new PushStoreError("unauthorized", "authorization is required");
	return match[1];
}

async function readLimitedJson(req: IncomingMessage): Promise<unknown> {
	const contentLength = req.headers["content-length"];
	if (
		typeof contentLength === "string" &&
		(!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)
	) {
		throw new PushStoreError("invalid_subscription", "push subscription request is too large");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size <= MAX_BODY_BYTES) chunks.push(buffer);
	}
	if (size > MAX_BODY_BYTES)
		throw new PushStoreError("invalid_subscription", "push subscription request is too large");
	if (size === 0) throw new PushStoreError("invalid_subscription", "push subscription request is invalid");
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new PushStoreError("invalid_subscription", "push subscription request is invalid");
	}
}

function parseCreateBody(value: unknown): {
	subscriptionId: unknown;
	expoToken: unknown;
	platform: unknown;
	timezone: unknown;
} {
	if (!isExactRecord(value, ["subscription_id", "expo_token", "platform", "timezone"])) {
		throw new PushStoreError("invalid_subscription", "push subscription request is invalid");
	}
	return {
		subscriptionId: value.subscription_id,
		expoToken: value.expo_token,
		platform: value.platform,
		timezone: value.timezone,
	};
}

function parseUpdateBody(value: unknown): {
	expoToken: unknown;
	platform: unknown;
	timezone: unknown;
	enabled: unknown;
} {
	if (!isExactRecord(value, ["expo_token", "platform", "timezone", "enabled"])) {
		throw new PushStoreError("invalid_subscription", "push subscription request is invalid");
	}
	return {
		expoToken: value.expo_token,
		platform: value.platform,
		timezone: value.timezone,
		enabled: value.enabled,
	};
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function toResponse(subscription: {
	subscriptionId: string;
	enabled: boolean;
	timezone: string;
	activatedLocalDate: string;
}) {
	return {
		subscription_id: subscription.subscriptionId,
		enabled: subscription.enabled,
		timezone: subscription.timezone,
		activated_local_date: subscription.activatedLocalDate,
	};
}

function writeStoreError(res: ServerResponse, error: unknown): void {
	if (error instanceof PushStoreError) {
		switch (error.code) {
			case "unauthorized":
				writeError(res, 401, "unauthorized", "authorization is required");
				return;
			case "not_found":
				writeError(res, 404, "not_found", "mobile resource not found");
				return;
			case "conflict":
				writeError(res, 409, "conflict", "push subscription conflicts with an existing subscription");
				return;
			case "capacity_exceeded":
				writeError(res, 503, "push_unavailable", "push subscriptions are temporarily unavailable");
				return;
			case "invalid_subscription":
				writeError(res, 400, "invalid_request", "invalid push subscription request");
				return;
			case "corrupt_registry":
				writeError(res, 503, "push_unavailable", "push subscriptions are temporarily unavailable");
				return;
		}
	}
	writeError(res, 503, "push_unavailable", "push subscriptions are temporarily unavailable");
}

function methodNotAllowed(res: ServerResponse, allow: string): boolean {
	res.setHeader("Allow", allow);
	writeError(res, 405, "method_not_allowed", "push subscription method is not allowed");
	return true;
}

function writeError(res: ServerResponse, status: number, code: string, message: string): void {
	writeJson(res, status, { error: { code, message } });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}
