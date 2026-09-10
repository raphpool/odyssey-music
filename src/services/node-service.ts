import type { NodeCache } from "../cache.js";
import { pipelineConfig } from "../config.js";
import { isNotFoundError } from "../errors.js";
import type { GenreRedirects } from "../genre-registry.js";
import type { NodePayload, Slug } from "../types.js";
import type { MaterializeRequest } from "./materialize-service.js";

export type NodeLookupResult =
	| { source: "cache"; node: NodePayload }
	| { source: "jit-refreshed"; node: NodePayload }
	| { source: "cache-stale-refresh-failed"; node: NodePayload; refresh_error: string };

export function createNodeService(deps: {
	cache: NodeCache;
	runJit: (body: MaterializeRequest, opts?: { fresh?: boolean }) => Promise<NodePayload>;
	redirects: GenreRedirects;
}) {
	return async function getNode(slug: Slug): Promise<NodeLookupResult | null> {
		// 2026-09-09: after TRA-22's duplicate-merge migration, a redirected slug (e.g.
		// "genre:electronic-music") has no cache node of its own -- a plain cache.get(slug)
		// here would report "not found" even though the materialization path (TRA-28's genre
		// registry) already serves the canonical node for the same identity, leaving GET
		// inconsistent with what gets written. Apply the flattened redirect table only, never
		// the QID index (decision d'archi 9, docs/plans/qid-genre-identity.md): a slug that was
		// never materialized under any identity still resolves to null, since this read path
		// does not materialize on miss. A single hop only -- the table is flattened by
		// construction (parseGenreRedirects), so no loop guard is needed. A slug that already
		// has a live cache node is served as-is even if it also appears as a redirect key
		// (inconsistent state): a live node is never redirected away from itself.
		//
		// deps.redirects.get is checked first because it's an in-memory Map lookup (redirect
		// keys are only ever genre slugs, so this is an immediate miss for every other node
		// type) -- cache.has, a disk read, only runs for the rare slug that's actually a
		// redirect key, instead of on every single request.
		let lookupSlug = slug;
		const redirected = deps.redirects.get(slug);
		if (redirected && !(await deps.cache.has(slug))) {
			lookupSlug = redirected;
		}
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
				const fresh = await deps.runJit(req, { fresh: true });
				return { source: "jit-refreshed", node: fresh };
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { source: "cache-stale-refresh-failed", node, refresh_error: msg.slice(0, 200) };
			}
		}
		return { source: "cache", node };
	};
}
