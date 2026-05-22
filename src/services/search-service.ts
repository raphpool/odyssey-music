import type { CacheIndex } from "../cache-index.js";
import type { CatalogIndex, CatalogResult } from "../musicbrainz.js";
import type { NodeType, Slug } from "../types.js";

export interface SearchHit {
	source: "cache" | "catalog";
	type: NodeType;
	name: string;
	subtitle?: string;
	extra?: string;
	mbid?: string;
	slug?: Slug;
}

export interface SearchResult {
	q: string;
	hits: SearchHit[];
	sources: { cache: number; catalog: number };
}

export function createSearchService(deps: {
	getCacheIndex: () => Promise<CacheIndex>;
	catalogIndex: CatalogIndex;
}) {
	return async function handleSearch(
		q: string,
		typeFilter: NodeType | null,
		limit: number,
	): Promise<SearchResult> {
		if (!q || q.length < 2) {
			return { q, hits: [], sources: { cache: 0, catalog: 0 } };
		}
		const idx = await deps.getCacheIndex();
		const cacheHits = typeFilter ? idx.prefixByType(typeFilter, q, limit) : idx.prefix(q, limit);
		const mbidsSeen = new Set<string>();
		const out: SearchHit[] = [];
		for (const h of cacheHits) {
			const hit: SearchHit = { source: "cache", type: h.type, name: h.name, slug: h.slug };
			if (h.mbid) hit.mbid = h.mbid;
			out.push(hit);
			if (h.mbid) mbidsSeen.add(h.mbid);
		}

		if (!typeFilter || typeFilter === "artist" || typeFilter === "project" || typeFilter === "track") {
			const catRaw: CatalogResult[] = typeFilter
				? await deps.catalogIndex.searchByType(typeFilter, q, limit)
				: await deps.catalogIndex.search(q, Math.max(2, Math.floor(limit / 2)));
			for (const c of catRaw) {
				if (mbidsSeen.has(c.mbid)) continue;
				const slug = idx.byMbid(c.mbid);
				if (slug) {
					out.push({ source: "cache", type: c.type, name: c.name, subtitle: c.subtitle, slug, mbid: c.mbid });
					mbidsSeen.add(c.mbid);
					continue;
				}
				const hit: SearchHit = {
					source: "catalog",
					type: c.type,
					name: c.name,
					mbid: c.mbid,
				};
				if (c.subtitle) hit.subtitle = c.subtitle;
				if (c.extra) hit.extra = c.extra;
				out.push(hit);
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
	};
}
