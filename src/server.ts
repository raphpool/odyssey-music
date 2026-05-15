/**
 * HTTP server: serves the cache as a graph + a JIT materialization endpoint.
 *
 * Endpoints:
 *   GET  /health             → 'ok'
 *   GET  /data.json          → full graph JSON, computed live from cache
 *   GET  /node/:slug         → one node payload (404 if not cached)
 *   POST /materialize        → body {type, name, disambiguator?} → runs agent,
 *                              writes to cache, returns the node + metrics.
 *                              Same-slug concurrent requests share one in-flight run.
 *
 * No framework — stdlib http, hand-rolled routing. Auth is none (the deployment
 * sits behind nginx which can add basic auth or an allowlist if needed).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { buildCacheIndex, type CacheIndex } from "./cache-index.js";
import { NodeCache } from "./cache.js";
import { loadEnv } from "./env.js";
import { openCatalogIndex, type CatalogIndex, type CatalogResult } from "./musicbrainz.js";
import { runPipeline } from "./pipeline.js";
import { backfillGenreReverses } from "./reverse-edges.js";
import { makeSlug, parseSlug } from "./slug.js";
import { handleStream } from "./stream.js";
import type { EdgeRef, NodePayload, NodeType, Slug } from "./types.js";
import { LIST_EDGES_BY_TYPE, NODE_TYPES, SINGULAR_EDGES_BY_TYPE } from "./types.js";
import { readSidecar, resolveYouTube, type YouTubeResolution } from "./youtube.js";

const PORT = Number.parseInt(process.env.PORT ?? "18791", 10);
const CACHE_DIR = process.env.ODYSSEY_CACHE_DIR ?? join(process.cwd(), "cache");
const STREAM_CACHE_DIR = process.env.STREAM_CACHE_DIR ?? join(CACHE_DIR, "..", "stream-cache");
const MB_DB_PATH = process.env.MB_DB_PATH ?? join(process.cwd(), "data", "musicbrainz.sqlite");

const env = loadEnv();
const cache = new NodeCache(CACHE_DIR);
const catalogIndex: CatalogIndex = openCatalogIndex(MB_DB_PATH);
let cacheIndex: CacheIndex | null = null;
// Built lazily on first /search hit so the server can boot even before the cache is warm.
async function getCacheIndex(): Promise<CacheIndex> {
	if (!cacheIndex) cacheIndex = await buildCacheIndex(CACHE_DIR);
	return cacheIndex;
}

// Coalesce concurrent JIT requests on the same slug.
const inflight = new Map<string, Promise<NodePayload>>();

interface MaterializeRequest {
	type?: string;
	name?: string;
	text?: string;
	disambiguator?: string;
}

interface MaterializeResponse {
	node: NodePayload;
	source: "cache" | "jit";
	wallMs: number;
	metricsCostUsd?: number;
}

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
		console.error(`[server] error ${req.method} ${req.url}: ${msg}`);
		json(res, 500, { error: msg });
	}
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const path = url.pathname;
	if (req.method === "GET" && path === "/health") {
		json(res, 200, { ok: true, cacheDir: CACHE_DIR });
		return;
	}
	if (req.method === "GET" && path === "/data.json") {
		const graph = await buildGraph();
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
		const node = await cache.get(raw as Slug).catch(() => null);
		if (!node) {
			json(res, 404, { error: "not cached", slug: raw });
			return;
		}
		json(res, 200, { source: "cache", node });
		return;
	}
	if (req.method === "GET" && path === "/search") {
		const q = (url.searchParams.get("q") ?? "").trim();
		const typeFilter = url.searchParams.get("type") as NodeType | null;
		const limit = clampLimit(url.searchParams.get("limit"));
		const result = await handleSearch(q, typeFilter, limit);
		res.setHeader("Cache-Control", "public, max-age=30");
		json(res, 200, result);
		return;
	}
	if (req.method === "POST" && path === "/materialize") {
		const body = await readJson<MaterializeRequest>(req);
		const result = await handleMaterialize(body);
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

/**
 * Search result returned to the frontend. Two flavors:
 *
 *  - Cache hit (`source: "cache"`): a node already exists in the JIT cache. Clicking
 *    this result navigates straight to `/node/<slug>` with zero latency.
 *  - Catalog hit (`source: "catalog"`): an entry from MusicBrainz with an MBID but no
 *    materialized page yet. Clicking triggers `/materialize` with the MBID as
 *    disambiguator, then redirects to the resulting node.
 *
 * Reconciliation: when a catalog hit's MBID matches a cache node, we collapse them
 * into a single result of type `cache` (the catalog entry is dropped). When a cache
 * hit has no MBID we still surface it (covers Bandcamp-only / non-MB entities).
 */
