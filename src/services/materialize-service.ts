import type { NodeCache } from "../cache.js";
import { pipelineConfig } from "../config.js";
import type { ApiEnv } from "../env.js";
import { BadRequestError, isNotFoundError } from "../errors.js";
import type { GenreRegistry } from "../genre-registry.js";
import { runPipeline } from "../pipeline.js";
import { makeSlug } from "../slug.js";
import type { NodePayload, NodeType, Slug } from "../types.js";
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
		// Set only when `slug` above is known to already name an existing cache node that this
		// call is about to refresh (canonical rewrite, or the cache lookup below finding it,
		// whether or not `fresh` was requested) -- never on a genuinely fresh mint. Passed through
		// to runPipeline as PipelineInput.slug so canonicalizeDraft (pipeline.ts) keeps that exact
		// slug instead of re-deriving one from whatever name the LLM draft happens to use, which
		// can legitimately differ from the node's own persisted name (2026-09-10, review round 2 /
		// TRA-30 review: 62 real cache nodes already have makeSlug(name) !== slug). A fresh mint
		// keeps deriving its own slug from the draft, same as before this ticket -- the draft is
		// the one place that gets to decide a brand new node's identity.
		let pinnedSlug: Slug | undefined;

		// 2026-09-09: after TRA-22's duplicate-merge migration, a genre chip whose display name
		// survives edge rewriting (e.g. a "Electronic music" chip after the "electronic-music"
		// node was merged into "electronic") still hashes to the loser's slug and would otherwise
		// re-mint the very duplicate the migration just removed. Before minting a genre, ask the
		// registry for the canonical slug; if a cache node already exists there, rewrite the
		// request onto it instead of minting a new one (decision d'archi 9).
		//
		// 2026-09-10 (review round 2): skipped entirely when a disambiguator is present -- a
		// disambiguator exists precisely to force a distinct node (slug.ts), but
		// canonicalSlugFor's resolver lookup is name-only and would otherwise happily merge
		// {name: "Trap", disambiguator: "EDM"} onto the unrelated existing "genre:trap" (hip-hop)
		// the moment their names resolve to the same qid.
		if (body.type === "genre" && !body.disambiguator && !(await deps.cache.has(slug))) {
			const canonical = await deps.genreRegistry.canonicalSlugFor({ slug, name: body.name });
			if (canonical.slug !== slug) {
				// Single read, not has()+get(): the registry can name a slug that isn't actually on
				// disk (e.g. a fresh deployment with a pruned cache) -- ENOENT there means "nothing
				// to serve", so fall through and mint under the originally requested slug, same as
				// if canonicalSlugFor had returned it unchanged. Any other read failure still throws.
				const canonicalNode = await deps.cache.get(canonical.slug).catch((e: unknown) => {
					if (isNotFoundError(e)) return null;
					throw e;
				});
				if (canonicalNode) {
					// Spread `body`, not a fresh {type, name} literal, so mbid/disambiguator survive
					// the rewrite (mbidMismatch below, and the write in runJit, both need it).
					effectiveBody = { ...body, name: canonicalNode.name };
					slug = canonical.slug;
					pinnedSlug = canonical.slug;
				}
			}
		}

		// 2026-09-10 (review round 2, nit): read once regardless of `fresh` -- opts.fresh === true
		// (?fresh=1, server.ts) used to skip this whole block, so a request for an ALREADY-cached
		// slug with fresh:true never set pinnedSlug: the loser name was protected by the guard
		// above, but the canonical name wasn't, once fresh:true was in play. A node found here is
		// always the one this call is about to refresh, fresh or not.
		const cached = await deps.cache.get(slug).catch((e: unknown) => {
			if (isNotFoundError(e)) return null;
			throw e;
		});
		if (cached) pinnedSlug = slug;
		let effectiveFresh = fresh;
		if (!fresh && cached) {
			const matAt = new Date(cached.materialized_at).getTime();
			const stale = Number.isFinite(matAt) && Date.now() - matAt > pipelineConfig.nodeTtlMs;
			const cachedMbid = (cached as unknown as { mbid?: string }).mbid;
			const mbidMismatch = !!effectiveBody.mbid && cachedMbid !== effectiveBody.mbid;
			if (!stale && !mbidMismatch) {
				return { node: cached, source: "cache", wallMs: Date.now() - t0 };
			}
			effectiveFresh = true;
		}
		const key = `${slug}|${effectiveBody.disambiguator ?? ""}|fresh=${effectiveFresh}`;
		const existing = inflight.get(key);
		if (existing) {
			const node = await existing;
			return { node, source: "jit", wallMs: Date.now() - t0 };
		}
		const jitOpts: { fresh?: boolean; slug?: Slug } = { fresh: effectiveFresh };
		if (pinnedSlug) jitOpts.slug = pinnedSlug;
		const p = runJit(effectiveBody, jitOpts);
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

	async function runJit(
		body: MaterializeRequest,
		opts: { fresh?: boolean; slug?: Slug } = {},
	): Promise<NodePayload> {
		if (!body.type || !body.name) {
			throw new BadRequestError("Pipeline JIT requires both 'type' and 'name'.");
		}
		const pipelineInput: {
			type: NodeType;
			name: string;
			disambiguator?: string;
			mbid?: string;
			slug?: Slug;
		} = {
			type: body.type as NodeType,
			name: body.name,
		};
		if (body.disambiguator) pipelineInput.disambiguator = body.disambiguator;
		if (body.mbid) pipelineInput.mbid = body.mbid;
		// TRA-30 (node-service, PR #31) will pass its own opts.slug after this ticket merges --
		// keep this shape stable (see the pinnedSlug comment in handleMaterialize above).
		if (opts.slug) pipelineInput.slug = opts.slug;
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
