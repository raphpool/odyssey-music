import type { IncomingMessage, ServerResponse } from "node:http";
import { MobileGenerationError } from "./generation-errors.js";
import type { MobileGenerationInput, MobileGenerationService } from "./generation-service.js";

const MAX_BODY_BYTES = 8 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QID_RE = /^Q[1-9]\d*$/;
const SLUG_RE =
	/^(artist|project|track|genre|label):[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const TYPES = new Set(["artist", "project", "track", "genre", "label"]);

export interface MobileGenerationRouteRequest {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
}

export function createMobileGenerationRoutes(service: MobileGenerationService | undefined) {
	return async function handle(request: MobileGenerationRouteRequest): Promise<boolean> {
		const { req, res, url } = request;
		const collection = url.pathname === "/mobile/v1/generations";
		const id = /^\/mobile\/v1\/generations\/([^/]+)$/.exec(url.pathname)?.[1];
		if (!collection && !id) return false;
		try {
			if (!service) throw new MobileGenerationError("provider_unavailable", true);
			if (url.search) throw new MobileGenerationError("invalid_request", false);
			if (collection && req.method === "POST") {
				const { immediate, ...generation } = await service.submit(parseGenerationInput(await readJson(req)));
				if (immediate) {
					writeJson(res, 200, generation);
				} else {
					res.setHeader("Location", `/mobile/v1/generations/${generation.request_id}`);
					writeJson(res, 202, generation);
				}
				return true;
			}
			if (id && req.method === "GET") {
				if (!UUID_RE.test(id)) throw new MobileGenerationError("invalid_request", false);
				writeJson(res, 200, await service.get(id));
				return true;
			}
			if (collection || id) {
				res.setHeader("Allow", id ? "GET" : "POST");
				writeError(res, 405, "method_not_allowed", "generation route does not support this method");
				return true;
			}
			writeError(res, 404, "not_found", "mobile resource not found");
		} catch (error) {
			if (error instanceof MobileGenerationError) {
				if (error.code === "busy") res.setHeader("Retry-After", "30");
				writeError(res, error.status, error.code, error.message, error.retryable);
			} else {
				writeError(res, 400, "invalid_request", "generation request is invalid");
			}
		}
		return true;
	};
}

export function parseGenerationInput(value: unknown): MobileGenerationInput {
	if (!isRecord(value)) throw new MobileGenerationError("invalid_request", false);
	const allowed = new Set(["request_id", "type", "name", "slug", "mbid", "qid", "disambiguator"]);
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new MobileGenerationError("invalid_request", false);
	const requestId = text(value.request_id, 36, 36);
	const type = text(value.type, 3, 7);
	const name = text(value.name, 1, 200);
	if (!UUID_RE.test(requestId) || !TYPES.has(type)) throw new MobileGenerationError("invalid_request", false);
	const slug = optionalText(value.slug, 200);
	const mbid = optionalText(value.mbid, 36);
	const qid = optionalText(value.qid, 32);
	const disambiguator = optionalText(value.disambiguator, 200);
	if (
		(slug && (!SLUG_RE.test(slug) || !slug.startsWith(`${type}:`))) ||
		(mbid && !UUID_RE.test(mbid)) ||
		(qid && !QID_RE.test(qid))
	) {
		throw new MobileGenerationError("invalid_request", false);
	}
	const out: MobileGenerationInput = { requestId, type, name };
	if (slug) out.slug = slug;
	if (mbid) out.mbid = mbid;
	if (qid) out.qid = qid;
	if (disambiguator) out.disambiguator = disambiguator;
	return out;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
		throw new MobileGenerationError("invalid_request", false);
	}
	const declaredHeader = req.headers["content-length"];
	const declared = declaredHeader === undefined ? 0 : Number(declaredHeader);
	if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES)
		throw new MobileGenerationError("invalid_request", false);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new MobileGenerationError("invalid_request", false);
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new MobileGenerationError("invalid_request", false);
	}
}

function text(value: unknown, minimum: number, maximum: number): string {
	if (typeof value !== "string") throw new MobileGenerationError("invalid_request", false);
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum)
		throw new MobileGenerationError("invalid_request", false);
	return normalized;
}

function optionalText(value: unknown, maximum: number): string | undefined {
	if (value === undefined) return undefined;
	return text(value, 1, maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeError(
	res: ServerResponse,
	status: number,
	code: string,
	message: string,
	retryable?: boolean,
): void {
	writeJson(res, status, { error: { code, message, ...(retryable === undefined ? {} : { retryable }) } });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}