interface SearchHit {
	source: "cache" | "catalog";
	type: NodeType;
	name: string;
	subtitle?: string;
	extra?: string;
	mbid?: string;
	slug?: Slug; // present iff source === "cache"
}

async function handleSearch(q: string, typeFilter: NodeType | null, limit: number): Promise<{
	q: string;
	hits: SearchHit[];
	sources: { cache: number; catalog: number };
}> {
	if (!q || q.length < 2) {
		return { q, hits: [], sources: { cache: 0, catalog: 0 } };
	}
	const idx = await getCacheIndex();
	const cacheHits = typeFilter ? idx.prefixByType(typeFilter, q, limit) : idx.prefix(q, limit);
	const mbidsSeen = new Set<string>();
	const out: SearchHit[] = [];
	for (const h of cacheHits) {
		out.push({ source: "cache", type: h.type, name: h.name, slug: h.slug, mbid: h.mbid });
		if (h.mbid) mbidsSeen.add(h.mbid);
	}

	// Catalog rail: only fetch for types that MB covers (artist/project/track).
	if (!typeFilter || typeFilter === "artist" || typeFilter === "project" || typeFilter === "track") {
		const catRaw: CatalogResult[] = typeFilter
			? await catalogIndex.searchByType(typeFilter, q, limit)
			: await catalogIndex.search(q, Math.max(2, Math.floor(limit / 2)));
		for (const c of catRaw) {
			if (mbidsSeen.has(c.mbid)) continue; // already surfaced via cache
			// Also try the reverse: if a cache node has this MBID, swap the catalog hit for the cache one.
			const slug = idx.byMbid(c.mbid);
			if (slug) {
				out.push({ source: "cache", type: c.type, name: c.name, subtitle: c.subtitle, slug, mbid: c.mbid });
				mbidsSeen.add(c.mbid);
				continue;
			}
			out.push({
				source: "catalog",
				type: c.type,
				name: c.name,
				subtitle: c.subtitle,
				extra: c.extra,
				mbid: c.mbid,
			});
		}
	}

	const trimmed = out.slice(0, limit);
	return {
		q,
		hits: trimmed,
		sources: {
			cache: trimmed.filter((h) => h.source === "cache").length,
			catalog: trimmed.filter((h) => h.source === "catalog").length,
		},
	};
}

