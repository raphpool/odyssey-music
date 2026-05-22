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
