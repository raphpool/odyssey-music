import { EDGE_FIELDS_BY_TYPE, NODE_TYPES, REVERSE_EDGE_PAIRS } from "./node-spec.js";
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
	/**
	 * Whether the reverse field is a list (push) or singular (set if empty). Only "list" reverses are emitted at
	 * runtime (TRA-569): a singular one is declared by the work itself, never derived from another node's list.
	 */
	cardinality: "list" | "single";
}

/**
 * The only cross-type directions that are derived from the other side: the source is a declared CREDIT or
 * MEMBERSHIP and the target is a LIST on an artist or a label (what an artist released, what a label released
 * or signed). Key format: "sourceType.sourceField→targetType.reverseField".
 *
 * Every other cross-type pair of REVERSE_EDGE_PAIRS is NOT emitted (TRA-563, 2026-10-16): since TRA-454 the
 * runtime wrote them all, and the lists of a node (discography, tracklist, genre landmarks, pending entries)
 * still link to namesakes. Writing the artist "Rohff" re-added Rohff to the credits of Akuma's "Fitna", and a
 * pending entry gave Moderat's "II" two Unlimited credits. A credit, a parent (`project`, `label`) or a genre
 * on a work is never copied from the list of another node. The backfill migration (TRA-486, PR #484) keeps
 * the same list and is meant to import it from here, so the two cannot drift.
 */
export const SAFE_BACKFILL_PAIRS: ReadonlySet<string> = new Set([
	"project.artists→artist.discography",
	"track.artists→artist.notable_tracks",
	"project.label→label.notable_releases",
	"artist.labels→label.roster",
]);

export function reversePairKey(
	sourceType: NodeType,
	sourceField: string,
	targetType: NodeType,
	reverseField: string,
): string {
	return `${sourceType}.${sourceField}→${targetType}.${reverseField}`;
}

const REVERSES_BY_TYPE: Record<NodeType, Record<string, ReverseEdgeSpec>> = Object.fromEntries(
	NODE_TYPES.map((type) => [type, {}]),
) as Record<NodeType, Record<string, ReverseEdgeSpec>>;

// "sourceType>targetType.reverseField" of every emitted direction, to judge a pending entry (which does not
// remember the forward field of its source).
const EMITTED_DIRECTIONS = new Set<string>();

for (const pair of REVERSE_EDGE_PAIRS) {
	const targets = (EDGE_FIELDS_BY_TYPE[pair.sourceType] as Record<string, { targets: readonly NodeType[] }>)[
		pair.sourceField
	]?.targets;
	// The safe-pair decision below is made on one target type: a reverse pair on a multi-target field is a spec bug.
	if (targets?.length !== 1 || !targets[0]) {
		throw new Error(
			`REVERSE_EDGE_PAIRS: ${pair.sourceType}.${pair.sourceField} needs exactly one target type`,
		);
	}
	const targetType = targets[0];
	// A singular reverse (a work's `remix_of`, `project`, `label`) is a parent: it is declared by the work itself
	// and never copied from the list of another node (TRA-569, 2026-10-23). `track.remixed_by -> remix_of` was the
	// last one still emitted: writing track:song with `remixed_by: [track:intro]` made track:intro a remix of
	// track:song, the same false-credit class as TRA-563 (same-kind pairs were exempt from its filter).
	if (pair.reverse.cardinality === "single") continue;
	// A list pair between two nodes of the same kind (genre parents, collaborators, samples...) predates TRA-454
	// and is symmetric by construction; a cross-type pair is emitted only when it is in SAFE_BACKFILL_PAIRS.
	const sameKind = targetType === pair.sourceType;
	const key = reversePairKey(pair.sourceType, pair.sourceField, targetType, pair.reverse.field);
	if (!sameKind && !SAFE_BACKFILL_PAIRS.has(key)) continue;
	REVERSES_BY_TYPE[pair.sourceType][pair.sourceField] = pair.reverse;
	EMITTED_DIRECTIONS.add(`${pair.sourceType}>${targetType}.${pair.reverse.field}`);
}

/**
 * Whether a pending reverse entry queued for a node of `targetType` is a direction the runtime still emits.
 * An entry written before TRA-563 may be an unsafe one (a credit on a work from a namesake's list): it must
 * never be applied.
 */
export function isEmittedPendingReverse(
	targetType: NodeType,
	pending: { field: string; edge: { type: string } },
): boolean {
	return EMITTED_DIRECTIONS.has(`${pending.edge.type}>${targetType}.${pending.field}`);
}

export function reverseFor(sourceType: NodeType, sourceField: string): ReverseEdgeSpec | null {
	const map = REVERSES_BY_TYPE[sourceType];
	return map[sourceField] ?? null;
}

/** All forward edge field names that participate in automatic reverse materialization. */
export function reversibleFields(type: NodeType): string[] {
	return Object.keys(REVERSES_BY_TYPE[type]);
}