async function handleResolve(res: ServerResponse, rawSlug: string): Promise<void> {
	const slug = (rawSlug.startsWith("track:") ? rawSlug : `track:${rawSlug}`) as Slug;
	const cached = await readSidecar(CACHE_DIR, slug);
	if (cached) {
		res.setHeader("Cache-Control", "public, max-age=86400");
		json(res, 200, { source: "cache", ...cached });
		return;
	}
	const node = await cache.get(slug).catch(() => null);
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

async function handleMaterialize(body: MaterializeRequest): Promise<MaterializeResponse> {
	if (
		(!body.type || typeof body.type !== "string" || !(NODE_TYPES as readonly string[]).includes(body.type)) &&
		!body.text
	) {
		throw new Error("Provide {type, name} or {text}");
	}
	const t0 = Date.now();
	// Fast path: if we can canonicalize a target slug right now, check cache first.
	if (body.type && body.name) {
		const slug = makeSlug(body.type as NodePayload["type"], body.name, body.disambiguator);
		const cached = await cache.get(slug).catch(() => null);
		if (cached) {
			return { node: cached, source: "cache", wallMs: Date.now() - t0 };
		}
		const key = `${slug}|${body.disambiguator ?? ""}`;
		const existing = inflight.get(key);
		if (existing) {
			const node = await existing;
			return { node, source: "jit", wallMs: Date.now() - t0 };
		}
		const p = runJit(body);
		inflight.set(key, p);
		try {
			const node = await p;
			const out: MaterializeResponse = { node, source: "jit", wallMs: Date.now() - t0 };
			const m = (node as unknown as { _metrics?: { cost_usd: number } })._metrics;
			if (m) out.metricsCostUsd = m.cost_usd;
			return out;
		} finally {
			inflight.delete(key);
		}
	}
	// Free-text path: just run the agent.
	const node = await runJit(body);
	return { node, source: "jit", wallMs: Date.now() - t0 };
}

async function runJit(body: MaterializeRequest): Promise<NodePayload> {
	if (!body.type || !body.name) {
		throw new Error("Pipeline JIT requires both 'type' and 'name'. Free-text seeds are not supported here.");
	}
	const pipelineInput: { type: NodeType; name: string; disambiguator?: string } = {
		type: body.type as NodeType,
		name: body.name,
	};
	if (body.disambiguator) pipelineInput.disambiguator = body.disambiguator;
	const r = await runPipeline(pipelineInput, {
		tavilyApiKey: env.TAVILY_API_KEY,
		firecrawlApiKey: env.FIRECRAWL_API_KEY,
	});
	// Re-check then write atomically through cache (handles parallel JIT for the same slug).
	const existing = await cache.get(r.slug).catch(() => null);
	if (existing) return existing;
	await cache.write(r.node);
	return r.node;
}

async function buildGraph(): Promise<{
	generated_at: string;
	total: number;
	types: Record<string, number>;
	nodes: unknown[];
	edges: { source: string; target: string; kind: string }[];
}> {
	const slugs = await cache.listSlugs();
	const nodes: NodePayload[] = [];
	for (const slug of slugs) {
		const n = await cache.get(slug).catch(() => null);
		if (n) nodes.push(n);
	}
	const types: Record<string, number> = {};
	const vizNodes: unknown[] = [];
	const edges: { source: string; target: string; kind: string }[] = [];
	const cachedSet = new Set(nodes.map((n) => n.slug));
	const teaserField: Record<NodePayload["type"], string> = {
		genre: "editorial_definition",
		label: "editorial_description",
		artist: "editorial_bio",
		project: "editorial_pitch",
		track: "editorial_teaser",
	};
	for (const n of nodes) {
		types[n.type] = (types[n.type] ?? 0) + 1;
		const obj = n as unknown as Record<string, unknown>;
		const teaserVal = obj[teaserField[n.type]];
		const nodeEdges: Record<string, EdgeRef[] | EdgeRef> = {};
		for (const field of LIST_EDGES_BY_TYPE[n.type]) {
			const v = obj[field];
			if (Array.isArray(v) && v.length) nodeEdges[field] = v as EdgeRef[];
		}
		for (const field of SINGULAR_EDGES_BY_TYPE[n.type]) {
			const v = obj[field];
			if (v && typeof v === "object") nodeEdges[field] = v as EdgeRef;
		}
		vizNodes.push({
			id: n.slug,
			type: n.type,
			name: n.name,
			teaser: typeof teaserVal === "string" ? teaserVal : "",
			article: n.editorial_article,
			citations: n.citations,
			edges: nodeEdges,
		});
	}
	// Back-fill missing reverse genre↔genre fields BEFORE computing edges, so
	// e.g. minimal-techno inherits subgenres / parent_genres / related_genres
	// from the forward edges declared on other genre nodes.
	backfillGenreReverses(vizNodes as unknown as Parameters<typeof backfillGenreReverses>[0]);
	for (const vn of vizNodes as unknown as { id: string; edges: Record<string, EdgeRef[] | EdgeRef> }[]) {
		for (const [kind, value] of Object.entries(vn.edges)) {
			const refs = Array.isArray(value) ? value : [value];
			for (const ref of refs) {
				if (!cachedSet.has(ref.slug)) continue;
				edges.push({ source: vn.id, target: ref.slug, kind });
			}
		}
	}
	return {
		generated_at: new Date().toISOString(),
		total: nodes.length,
		types,
		nodes: vizNodes,
		edges,
	};
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
	console.log(`[odyssey-server] listening on :${PORT} cache=${CACHE_DIR}`);
});

// Coalesce slug helper not needed here — parseSlug is imported in case future endpoints want it.
void parseSlug;
