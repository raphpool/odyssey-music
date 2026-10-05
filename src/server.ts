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
 *   GET  /links/:slug        → {spotify, apple, sources} for artist/project/track.
 *                              Spotify comes from MusicBrainz url-rels (artists
 *                              only — MB has no streaming rels on release-groups
 *                              or recordings), Apple Music from iTunes Search.
 *                              Cached in a sidecar, misses included. Genres and
 *                              labels answer 200 with null links.
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
import { loadGenreResolver } from "./genre-identity.js";
import { createGenreRegistry, loadGenreRedirects, resolveReadSlug } from "./genre-registry.js";
import { logger } from "./logger.js";
import { createMobileCatalog } from "./mobile/catalog.js";
import { createMobileGenerationService } from "./mobile/generation-service.js";
import { createGenerationStore } from "./mobile/generation-store.js";
import { createMobileMedia } from "./mobile/media.js";
import { createMobileNodeReader } from "./mobile/nodes.js";
import { createExpoPushReceipts } from "./mobile/push-receipts.js";
import { createMobilePushRoutes } from "./mobile/push-routes.js";
import { createPushScheduler } from "./mobile/push-schedule.js";
import { createExpoPushSender } from "./mobile/push-sender.js";
import { createApnsPushStore, createPushStore } from "./mobile/push-store.js";
import { createMobileRouter } from "./mobile/router.js";
import { createMobileSearch } from "./mobile/search.js";
import { type CatalogIndex, createMusicBrainzCatalog } from "./musicbrainz.js";
import { createGraphService } from "./services/graph-service.js";
import { createImageService } from "./services/image-service.js";
import { createMaterializeService, type MaterializeRequest } from "./services/materialize-service.js";
import { createNodeService } from "./services/node-service.js";
import { createSearchService } from "./services/search-service.js";
import { handleStream } from "./stream.js";
import { LINKABLE_TYPES, resolveStreamingLinks } from "./streaming-links.js";
import type { EdgeRef, NodeType, Slug } from "./types.js";
import {
	invalidateSidecar,
	readValidatedSidecar,
	resolveYouTube,
	type YouTubeResolution,
} from "./youtube.js";

const PORT = serverConfig.port;
const CACHE_DIR = serverConfig.cacheDir;
const STREAM_CACHE_DIR = streamConfig.cacheDir;

const env = loadEnv();
const cache = new NodeCache(CACHE_DIR);
// TRA-28: canonicalizes genre edges (existing node > redirect > QID > mint) so the pipeline
// stops minting duplicate genre nodes for name variants of one already-cached genre.
// loadGenreResolver() is memoized (genre-identity.ts), so this doesn't double the load
// enrichFromMusicBrainz already does per pipeline run.
const [genreRedirects, genreResolver] = await Promise.all([loadGenreRedirects(), loadGenreResolver()]);
const genreRegistry = createGenreRegistry({ cache, resolver: genreResolver, redirects: genreRedirects });
const catalogIndex: CatalogIndex = createMusicBrainzCatalog();
// The existing web search degrades to cache-only on catalog outages. Mobile has a typed
// provider error contract, so it receives an adapter that preserves that distinction.
const mobileCatalogIndex: CatalogIndex = createMusicBrainzCatalog({ failOnUnavailable: true });
const log = logger.child({ module: "server" });
let cacheIndex: CacheIndex | null = null;
// Built lazily on first /search hit so the server can boot even before the cache is warm.
async function getCacheIndex(): Promise<CacheIndex> {
	if (!cacheIndex) cacheIndex = await buildCacheIndex(CACHE_DIR);
	return cacheIndex;
}

function invalidateCacheIndex(): void {
	cacheIndex = null;
}

