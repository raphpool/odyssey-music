import type { IncomingMessage, ServerResponse } from "node:http";
import type { MobileCatalog } from "./catalog.js";
import { createMobileHttpHandler } from "./http.js";
import { type MobileMedia, MobileProviderUnavailableError } from "./media.js";
import { MobileNodeInputError, type MobileNodeReader } from "./nodes.js";
import type { MobilePushRoutes } from "./push-routes.js";
import {
	type MobileSearch,
	MobileSearchInputError,
	MobileSearchProviderUnavailableError,
	parseMobileSearchRequest,
} from "./search.js";

interface MobileRouterDependencies {
	catalog: MobileCatalog;
	nodes?: MobileNodeReader;
	media?: MobileMedia;
	search?: MobileSearch;
	push?: MobilePushRoutes;
}

export interface MobileRouterRequest {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
}

export interface MobileRouter {
	handle(request: MobileRouterRequest): Promise<boolean>;
}

// Keep the mobile surface injectable so its HTTP contract can be exercised without
// booting the legacy server, whose startup loads cache and provider configuration.
export function createMobileRouter(dependencies: MobileRouterDependencies): MobileRouter {
	const handleHttp = createMobileHttpHandler(dependencies);
	return {
		async handle(request: MobileRouterRequest): Promise<boolean> {
			if (!request.url.pathname.startsWith("/mobile/v1")) return false;
			if (request.url.pathname === "/mobile/v1/catalog") return handleHttp(request);
			if (dependencies.push && (await dependencies.push.handle(request))) return true;
			if (request.url.pathname === "/mobile/v1/search")
				return handleSearchRoute(request, dependencies.search);
			if (!dependencies.nodes || !dependencies.media) {
				writeError(request.res, 404, "not_found", "mobile resource not found");
				return true;
			}
			return handleNodeRoute(request, dependencies.nodes, dependencies.media);
		},
	};
}

async function handleSearchRoute(
	{ req, res, url }: MobileRouterRequest,
	search: MobileSearch | undefined,
): Promise<boolean> {
	if (!search) {
		writeError(res, 404, "not_found", "mobile resource not found");
		return true;
	}
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		writeError(res, 405, "method_not_allowed", "mobile search only supports GET");
		return true;
	}
	res.setHeader("Cache-Control", "no-store");
	try {
		writeJson(res, 200, await search.search(parseMobileSearchRequest(url.searchParams)));
	} catch (error) {
		if (error instanceof MobileSearchInputError) {
			writeError(res, 400, "invalid_request", error.message);
		} else if (error instanceof MobileSearchProviderUnavailableError) {
			writeError(res, 503, "provider_unavailable", "mobile search provider is temporarily unavailable");
		} else {
			writeError(res, 500, "search_unavailable", "mobile search is temporarily unavailable");
		}
	}
	return true;
}

async function handleNodeRoute(
	{ req, res, url }: MobileRouterRequest,
	nodes: MobileNodeReader,
	media: MobileMedia,
): Promise<boolean> {
	const match = /^\/mobile\/v1\/nodes\/([^/]+?)(?:\/(image|links))?$/.exec(url.pathname);
	if (!match) {
		writeError(res, 404, "not_found", "mobile resource not found");
		return true;
	}
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		writeError(res, 405, "method_not_allowed", "mobile nodes only support GET");
		return true;
	}
	if (url.search) {
		writeError(res, 400, "invalid_request", "mobile node routes do not accept query parameters");
		return true;
	}
	let slug: string;
	try {
		slug = decodeURIComponent(match[1] ?? "");
	} catch {
		writeError(res, 400, "invalid_request", "invalid node slug");
		return true;
	}
	try {
		const resource = match[2];
		const body =
			resource === "image"
				? await media.image(slug)
				: resource === "links"
					? await media.links(slug)
					: await nodes.read(slug);
		if (!body) {
			writeError(res, 404, "not_found", "mobile node not found");
			return true;
		}
		res.setHeader("Cache-Control", "private, max-age=86400");
		writeJson(res, 200, body);
	} catch (error) {
		if (error instanceof MobileNodeInputError) {
			writeError(res, 400, "invalid_request", error.message);
		} else if (error instanceof MobileProviderUnavailableError) {
			writeError(res, 503, "provider_unavailable", "mobile provider is temporarily unavailable");
		} else {
			writeError(res, 500, "node_unavailable", "mobile node is temporarily unavailable");
		}
	}
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
