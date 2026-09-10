/**
 * Pure logic for merging genre nodes that share a Wikidata QID into one canonical node.
 *
 * Background: TRA-14's report:genre-dupes showed that genre nodes materialized under
 * different names for the same real-world genre (e.g. "Electronic" / "Electronic music")
 * end up as two nodes sharing one `qid`, splitting that genre's content across both.
 *
 * This module decides, for a group of nodes sharing a `qid`:
 *   1. Which one is canonical: the most incoming usages wins outright; at a tie, the node
 *      whose name matches the Wikidata catalog name for that QID; else the shortest slug;
 *      else lexicographic slug order. (2026-09-10: usages moved ahead of catalog name --
 *      catalog-name-first would have deleted 9 of the 10 ONBOARDING_GENRES slugs it shares
 *      a QID with, e.g. "electronic" losing to "electronic-music" despite 179 vs 61 usages.
 *      TRA-41's script verifies as an invariant that no ONBOARDING_GENRES slug is deleted.)
 *   2. How to union the winner's and losers' edges field by field, deduplicated by slug
 *      (the canonical's own edges first). Editorial prose is kept as the canonical's, as-is.
 *   3. How to rewrite an edge.slug pointing at a loser to the canonical, deduplicating the
 *      affected field afterwards -- used both for arbitrary cache nodes and for
 *      pending-reverses.json entries.
 *   4. How to fold loser -> canonical pairs into a redirect table: append-only, with any
 *      redirect chain flattened so no stored value is itself a stored key.
 *
 * No I/O, no CLI, no file deletion here -- that's TRA-41 (CLI, disk application, report),
 * built on top of these functions in this same file.
 */
import type { PendingReverse } from "../../src/cache.js";
import { normalizeGenreName } from "../../src/genre-identity.js";
import {
	LIST_EDGES_BY_TYPE,
	NODE_TYPES,
	type NodeType,
	SINGULAR_EDGES_BY_TYPE,
} from "../../src/node-spec.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

