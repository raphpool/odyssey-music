/**
 * In-memory search index over the JIT cache.
 *
 * Built at server boot by scanning <cache>/nodes/*.json. Provides two lookups:
 *   - byMbid(mbid)  → Slug | null    (used to short-circuit search results that already
 *                                      have a materialized node, so the autocomplete can
 *                                      render a "✓ Odyssey" badge + direct link)
 *   - prefix(q)     → CacheHit[]      (used to ensure cache-only nodes — bandcamp-only
 *                                      entities with no MBID — still surface in search)
 *
 * Rebuilds are cheap (~1ms per 100 nodes via stat-only listing), but we also rebuild
 * incrementally when NodeCache.write fires. For v1 we just full-rescan on demand.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodePayload, NodeType, Slug } from "./types.js";

export interface CacheHit {
	slug: Slug;
	type: NodeType;
	name: string;
	mbid?: string;
}

export interface CacheIndex {
	byMbid(mbid: string): Slug | null;
	prefix(query: string, limit?: number): CacheHit[];
	prefixByType(type: NodeType, query: string, limit?: number): CacheHit[];
	rebuild(): Promise<void>;
	size(): number;
}

function normalize(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export async function buildCacheIndex(cacheRoot: string): Promise<CacheIndex> {
	const hits: CacheHit[] = [];
	const mbidToSlug = new Map<string, Slug>();

	async function rebuild() {
		hits.length = 0;
		mbidToSlug.clear();
		const nodesDir = join(cacheRoot, "nodes");
		let typeDirs: string[];
		try {
			typeDirs = await readdir(nodesDir);
		} catch {
			return;
		}
		for (const t of typeDirs) {
			let files: string[];
			try {
				files = await readdir(join(nodesDir, t));
			} catch {
				continue;
			}
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				const slug = `${t}:${f.slice(0, -5)}` as Slug;
				try {
					const raw = await readFile(join(nodesDir, t, f), "utf8");
					const node = JSON.parse(raw) as NodePayload & { mbid?: string };
					hits.push({
						slug,
						type: node.type,
						name: node.name,
						mbid: node.mbid,
					});
					if (node.mbid) mbidToSlug.set(node.mbid, slug);
				} catch {
					// skip unreadable / unparseable nodes silently
				}
			}
		}
	}

	await rebuild();

	function prefixMatch(query: string, hit: CacheHit): boolean {
		const n = normalize(hit.name);
		const q = normalize(query);
		if (!q) return false;
		if (n.startsWith(q)) return true;
		// also allow match-at-word-boundary
		return n.includes(` ${q}`);
	}

	return {
		byMbid: (mbid) => mbidToSlug.get(mbid) ?? null,
		prefix(query, limit = 5) {
			const matches: CacheHit[] = [];
			for (const h of hits) {
				if (prefixMatch(query, h)) {
					matches.push(h);
					if (matches.length >= limit * 5) break;
				}
			}
			return matches.slice(0, limit);
		},
		prefixByType(type, query, limit = 5) {
			const matches: CacheHit[] = [];
			for (const h of hits) {
				if (h.type !== type) continue;
				if (prefixMatch(query, h)) {
					matches.push(h);
					if (matches.length >= limit) break;
				}
			}
			return matches;
		},
		rebuild,
		size: () => hits.length,
	};
}
