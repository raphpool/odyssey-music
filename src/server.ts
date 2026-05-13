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
import { type AgentInput, runAgent } from "./agent.js";
import { NodeCache } from "./cache.js";
import { loadEnv } from "./env.js";
import { makeSlug, parseSlug } from "./slug.js";
import type { EdgeRef, NodePayload, Slug } from "./types.js";
import { LIST_EDGES_BY_TYPE, NODE_TYPES, SINGULAR_EDGES_BY_TYPE } from "./types.js";

const PORT = Number.parseInt(process.env.PORT ?? "18791", 10);
const CACHE_DIR = process.env.ODYSSEY_CACHE_DIR ?? join(process.cwd(), "cache");

const env = loadEnv();
const cache = new NodeCache(CACHE_DIR);

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
	if (req.method === "POST" && path === "/materialize") {
		const body = await readJson<MaterializeRequest>(req);
		const result = await handleMaterialize(body);
		json(res, 200, result);
		return;
	}
	json(res, 404, { error: "not found", path });
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
	const input: AgentInput = {};
	if (body.text) input.text = body.text;
	if (body.type) input.type = body.type as NodePayload["type"];
	if (body.name) input.name = body.name;
	if (body.disambiguator) input.disambiguator = body.disambiguator;
	const r = await runAgent(input, {
		tavilyApiKey: env.TAVILY_API_KEY,
		firecrawlApiKey: env.FIRECRAWL_API_KEY,
		fetcher: "local",
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
		for (const [kind, value] of Object.entries(nodeEdges)) {
			const refs = Array.isArray(value) ? value : [value];
			for (const ref of refs) {
				if (!cachedSet.has(ref.slug)) continue;
				edges.push({ source: n.slug, target: ref.slug, kind });
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
