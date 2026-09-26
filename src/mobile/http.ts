import type { IncomingMessage, ServerResponse } from "node:http";
import { type MobileCatalog, MobileCatalogInputError, parseMobileIdentities } from "./catalog.js";
import { MOBILE_API_PREFIX, type MobileApiErrorCode } from "./contracts.js";

interface MobileHttpDependencies {
	catalog: MobileCatalog;
}

interface MobileHttpRequest {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
}

export function createMobileHttpHandler(dependencies: MobileHttpDependencies) {
	return async function handleMobileHttp({ req, res, url }: MobileHttpRequest): Promise<boolean> {
		if (!url.pathname.startsWith(MOBILE_API_PREFIX)) return false;
		if (url.pathname !== `${MOBILE_API_PREFIX}/catalog`) {
			writeError(res, 404, "not_found", "mobile resource not found");
			return true;
		}
		if (req.method !== "GET") {
			res.setHeader("Allow", "GET");
			writeError(res, 405, "method_not_allowed", "catalog only supports GET");
			return true;
		}
		if (hasUnexpectedSearchParams(url)) {
			writeError(res, 400, "invalid_request", "unsupported catalog query parameter");
			return true;
		}

		try {
			const catalog = await dependencies.catalog.getCatalog(
				parseMobileIdentities(url.searchParams.get("identities")),
			);
			const etag = `"${catalog.revision.replace(":", "-")}"`;
			res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
			res.setHeader("ETag", etag);
			if (matchesEtag(req.headers["if-none-match"], etag)) {
				res.statusCode = 304;
				res.end();
				return true;
			}
			writeJson(res, 200, catalog);
		} catch (error) {
			if (error instanceof MobileCatalogInputError) {
				writeError(res, 400, "invalid_request", error.message);
			} else {
				writeError(res, 500, "catalog_unavailable", "mobile catalog is temporarily unavailable");
			}
		}
		return true;
	};
}

function hasUnexpectedSearchParams(url: URL): boolean {
	for (const key of url.searchParams.keys()) {
		if (key !== "identities") return true;
	}
	return url.searchParams.getAll("identities").length > 1;
}

function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
	if (!header) return false;
	const values = Array.isArray(header) ? header : [header];
	return values
		.flatMap((value) => value.split(","))
		.map((value) => value.trim().replace(/^W\//, ""))
		.some((value) => value === "*" || value === etag);
}

function writeError(res: ServerResponse, status: number, code: MobileApiErrorCode, message: string): void {
	writeJson(res, status, { error: { code, message } });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}