function compareLex(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// --- Election (pure) ---

export type ElectionCriterion = "usage-count" | "catalog-name" | "slug-length" | "slug-lex-order";

export interface ElectionCandidate {
	slug: string;
	name: string;
	usages: number;
}

export interface ElectionResult {
	winner: ElectionCandidate;
	losers: ElectionCandidate[];
	criterion: ElectionCriterion;
}

/**
 * Elects the canonical member of a QID group: most incoming usages wins outright; at a tie,
 * the node whose name matches the Wikidata catalog name for the QID; else shortest slug;
 * else lexicographic order. Order-independent -- the same group, in any order, always
 * elects the same winner. Usages first (2026-09-10, reversed from catalog-name-first): see
 * the header comment for why.
 */
export function electCanonical(
	members: readonly ElectionCandidate[],
	catalogName: string | undefined,
): ElectionResult {
	if (members.length === 0) throw new Error("electCanonical: empty group");

	const maxUsage = Math.max(...members.map((m) => m.usages));
	const byUsage = members.filter((m) => m.usages === maxUsage);

	let winner: ElectionCandidate;
	let criterion: ElectionCriterion;
	if (byUsage.length === 1) {
		winner = byUsage[0] as ElectionCandidate;
		criterion = "usage-count";
	} else {
		const byName = catalogName
			? byUsage.filter((m) => normalizeGenreName(m.name) === normalizeGenreName(catalogName))
			: [];
		if (byName.length === 1) {
			winner = byName[0] as ElectionCandidate;
			criterion = "catalog-name";
		} else {
			const pool = byName.length > 1 ? byName : byUsage;
			const minLength = Math.min(...pool.map((m) => m.slug.length));
			const byLength = pool.filter((m) => m.slug.length === minLength);
			winner = [...byLength].sort((a, b) => compareLex(a.slug, b.slug))[0] as ElectionCandidate;
			criterion = byLength.length === 1 ? "slug-length" : "slug-lex-order";
		}
	}

	return { winner, losers: members.filter((m) => m.slug !== winner.slug), criterion };
}

// --- Edge union (pure) ---

/** First occurrence wins, starting with the canonical's own list, deduplicated by slug. */
export function unionListField(
	canonicalList: readonly unknown[],
	loserLists: readonly (readonly unknown[])[],
): unknown[] {
	const seen = new Set<string>();
	const merged: unknown[] = [];
	for (const edge of [canonicalList, ...loserLists].flat()) {
		const slug = isRecord(edge) && typeof edge.slug === "string" ? edge.slug : undefined;
		// An edge without a string slug is kept as-is (consistent with rewriteNodeEdges's
		// dedupe below) -- only slug-bearing edges participate in the dedupe-by-slug.
		if (slug !== undefined) {
			if (seen.has(slug)) continue;
			seen.add(slug);
		}
		merged.push(edge);
	}
	return merged;
}

/** The canonical's value wins when present; otherwise the first non-empty loser value. */
export function unionSingularField(canonicalValue: unknown, loserValues: readonly unknown[]): unknown {
	return canonicalValue ?? loserValues.find((v) => v != null) ?? canonicalValue;
}

/**
 * Merges every genre edge field of the losers into the canonical node. Everything else --
 * editorial prose included -- is left as-is: edges are unioned, prose is never merged. A
 * loser's edge pointing at the canonical itself (a real case: two duplicates commonly link
 * to each other as "related") would otherwise survive the union as a self-loop -- dropped
 * here, from list fields by filtering and from a singular field by clearing it to undefined.
 */
export function mergeGenreEdges(
	canonical: Record<string, unknown>,
	losers: readonly Record<string, unknown>[],
): Record<string, unknown> {
	const ownSlug = typeof canonical.slug === "string" ? canonical.slug : undefined;
	const merged: Record<string, unknown> = { ...canonical };
	for (const field of LIST_EDGES_BY_TYPE.genre) {
		const canonicalList = Array.isArray(canonical[field]) ? (canonical[field] as unknown[]) : [];
		const loserLists = losers.map((l) => (Array.isArray(l[field]) ? (l[field] as unknown[]) : []));
		merged[field] = unionListField(canonicalList, loserLists).filter(
			(r) => !(isRecord(r) && r.slug === ownSlug),
		);
	}
	for (const field of SINGULAR_EDGES_BY_TYPE.genre) {
		const value = unionSingularField(
			canonical[field],
			losers.map((l) => l[field]),
		);
		merged[field] = isRecord(value) && value.slug === ownSlug ? undefined : value;
	}
	return merged;
}

// --- Cache-wide incoming edge rewrite (pure) ---

/**
 * Rewrites every edge on `node` whose slug is a key of `rewriteMap` to point at its mapped
 * value, deduplicating list fields afterwards by slug. Returns which loser slugs were
 * actually redirected (and how many times), for reporting. A rewrite can turn an edge into
 * a self-loop (node itself referenced a loser that redirects back to node's own slug) --
 * dropped from list fields by filtering, from a singular field by clearing it to undefined.
 */
export function rewriteNodeEdges(
	node: Record<string, unknown>,
	type: NodeType,
	rewriteMap: ReadonlyMap<string, string>,
): { node: Record<string, unknown>; hits: Map<string, number> } {
	const hits = new Map<string, number>();
	const ownSlug = typeof node.slug === "string" ? node.slug : undefined;
	const rewriteRef = (edge: unknown): unknown => {
		const slug = isRecord(edge) && typeof edge.slug === "string" ? edge.slug : undefined;
		const next = slug ? rewriteMap.get(slug) : undefined;
		if (next) hits.set(slug as string, (hits.get(slug as string) ?? 0) + 1);
		return next ? { ...(edge as Record<string, unknown>), slug: next } : edge;
	};

	const next: Record<string, unknown> = { ...node };
	for (const field of LIST_EDGES_BY_TYPE[type]) {
		const list = node[field];
		if (!Array.isArray(list)) continue;
		const seen = new Set<string>();
		next[field] = list.map(rewriteRef).filter((edge) => {
			const slug = isRecord(edge) && typeof edge.slug === "string" ? edge.slug : undefined;
			if (slug === undefined) return true;
			if (slug === ownSlug || seen.has(slug)) return false;
			seen.add(slug);
			return true;
		});
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[type]) {
		const value = node[field];
		if (!isRecord(value) || typeof value.slug !== "string") continue;
		const rewritten = rewriteRef(value);
		next[field] = isRecord(rewritten) && rewritten.slug === ownSlug ? undefined : rewritten;
	}

	return { node: next, hits };
}

// --- Redirect table (pure) ---

/**
 * Combines an existing redirect table with this run's new loser -> canonical pairs,
 * flattening chains (a -> b, then b -> c, becomes a -> c and b -> c) so no stored value is
 * ever also a stored key. Append-only: existing keys are never dropped. Keys sorted.
 */
export function mergeRedirects(
	existing: Readonly<Record<string, string>>,
	additions: Readonly<Record<string, string>>,
): Record<string, string> {
	const combined: Record<string, string> = { ...existing, ...additions };
	const finalTarget = (start: string): string => {
		let current = start;
		const seen = new Set<string>();
		while (combined[current] !== undefined) {
			if (seen.has(current)) throw new Error(`redirect cycle detected at ${current}`);
			seen.add(current);
			current = combined[current] as string;
		}
		return current;
	};

	const flattened: Record<string, string> = {};
	for (const key of Object.keys(combined).sort(compareLex)) {
		flattened[key] = finalTarget(combined[key] as string);
	}
	return flattened;
}

/** Rewrites pending-reverses.json the same way: keys and edge.slug values alike. */
export function rewritePendingReverses(
	pending: Readonly<Record<string, PendingReverse[]>>,
	rewriteMap: ReadonlyMap<string, string>,
): { result: Record<string, PendingReverse[]>; changed: boolean } {
	const result: Record<string, PendingReverse[]> = {};
	let changed = false;
	for (const [key, list] of Object.entries(pending)) {
		const canonicalKey = rewriteMap.get(key) ?? key;
		if (canonicalKey !== key) changed = true;
		const rewrittenList = list.map((pr) => {
			const target = rewriteMap.get(pr.edge.slug);
			if (!target) return pr;
			changed = true;
			return { ...pr, edge: { ...pr.edge, slug: target as PendingReverse["edge"]["slug"] } };
		});
		result[canonicalKey] = [...(result[canonicalKey] ?? []), ...rewrittenList];
	}
	return { result, changed };
}
