import type { NodeCache } from "../cache.js";
import { pipelineConfig } from "../config.js";
import type { ApiEnv } from "../env.js";
import { BadRequestError, isNotFoundError } from "../errors.js";
import type { GenreRegistry } from "../genre-registry.js";
import { runPipeline } from "../pipeline.js";
import { makeSlug } from "../slug.js";
import type { NodePayload, NodeType } from "../types.js";
import { NODE_TYPES } from "../types.js";

export interface MaterializeRequest {
	type?: string;
	name?: string;
	disambiguator?: string;
	mbid?: string;
}

export interface MaterializeResponse {
	// The reference value for the client is `node.slug`, not `makeSlug(body)` on the original
	// request: the genre canonicalization guard in handleMaterialize can rewrite a request onto
	// an existing canonical node, so the returned node's own slug may differ from what the
	// caller's {type, name} would hash to.
	node: NodePayload;
	source: "cache" | "jit";
	wallMs: number;
	metricsCostUsd?: number;
}

export function createMaterializeService(deps: {
	cache: NodeCache;
	env: ApiEnv;
	genreRegistry: GenreRegistry;
}) {
	const inflight = new Map<string, Promise<NodePayload>>();

	async function handleMaterialize(
		body: MaterializeRequest,
		opts: { fresh?: boolean } = {},
	): Promise<MaterializeResponse> {
		if (
			!body.type ||
			typeof body.type !== "string" ||
			!(NODE_TYPES as readonly string[]).includes(body.type)
		) {
			throw new BadRequestError("Provide {type, name}");
		}
		if (!body.name || typeof body.name !== "string") {
			throw new BadRequestError("Provide {type, name}");
		}
		const t0 = Date.now();
		const fresh = opts.fresh === true;
		let effectiveBody = body;
		let slug = makeSlug(body.type as NodePayload["type"], body.name, body.disambiguator);

		// 2026-09-09: after TRA-22's duplicate-merge migration, a genre chip whose display name
		// survives edge rewriting (e.g. a "Electronic music" chip after the "electronic-music"
		// node was merged into "electronic") still hashes to the loser's slug and would otherwise
		// re-mint the very duplicate the migration just removed. Before minting a genre, ask the
		// registry for the canonical slug; if a cache node already exists there, rewrite the
		// request onto it instead of minting a new one (decision d'archi 9).
		if (body.type === "genre" && !(await deps.cache.has(slug))) {
			const canonical = await deps.genreRegistry.canonicalSlugFor({ slug, name: body.name });
			if (canonical.slug !== slug && (await deps.cache.has(canonical.slug))) {
				const canonicalNode = await deps.cache.get(canonical.slug);
				effectiveBody = { type: "genre", name: canonicalNode.name };
				slug = canonical.slug;
			}
		}

		let effectiveFresh = fresh;
		if (!fresh) {
			const cached = await deps.cache.get(slug).catch((e: unknown) => {
				if (isNotFoundError(e)) return null;
				throw e;
			});
			if (cached) {
				const matAt = new Date(cached.materialized_at).getTime();
				const stale = Number.isFinite(matAt) && Date.now() - matAt > pipelineConfig.nodeTtlMs;
				const cachedMbid = (cached as unknown as { mbid?: string }).mbid;
				const mbidMismatch = !!effectiveBody.mbid && cachedMbid !== effectiveBody.mbid;
				if (!stale && !mbidMismatch) {
					return { node: cached, source: "cache", wallMs: Date.now() - t0 };
				}
				effectiveFresh = true;
			}
		}
		const key = `${slug}|${effectiveBody.disambiguator ?? ""}|fresh=${effectiveFresh}`;
		const existing = inflight.get(key);
		if (existing) {
			const node = await existing;
			return { node, source: "jit", wallMs: Date.now() - t0 };
		}
		const p = runJit(effectiveBody, { fresh: effectiveFresh });
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

	async function runJit(body: MaterializeRequest, opts: { fresh?: boolean } = {}): Promise<NodePayload> {
		if (!body.type || !body.name) {
			throw new BadRequestError("Pipeline JIT requires both 'type' and 'name'.");
		}
		const pipelineInput: { type: NodeType; name: string; disambiguator?: string; mbid?: string } = {
			type: body.type as NodeType,
			name: body.name,
		};
		if (body.disambiguator) pipelineInput.disambiguator = body.disambiguator;
		if (body.mbid) pipelineInput.mbid = body.mbid;
		const r = await runPipeline(pipelineInput, {
			tavilyApiKey: deps.env.TAVILY_API_KEY,
			firecrawlApiKey: deps.env.FIRECRAWL_API_KEY,
			genreRegistry: deps.genreRegistry,
		});
		if (!opts.fresh) {
			const existing = await deps.cache.get(r.slug).catch((e: unknown) => {
				if (isNotFoundError(e)) return null;
				throw e;
			});
			if (existing) return existing;
		}
		const enriched = body.mbid ? ({ ...r.node, mbid: body.mbid } as NodePayload) : r.node;
		await deps.cache.write(enriched);
		return enriched;
	}

	return { handleMaterialize, runJit };
}
