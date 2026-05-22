import type { NodeCache } from "../cache.js";
import { pipelineConfig } from "../config.js";
import { isNotFoundError } from "../errors.js";
import type { NodePayload, Slug } from "../types.js";
import type { MaterializeRequest } from "./materialize-service.js";

export type NodeLookupResult =
	| { source: "cache"; node: NodePayload }
	| { source: "jit-refreshed"; node: NodePayload }
	| { source: "cache-stale-refresh-failed"; node: NodePayload; refresh_error: string };

export function createNodeService(deps: {
	cache: NodeCache;
	runJit: (body: MaterializeRequest, opts?: { fresh?: boolean }) => Promise<NodePayload>;
}) {
	return async function getNode(slug: Slug): Promise<NodeLookupResult | null> {
		const node = await deps.cache.get(slug).catch((e: unknown) => {
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