const handleSearch = createSearchService({ getCacheIndex, catalogIndex });
const materializeService = createMaterializeService({ cache, env, genreRegistry });
const getNode = createNodeService({ cache, runJit: materializeService.runJit, redirects: genreRedirects });
const imageService = createImageService({ cache, redirects: genreRedirects });
const graphService = createGraphService(CACHE_DIR);
const mobileCatalog = createMobileCatalog({ getGraph: () => graphService.getGraph() });
const mobileNodes = createMobileNodeReader({ cache, redirects: genreRedirects });
const mobileMedia = createMobileMedia({
	nodes: mobileNodes,
	imageService,
	resolveLinks: resolveStreamingLinks,
	cacheDir: CACHE_DIR,
});
const mobileSearch = createMobileSearch({
	buildIndex: getCacheIndex,
	invalidateCacheIndex,
	catalogIndex: mobileCatalogIndex,
});
// A broken optional notification registry must not take down the music-reading
// surface. Push routes expose a typed temporary-unavailable response until it is repaired.
let mobilePushStore: Awaited<ReturnType<typeof createPushStore>> | undefined;
try {
	mobilePushStore = await createPushStore({ stateDir: serverConfig.mobileStateDir });
} catch {
	mobilePushStore = undefined;
}
let mobileApnsPushStore: Awaited<ReturnType<typeof createApnsPushStore>> | undefined;
try {
	mobileApnsPushStore = await createApnsPushStore({ stateDir: serverConfig.mobileStateDir });
} catch {
	mobileApnsPushStore = undefined;
}
let mobileGeneration: ReturnType<typeof createMobileGenerationService> | undefined;
try {
	const generationStore = await createGenerationStore({ stateDir: serverConfig.mobileStateDir });
	mobileGeneration = createMobileGenerationService({
		store: generationStore,
		materialize: materializeService,
		invalidateSearch: invalidateCacheIndex,
	});
} catch (error) {
	// Generation persistence is optional for boot: preserve the broken registry and
	// keep all read-only music routes available while this route answers typed 503.
	log.error("mobile generation registry unavailable", {
		error: error instanceof Error ? error.message : "unknown failure",
	});
}
const mobilePushEnabled = process.env.MOBILE_PUSH_ENABLED === "true";
const mobilePushScheduler =
	mobilePushEnabled && mobilePushStore && serverConfig.expoAccessToken
		? createPushScheduler({
				store: mobilePushStore,
				sender: createExpoPushSender({ store: mobilePushStore, accessToken: serverConfig.expoAccessToken }),
				receipts: createExpoPushReceipts({
					store: mobilePushStore,
					accessToken: serverConfig.expoAccessToken,
				}),
				onError: (event, error) => {
					log.error("mobile push scheduler operation failed", {
						event,
						error: error instanceof Error ? error.message : "unknown failure",
					});
				},
			})
		: undefined;
if (mobilePushEnabled && !mobilePushScheduler) {
	log.error("mobile push scheduler is disabled because its store or Expo credential is unavailable");
}
const mobileRouter = createMobileRouter({
	catalog: mobileCatalog,
	nodes: mobileNodes,
	media: mobileMedia,
	search: mobileSearch,
	push: createMobilePushRoutes({
		...(mobilePushStore ? { store: mobilePushStore } : {}),
		...(mobileApnsPushStore ? { apnsStore: mobileApnsPushStore } : {}),
	}),
	...(mobileGeneration ? { generation: mobileGeneration } : {}),
});

