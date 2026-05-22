import { NODE_TYPES, REVERSE_EDGE_PAIRS } from "./node-spec.js";
import type { NodeType } from "./types.js";

/**
 * For a forward edge field on a given node type, return the reverse edge to apply on the *target* node.
 *
 * If a write of node A says "edge X = [B]", then on node B we should add A to the field returned here.
 *
 * Returning `null` means the edge has no automatic reverse.
 */
export interface ReverseEdgeSpec {
	field: string;
	/** Whether the reverse field is a list (push) or singular (overwrite if empty). */
	cardinality: "list" | "single";
}

const REVERSES_BY_TYPE: Record<NodeType, Record<string, ReverseEdgeSpec>> = Object.fromEntries(
	NODE_TYPES.map((type) => [type, {}]),
) as Record<NodeType, Record<string, ReverseEdgeSpec>>;

for (const pair of REVERSE_EDGE_PAIRS) {
	REVERSES_BY_TYPE[pair.sourceType][pair.sourceField] = pair.reverse;
}

export function reverseFor(sourceType: NodeType, sourceField: string): ReverseEdgeSpec | null {
	const map = REVERSES_BY_TYPE[sourceType];
	return map[sourceField] ?? null;
}

/** All forward edge field names that participate in automatic reverse materialization. */
export function reversibleFields(type: NodeType): string[] {
	return Object.keys(REVERSES_BY_TYPE[type]);
}

/**
 * Viz-output node shape (matches build-graph-json.ts + server.ts buildGraph).
 * Inline here to avoid a circular import.
 */
interface VizNodeLike {
	id: string;
	type: NodeType;
	name: string;
	edges: Record<string, EdgeRefLike[] | EdgeRefLike>;
}
interface EdgeRefLike {
	slug: string;
	type: string;
	name: string;
}

/**
 * Back-fill missing reverse genre↔genre edges directly on the viz nodes.
 *
 * Many genre nodes were scraped before genre reverses were configured, so
 * e.g. `minimal-techno` has 8 incoming references from other genres but its
 * own parent_genres / subgenres / related_genres are empty — the lab page
 * displays it as isolated. This mutates the passed nodes to add the missing
 * back-pointers using the forward edges declared on other genre nodes.
 *
 * Safe to call on already-correct graphs: duplicates are skipped.
 */
export function backfillGenreReverses(nodes: VizNodeLike[]): void {
	const byId = new Map<string, VizNodeLike>();
	for (const n of nodes) byId.set(n.id, n);
	const ensureList = (n: VizNodeLike, field: string): EdgeRefLike[] => {
		const existing = n.edges[field];
		if (Array.isArray(existing)) return existing;
		const fresh: EdgeRefLike[] = [];
		n.edges[field] = fresh;
		return fresh;
	};
	const addRefIfMissing = (list: EdgeRefLike[], ref: EdgeRefLike): void => {
		if (!list.some((r) => r.slug === ref.slug)) list.push(ref);
	};
	for (const n of nodes) {
		if (n.type !== "genre") continue;
		const self: EdgeRefLike = { slug: n.id, type: "genre", name: n.name };
		const parents = (n.edges.parent_genres as EdgeRefLike[] | undefined) ?? [];
		const subs = (n.edges.subgenres as EdgeRefLike[] | undefined) ?? [];
		const related = (n.edges.related_genres as EdgeRefLike[] | undefined) ?? [];
		for (const p of parents) {
			const t = byId.get(p.slug);
			if (t?.type === "genre") addRefIfMissing(ensureList(t, "subgenres"), self);
		}
		for (const s of subs) {
			const t = byId.get(s.slug);
			if (t?.type === "genre") addRefIfMissing(ensureList(t, "parent_genres"), self);
		}
		for (const r of related) {
			const t = byId.get(r.slug);
			if (t?.type === "genre") addRefIfMissing(ensureList(t, "related_genres"), self);
		}
	}
}
