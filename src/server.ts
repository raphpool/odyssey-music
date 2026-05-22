/**
 * HTTP server: serves the cache as a graph + a JIT materialization endpoint.
 *
 * Endpoints:
 *   GET  /health             → 'ok'
 *   GET  /data.json          → full graph JSON, computed live from cache
 *   GET  /node/:slug         → one node payload (404 if not cached)
 *   GET  /image/:slug        → resolves the best display image for the node,
 *                              hitting iTunes Search for projects/tracks without
 *                              a cover, walking edges (genre→landmark project,
 *                              label→notable release, artist→discography) when
 *                              the node has no direct cover of its own. Any
 *                              iTunes hit is persisted to the cached JSON so
 *                              subsequent calls return instantly.
 *   POST /materialize        → body {type, name, disambiguator?} → runs agent,
 *                              writes to cache, returns the node + metrics.
 *                              Same-slug concurrent requests share one in-flight run.
 *
 * No framework — stdlib http, hand-rolled routing. Auth is none (the deployment
 * sits behind nginx which can add basic auth or an allowlist if needed).
 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { NodeCache } from "./cache.js";
import { buildCacheIndex, type CacheIndex } from "./cache-index.js";
import { serverConfig, streamConfig } from "./config.js";
import { loadEnv } from "./env.js";
import { AppError, isNotFoundError } from "./errors.js";
import { logger } from "./logger.js";
import { type CatalogIndex, openCatalogIndex } from "./musicbrainz.js";
import { createGraphService } from "./services/graph-service.js";
import { createImageService } from "./services/image-service.js";
import { createMaterializeService, type MaterializeRequest } from "./services/materialize-service.js";
import { createNodeService } from "./services/node-service.js";
import { createSearchService } from "./services/search-service.js";
import { handleStream } from "./stream.js";
import type { EdgeRef, NodeType, Slug } from "./types.js";
import { readSidecar, resolveYouTube, type YouTubeResolution } from "./youtube.js";

const PORT = serverConfig.port;
const CACHE_DIR = serverConfig.cacheDir;
const STREAM_CACHE_DIR = streamConfig.cacheDir;

const env = loadEnv();
const cache = new NodeCache(CACHE_DIR);
const catalogIndex: CatalogIndex = openCatalogIndex();
const log = logger.child({ module: "server" });
let cacheIndex: CacheIndex | null = null;
// Built lazily on first /search hit so the server can boot even before the cache is warm.
async function getCacheIndex(): Promise<CacheIndex> {
	if (!cacheIndex) cacheIndex = await buildCacheIndex(CACHE_DIR);
	return cacheIndex;
}

const handleSearch = createSearchService({ getCacheIndex, catalogIndex });
const materializeService = createMaterializeService({ cache, env });
const getNode = createNodeService({ cache, runJit: materializeService.runJit });
const imageService = createImageService({ cache });
const graphService = createGraphService(CACHE_DIR);

const server = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") {
		res.statusCode = 204;
		res.end();
		return;
	}
	try {
		await route(req, res);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log.error("request failed", { method: req.method, url: req.url, error: msg });
		json(res, e instanceof AppError && e.status ? e.status : 500, { error: msg });
	}
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const path = url.pathname;
	if (req.method === "GET" && path === "/health") {
		json(res, 200, { ok: true, cacheDir: CACHE_DIR });
		return;
	}
	if (req.method === "GET" && path === "/version") {
		// Provenance marker written by deploy/deploy-server.sh. Tells us at any time
		// what commit is actually running, so we can compare against main.
		try {
			const raw = await readFile(join(process.cwd(), ".deployed-sha"), "utf8");
			res.setHeader("Cache-Control", "no-store");
			res.statusCode = 200;
			res.setHeader("Content-Type", "application/json");
			res.end(raw);
		} catch {
			json(res, 200, { sha: "unknown", note: "no .deployed-sha marker on disk" });
		}
		return;
	}
	if (req.method === "GET" && path === "/data.json") {
		const graph = await graphService.getGraph();
		res.setHeader("Cache-Control", "public, max-age=10");
		json(res, 200, graph);
		return;
	}
	if (req.method === "GET" && path.startsWith("/node/")) {
		const raw = decodeURIComponent(path.slice("/node/".length));
		if (!raw) {
			json(res, 400, { error: "missing slug" });
			return;
		}
		const result = await getNode(raw as Slug);
		if (!result) {
			json(res, 404, { error: "not cached", slug: raw });
			return;
		}
		json(res, 200, result);
		return;
	}
	if (req.method === "GET" && path.startsWith("/image/")) {
		const raw = decodeURIComponent(path.slice("/image/".length));
		if (!raw) {
			json(res, 400, { error: "missing slug" });
			return;
		}
		try {
			const result = await imageService.resolveDisplayImage(raw as Slug);
			// 24h public cache — the image URL itself never changes once resolved, and
			// iTunes' rate limit makes re-asking expensive. Stale OK for an hour past expiry.
			res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=3600");
			json(res, 200, result);
		} catch (e) {
			json(res, 500, { error: e instanceof Error ? e.message : String(e) });
		}
		return;
	}
	if (req.method === "GET" && path === "/search") {
		const q = (url.searchParams.get("q") ?? "").trim();
		const typeFilter = url.searchParams.get("type") as NodeType | null;
		const limit = clampLimit(url.searchParams.get("limit"));
		const result = await handleSearch(q, typeFilter, limit);
		// IMPORTANT: do NOT public-cache /search responses. CloudFlare was caching empty
		// hit lists at the edge when MB was momentarily 503-throttled, which then served
		// "no results for tame impala" for the next 30s+ to everyone. Browser-private cache
		// is fine and cuts repeated keystroke spam, but never let intermediaries store it.
		const cc = result.hits.length === 0 ? "no-store" : "private, max-age=15";
		res.setHeader("Cache-Control", cc);
		json(res, 200, result);
		return;
	}
	if (req.method === "POST" && path === "/materialize") {
		const body = await readJson<MaterializeRequest>(req);
		const fresh = url.searchParams.get("fresh") === "1" || url.searchParams.get("fresh") === "true";
		const result = await materializeService.handleMaterialize(body, { fresh });
		json(res, 200, result);
		return;
	}
	// GET /resolve/:trackSlug → returns {videoId, url, title, resolvedAt}, cached
	// in a sidecar file. Slug is the bare slug ("track:foo") or just the name part.
	if (req.method === "GET" && path.startsWith("/resolve/")) {
		const raw = decodeURIComponent(path.slice("/resolve/".length));
		await handleResolve(res, raw);
		return;
	}
	// GET /stream/:videoId → pipes audio (m4a) with HTTP Range support.
	if (req.method === "GET" && path.startsWith("/stream/")) {
		const videoId = decodeURIComponent(path.slice("/stream/".length));
		await handleStream(req, res, { videoId, streamCacheDir: STREAM_CACHE_DIR });
		return;
	}
	json(res, 404, { error: "not found", path });
}

function clampLimit(raw: string | null): number {
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isFinite(n) || n <= 0) return 8;
	return Math.min(n, 25);
}

async function handleResolve(res: ServerResponse, rawSlug: string): Promise<void> {
	const slug = (rawSlug.startsWith("track:") ? rawSlug : `track:${rawSlug}`) as Slug;
	const cached = await readSidecar(CACHE_DIR, slug);
	if (cached) {
		res.setHeader("Cache-Control", "public, max-age=86400");
		json(res, 200, { source: "cache", ...cached });
		return;
	}
	const node = await cache.get(slug).catch((e: unknown) => {
		if (isNotFoundError(e)) return null;
		throw e;
	});
	if (!node || node.type !== "track") {
		json(res, 404, { error: "track not cached", slug });
		return;
	}
	// Pick an artist name from the track's artists list, if any.
	const artistsField = (node as unknown as { artists?: EdgeRef[] }).artists;
	const artistName = Array.isArray(artistsField) && artistsField[0] ? artistsField[0].name : undefined;
	try {
		const r: YouTubeResolution = await resolveYouTube({
			trackSlug: slug,
			trackName: node.name,
			...(artistName ? { artistName } : {}),
			cacheDir: CACHE_DIR,
			tavilyApiKey: env.TAVILY_API_KEY,
		});
		json(res, 200, { source: "resolved", ...r });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		json(res, 502, { error: "resolve failed", detail: msg });
	}
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) return {} as T;
	return JSON.parse(text) as T;
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}

server.listen(PORT, () => {
	log.info("listening", { port: PORT, cacheDir: CACHE_DIR });
});