const server = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
	if (await mobileRouter.handle({ req, res, url })) return;
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
	// GET /links/:slug → {spotify, apple, sources} for artist/project/track.
	// Resolved on demand (MusicBrainz url-rels for artist Spotify, iTunes for
	// Apple Music) and cached in a sidecar, misses included.
	if (req.method === "GET" && path.startsWith("/links/")) {
		let raw: string;
		try {
			raw = decodeURIComponent(path.slice("/links/".length));
		} catch {
			// Percent-decoding failure is a client error, not ours. Without this the
			// URIError escapes to the 500 handler and fills the error log with
			// scanner traffic.
			json(res, 400, { error: "malformed slug" });
			return;
		}
		if (!raw.includes(":")) {
			json(res, 400, { error: "slug must be '<type>:<name>'", slug: raw });
			return;
		}
		const force = url.searchParams.get("force") === "1";
		await handleLinks(res, raw as Slug, force);
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
		const force = url.searchParams.get("force") === "1";
		await handleResolve(res, raw, force);
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

async function handleLinks(res: ServerResponse, slug: Slug, force: boolean): Promise<void> {
	// 2026-09-10 (TRA-39): a genre slug merged away by TRA-22's duplicate-merge migration (e.g.
	// genre:electronic-music) has no cache node of its own, so a plain cache.get(slug) here
	// 404'd instead of matching /node/:slug's 200 with null links, which the docstring above
	// promises for every genre. Resolve via the same rule node-service.getNode uses (TRA-30).
	const lookupSlug = await resolveReadSlug(slug, genreRedirects, cache);
	const node = await cache.get(lookupSlug).catch((e: unknown) => {
		if (isNotFoundError(e)) return null;
		throw e;
	});
	if (!node) {
		json(res, 404, { error: "not cached", slug });
		return;
	}
	if (!LINKABLE_TYPES.has(node.type)) {
		// Genres and labels have no streaming counterpart. Answer 200 with empty
		// links rather than 404 so the client can treat "no links" uniformly.
		json(res, 200, { slug, spotify: null, apple: null, sources: {} });
		return;
	}
	const artistsField = (node as unknown as { artists?: EdgeRef[] }).artists;
	const artistName = Array.isArray(artistsField) && artistsField[0] ? artistsField[0].name : undefined;
	const links = await resolveStreamingLinks({
		slug,
		type: node.type,
		name: node.name,
		...(artistName ? { artistName } : {}),
		cacheDir: CACHE_DIR,
		force,
	});
	// A resolved page URL is stable, so cache it hard. A miss is not evidence of
	// absence — it can be an iTunes 429 or a MusicBrainz 503 — so give it a short
	// TTL, otherwise a transient outage is frozen at the edge for a day.
	const resolved = links.spotify || links.apple;
	res.setHeader(
		"Cache-Control",
		resolved ? "public, max-age=86400, stale-while-revalidate=3600" : "public, max-age=600",
	);
	json(res, 200, { slug, ...links });
}

async function handleResolve(res: ServerResponse, rawSlug: string, force = false): Promise<void> {
	const slug = (rawSlug.startsWith("track:") ? rawSlug : `track:${rawSlug}`) as Slug;
	// Load node first so we can validate the cached sidecar against the current
	// artist/track names. A poisoned sidecar (right slug, wrong videoId) is
	// dropped here and re-resolved transparently.
	const node = await cache.get(slug).catch((e: unknown) => {
		if (isNotFoundError(e)) return null;
		throw e;
	});
	if (!node || node.type !== "track") {
		json(res, 404, { error: "track not cached", slug });
		return;
	}
	const artistsField = (node as unknown as { artists?: EdgeRef[] }).artists;
	const artistName = Array.isArray(artistsField) && artistsField[0] ? artistsField[0].name : undefined;

	if (force) {
		await invalidateSidecar(CACHE_DIR, slug);
	} else {
		const cached = await readValidatedSidecar(CACHE_DIR, slug, node.name, artistName);
		if (cached) {
			res.setHeader("Cache-Control", "public, max-age=86400");
			json(res, 200, { source: "cache", ...cached });
			return;
		}
	}

	try {
		const r: YouTubeResolution = await resolveYouTube({
			trackSlug: slug,
			trackName: node.name,
			...(artistName ? { artistName } : {}),
			cacheDir: CACHE_DIR,
			tavilyApiKey: env.TAVILY_API_KEY,
			force,
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
	mobilePushScheduler?.start();
});

let shuttingDown = false;
function shutdown(signal: "SIGINT" | "SIGTERM"): void {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info("shutting down", { signal });
	void (mobilePushScheduler?.stop() ?? Promise.resolve()).finally(() => {
		server.close((error) => {
			if (error) {
				log.error("server close failed", { error: error.message });
				process.exitCode = 1;
			}
			process.exit();
		});
	});
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
