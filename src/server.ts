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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { NodeCache } from "./cache.js";
import { buildCacheIndex, type CacheIndex } from "./cache-index.js";
import { loadEnv } from "./env.js";
import { lookupAlbumArt } from "./itunes.js";
import { type CatalogIndex, type CatalogResult, openCatalogIndex } from "./musicbrainz.js";
import { runPipeline } from "./pipeline.js";
import { backfillGenreReverses } from "./reverse-edges.js";
import { makeSlug, parseSlug } from "./slug.js";
import { handleStream } from "./stream.js";
import type { EdgeRef, NodePayload, NodeType, Slug } from "./types.js";
import { LIST_EDGES_BY_TYPE, NODE_TYPES, OPTIONAL_TEXT_FIELDS, SINGULAR_EDGES_BY_TYPE } from "./types.js";
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
	// MusicBrainz id hint from /search catalog hits. Stored on the resulting node
	// payload (NodePayload.mbid) so future searches can dedup via cache-index.byMbid.
	// NOT used as a slug disambiguator — that would fragment the graph by producing
	// slugs like `artist:drake--9fff…` while parent edges still point at `artist:drake`.
	mbid?: string;
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
		// Freshness TTL (2026-05-19 goal-2): a node older than 12h is stale. Re-materialize
		// synchronously so the GET response carries the fresh payload (Henry/Raph want JIT
		// feel — "tu refresh la page t'auras pas la meme chose").
		const TTL_MS = 12 * 3600 * 1000;
		const matAt = new Date(node.materialized_at).getTime();
		if (Number.isFinite(matAt) && Date.now() - matAt > TTL_MS) {
			try {
				const req2: MaterializeRequest = { type: node.type, name: node.name };
				const dis = (node as unknown as Record<string, unknown>).disambiguator;
				if (typeof dis === "string" && dis) req2.disambiguator = dis;
				const fresh = await runJit(req2, { fresh: true });
				json(res, 200, { source: "jit-refreshed", node: fresh });
				return;
			} catch (e) {
				// If re-materialization fails (transient Gemini/Tavily blip), serve the stale node
				// rather than 500 — better UX than nothing.
				const msg = e instanceof Error ? e.message : String(e);
				json(res, 200, { source: "cache-stale-refresh-failed", node, refresh_error: msg.slice(0, 200) });
				return;
			}
		}
		json(res, 200, { source: "cache", node });
		return;
	}
	if (req.method === "GET" && path.startsWith("/image/")) {
		const raw = decodeURIComponent(path.slice("/image/".length));
		if (!raw) {
			json(res, 400, { error: "missing slug" });
			return;
		}
		try {
			const result = await resolveDisplayImage(raw as Slug, new Set());
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
		const result = await handleMaterialize(body, { fresh });
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

async function handleSearch(
	q: string,
	typeFilter: NodeType | null,
	limit: number,
): Promise<{
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

/**
 * Resolve the best "hero" image for a given node, walking edges when needed.
 *
 * Strategy by type:
 *   - project / track: if the node already has cover_url, return it. Otherwise
 *     query iTunes Search with name + first artist's name; on a hit, persist
 *     the 1500×1500 URL into the cache so subsequent calls are instant.
 *   - track: if iTunes misses, fall back to the parent project's image.
 *   - artist: if photo_url is present, return it. Otherwise borrow from one of
 *     their projects (discography → notable_tracks→project).
 *   - genre: borrow from a landmark project / track.
 *   - label: borrow from a notable release.
 *
 * `visited` guards against pathological cycles in the edge graph (e.g. a track
 * pointing back to itself through a "remix_of" loop). Returns null when no
 * image can be resolved through any path.
 */
async function resolveDisplayImage(
	slug: Slug,
	visited: Set<string>,
): Promise<{ slug: Slug; image_url: string | null; source: string }> {
	if (visited.has(slug)) return { slug, image_url: null, source: "cycle" };
	visited.add(slug);

	const node = await cache.get(slug).catch(() => null);
	if (!node) return { slug, image_url: null, source: "not-cached" };

	// 1) Direct image on the node itself.
	const raw = node as unknown as Record<string, unknown>;
	const directField = node.type === "artist" ? "photo_url" : "cover_url";
	const direct = raw[directField];
	if (typeof direct === "string" && direct) {
		return { slug, image_url: direct, source: "self" };
	}

	// 2) For project/track, try iTunes — and persist any hit to the cache.
	if (node.type === "project" || node.type === "track") {
		const artistRef = (raw.artists as EdgeRef[] | undefined)?.[0];
		const itunes = await lookupAlbumArt(node.name, artistRef?.name);
		if (itunes) {
			try {
				const updated = { ...node, cover_url: itunes } as NodePayload;
				await cache.write(updated);
			} catch (e) {
				// Cache write failures shouldn't break the response — the URL still works.
				process.stderr.write(
					`[image] persist failed for ${slug}: ${e instanceof Error ? e.message : String(e)}\n`,
				);
			}
			return { slug, image_url: itunes, source: "itunes" };
		}
	}

	// 3) Walk edges to borrow an image from a related node.
	const tryEdges = async (
		refs: EdgeRef | EdgeRef[] | undefined,
	): Promise<{ url: string; via: Slug } | null> => {
		if (!refs) return null;
		const list = Array.isArray(refs) ? refs : [refs];
		for (const r of list) {
			const recurse = await resolveDisplayImage(r.slug, visited);
			if (recurse.image_url) return { url: recurse.image_url, via: r.slug };
		}
		return null;
	};

	const edges: Array<EdgeRef | EdgeRef[] | undefined> = (() => {
		switch (node.type) {
			case "track":
				return [raw.project as EdgeRef | undefined];
			case "artist":
				return [raw.discography as EdgeRef[] | undefined, raw.notable_tracks as EdgeRef[] | undefined];
			case "genre":
				return [raw.landmark_projects as EdgeRef[] | undefined, raw.landmark_tracks as EdgeRef[] | undefined];
			case "label":
				return [raw.notable_releases as EdgeRef[] | undefined];
			default:
				return [];
		}
	})();

	for (const e of edges) {
		const hit = await tryEdges(e);
		if (hit) return { slug, image_url: hit.url, source: `related:${hit.via}` };
	}

	return { slug, image_url: null, source: "no-match" };
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

async function handleMaterialize(
	body: MaterializeRequest,
	opts: { fresh?: boolean } = {},
): Promise<MaterializeResponse> {
	if (
		(!body.type || typeof body.type !== "string" || !(NODE_TYPES as readonly string[]).includes(body.type)) &&
		!body.text
	) {
		throw new Error("Provide {type, name} or {text}");
	}
	const t0 = Date.now();
	const fresh = opts.fresh === true;
	// Fast path: if we can canonicalize a target slug right now, check cache first
	// (unless ?fresh=1 was requested — Henry/Raph want a "ctrl+R always re-explores" mode).
	if (body.type && body.name) {
		const slug = makeSlug(body.type as NodePayload["type"], body.name, body.disambiguator);
		let effectiveFresh = fresh;
		if (!fresh) {
			const cached = await cache.get(slug).catch(() => null);
			if (cached) {
				// 12h TTL — same as GET /node/:slug. Goal-2 adversarial caught the bypass on
				// 2026-05-19: a cache hit on /materialize was returning a stale node forever.
				const TTL_MS = 12 * 3600 * 1000;
				const matAt = new Date(cached.materialized_at).getTime();
				const stale = Number.isFinite(matAt) && Date.now() - matAt > TTL_MS;
				// Also re-mat when the caller pinned an MBID and the cached node either has no
				// MBID or a different one — the cached node was materialized via a name-only
				// search and may be the wrong entity (Raph caught 2026-05-19 on Janice STFU:
				// cached pre-fix node had AI-slop article; new click carried mbid but was
				// short-circuited by the cache).
				const cachedMbid = (cached as unknown as { mbid?: string }).mbid;
				const mbidMismatch = !!body.mbid && cachedMbid !== body.mbid;
				if (!stale && !mbidMismatch) {
					return { node: cached, source: "cache", wallMs: Date.now() - t0 };
				}
				// Stale or wrong-entity: force a fresh materialize through the JIT path so the
				// cache write overwrites with the corrected entity.
				effectiveFresh = true;
			}
		}
		const key = `${slug}|${body.disambiguator ?? ""}|fresh=${effectiveFresh}`;
		const existing = inflight.get(key);
		if (existing) {
			const node = await existing;
			return { node, source: "jit", wallMs: Date.now() - t0 };
		}
		const p = runJit(body, { fresh: effectiveFresh });
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
	const node = await runJit(body, { fresh });
	return { node, source: "jit", wallMs: Date.now() - t0 };
}

async function runJit(body: MaterializeRequest, opts: { fresh?: boolean } = {}): Promise<NodePayload> {
	if (!body.type || !body.name) {
		throw new Error("Pipeline JIT requires both 'type' and 'name'. Free-text seeds are not supported here.");
	}
	const pipelineInput: { type: NodeType; name: string; disambiguator?: string; mbid?: string } = {
		type: body.type as NodeType,
		name: body.name,
	};
	if (body.disambiguator) pipelineInput.disambiguator = body.disambiguator;
	if (body.mbid) pipelineInput.mbid = body.mbid;
	const r = await runPipeline(pipelineInput, {
		tavilyApiKey: env.TAVILY_API_KEY,
		firecrawlApiKey: env.FIRECRAWL_API_KEY,
	});
	// Re-check then write atomically through cache (handles parallel JIT for the same slug).
	// When fresh=true the caller explicitly asked for re-materialization (TTL refresh or
	// ?fresh=1 query) — overwrite the cached node with the new payload.
	if (!opts.fresh) {
		const existing = await cache.get(r.slug).catch(() => null);
		if (existing) return existing;
	}
	// Stamp the MBID hint (if any) onto the node payload before persisting. Subsequent
	// /search calls reconcile via cache-index.byMbid so the catalog rail collapses with
	// this node rather than offering it again as "+ generate".
	const enriched = body.mbid ? ({ ...r.node, mbid: body.mbid } as NodePayload) : r.node;
	await cache.write(enriched);
	return enriched;
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
		const facts: Record<string, string> = {};
		for (const field of OPTIONAL_TEXT_FIELDS[n.type]) {
			const v = obj[field];
			if (typeof v === "string" && v.trim()) facts[field] = v;
		}
		vizNodes.push({
			id: n.slug,
			type: n.type,
			name: n.name,
			teaser: typeof teaserVal === "string" ? teaserVal : "",
			article: n.editorial_article,
			citations: n.citations,
			edges: nodeEdges,
			facts,
			materialized_at: n.materialized_at,
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
