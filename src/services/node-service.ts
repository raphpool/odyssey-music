import type { NodeCache } from "../cache.js";
import { pipelineConfig } from "../config.js";
import { isNotFoundError } from "../errors.js";
import { type GenreRedirects, resolveReadSlug } from "../genre-registry.js";
import type { NodePayload, Slug } from "../types.js";
import type { MaterializeRequest } from "./materialize-service.js";

export type NodeLookupResult =
	| { source: "cache"; node: NodePayload; redirected_from?: Slug }
	| { source: "jit-refreshed"; node: NodePayload; redirected_from?: Slug }
	| {
			source: "cache-stale-refresh-failed";
			node: NodePayload;
			refresh_error: string;
			redirected_from?: Slug;
	  };

export function createNodeService(deps: {
	cache: NodeCache;
	runJit: (body: MaterializeRequest, opts?: { fresh?: boolean; slug?: Slug }) => Promise<NodePayload>;
	redirects: GenreRedirects;
}) {
	return async function getNode(slug: Slug): Promise<NodeLookupResult | null> {
		// 2026-09-09: after TRA-22's duplicate-merge migration, a redirected slug (e.g.
		// "genre:electronic-music") has no cache node of its own -- a plain cache.get(slug)
		// here would report "not found" even though the materialization path (TRA-29's
		// materialize guard) already serves the canonical node for the same identity, leaving
		// GET inconsistent with what gets written. resolveReadSlug (TRA-39: extracted here so
		// image-service and server.ts's handleLinks share the same rule) applies the flattened
		// redirect table only, never the QID index (decision d'archi 9,
		// docs/plans/qid-genre-identity.md) -- see its docstring for the full rule.
		const lookupSlug = await resolveReadSlug(slug, deps.redirects, deps.cache);
		// 2026-09-10 (review round 1, PR #31): the client needs to know when the served node
		// isn't the one it asked for, to navigate using the response's own slug (node.slug)
		// instead of the stale one it requested (see TRA-38) -- exposed here, the only place
		// that knows both slugs, rather than reconstructed by every caller.
		const redirectInfo = lookupSlug !== slug ? { redirected_from: slug } : {};
		const node = await deps.cache.get(lookupSlug).catch((e: unknown) => {
			if (isNotFoundError(e)) return null;
			throw e;
		});
		if (!node) return null;
		const matAt = new Date(node.materialized_at).getTime();
		if (Number.isFinite(matAt) && Date.now() - matAt > pipelineConfig.nodeTtlMs) {
			try {
				const req: MaterializeRequest = { type: node.type, name: node.name };
				const dis = (node as unknown as Record<string, unknown>).disambiguator;
				if (typeof dis === "string" && dis) req.disambiguator = dis;
				// 2026-09-10 (review round 1, PR #31): pin the refreshed materialization to
				// lookupSlug. Without this, runJit/canonicalizeDraft re-derives a slug from the
				// LLM draft's own name, which can silently mint (or resurrect) the losing slug
				// of a genre redirect -- e.g. a stale "genre:idm" cache entry named "Intelligent
				// Dance Music" refreshes and gets re-derived back onto
				// "genre:intelligent-dance-music", the exact slug the redirect table maps away
				// from -- permanently breaking that redirect the next time cache.has(slug) finds
				// the resurrected node. Not genre-specific: any TTL refresh of a node whose
				// stored slug disagrees with a fresh name-derived slug is exposed to the same
				// bug (62 such nodes exist in the real cache today). opts.slug is honored by
				// materialize-service's runJit as of TRA-29 (PR #30); until that merges, this
				// is a structurally-typed no-op against main's runJit.
				const fresh = await deps.runJit(req, { fresh: true, slug: lookupSlug });
				return { source: "jit-refreshed", node: fresh, ...redirectInfo };
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					source: "cache-stale-refresh-failed",
					node,
					refresh_error: msg.slice(0, 200),
					...redirectInfo,
				};
			}
		}
		return { source: "cache", node, ...redirectInfo };
	};
}
