import type { NodeCache } from "../cache.js";
import { isNotFoundError } from "../errors.js";
import { type GenreRedirects, resolveReadSlug } from "../genre-registry.js";
import type { NodePayload, Slug } from "../types.js";
import type { MaterializeRequest } from "./materialize-service.js";

// 2026-11-23 (TRA-822): the web client stays in English (plan track1-contenu-fr, D5), but both web routes
// (GET /node/:slug, POST /materialize) used to hand the raw node back, so `l10n` -- the French text and its
// provenance (source_sha256, model, translated_at), stale ones included -- reached it. The key is dropped
// from the response only: the node on disk keeps its block, and the mobile API serves `l10n.fr` itself.
// A node without `l10n` is returned as is, same object and same key order.
export function withoutL10n(node: NodePayload): NodePayload {
	if (!("l10n" in node)) return node;
	const { l10n: _l10n, ...rest } = node;
	return rest;
}

export type NodeLookupResult = { source: "cache"; node: NodePayload; redirected_from?: Slug };

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
		// 2026-10-14 (TRA-449): reading never re-materializes. This used to re-run the whole pipeline
		// for any node whose materialized_at was older than a 12 h TTL. Symptom: prod silently
		// diverged from the repo (62 nodes whose slug can't be derived from their name were rewritten
		// on read), edges were re-emitted bare, and every old page view cost an LLM call. A refresh
		// is now explicit only (`?fresh=1`, see server.ts); `runJit` stays in deps for other paths.
		return { source: "cache", node, ...redirectInfo };
	};
}
