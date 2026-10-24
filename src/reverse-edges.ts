import { z } from "zod";
import { EDGE_FIELDS_BY_TYPE, NODE_TYPES, REVERSE_EDGE_PAIRS } from "./node-spec.js";
import type { EdgeRef, NodeType } from "./types.js";

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
 * Whether `NodeCache.write` emits the reverse of `sourceType.sourceField` into `reverseField`: the one source of
 * truth for "this pair can be missing, so it is capped" (TRA-567). A declared pair of REVERSE_EDGE_PAIRS that is
 * not emitted is only measured by the integrity audit, never capped. A source field has one target type (checked
 * above), so the target type is not needed.
 */
export function isEmittedReversePair(
	sourceType: NodeType,
	sourceField: string,
	reverseField: string,
): boolean {
	return REVERSES_BY_TYPE[sourceType][sourceField]?.field === reverseField;
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

/** What `reverseEdgeFor` reads of a source node: a typed payload (runtime) or a raw cache file (backfill). */
export interface ReverseSource {
	slug: string;
	type: NodeType;
	name?: unknown;
	qid?: unknown;
	mbid?: unknown;
	artists?: unknown;
}

// Same rule as `mbid` on an edge in src/schemas.ts (not exported there): the mbid of an edge is a uuid; an edge carrying anything else would make the
// node that receives it unwritable, so a malformed source mbid is left off the edge.
const edgeMbid = z.string().uuid();

/**
 * The only reverse field that carries the source's mbid: a project's id on its credited artist's discography
 * (TRA-623, 2026-10-19). That edge was counted "without mbid" by the audit ratchet although the project node
 * already knew its id. Every other pair stays without one.
 */
const MBID_REVERSE_FIELD = "discography";

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The edge `source` becomes on the node a reverse lands on, in `reverseField`. The single builder for the
 * runtime (NodeCache.emitReverses) and the backfill (2026-10-17-backfill-reverse-edges), so the two emit the
 * same edge for the same pair (TRA-624, 2026-10-24: the backfill built its own and did not carry the mbid,
 * while the runtime did not carry the primary credit the backfill added).
 * - always: slug, type, name;
 * - a genre's qid (TRA-18);
 * - the primary credit of a work (`artists[0].name`), the scope of its slug, which the identity migrations
 *   use to repoint an edge;
 * - a project's mbid, toward `artist.discography` only.
 * Returns null when the source has no name: there is nothing to show on the reverse.
 */
export function reverseEdgeFor(source: ReverseSource, reverseField: string): EdgeRef | null {
	const name = nonEmptyString(source.name);
	if (!name) return null;
	const edge: EdgeRef = { slug: source.slug as EdgeRef["slug"], type: source.type, name };
	if (source.type === "genre") {
		const qid = nonEmptyString(source.qid);
		if (qid) edge.qid = qid;
	}
	if (source.type === "project" || source.type === "track") {
		const first = Array.isArray(source.artists)
			? (source.artists[0] as { name?: unknown } | undefined)
			: undefined;
		const artist = nonEmptyString(first?.name);
		if (artist) edge.artist = artist;
	}
	if (source.type === "project" && reverseField === MBID_REVERSE_FIELD) {
		const parsed = edgeMbid.safeParse(source.mbid);
		if (parsed.success) edge.mbid = parsed.data;
	}
	return edge;
}

export interface MergedReverseEdge {
	edge: EdgeRef;
	/** The edge already holds an mbid that is not the incoming one: kept as is, to be reported. */
	mbidConflict: boolean;
}

/**
 * An edge already present on the target, enriched with what the incoming reverse edge knows (TRA-624): an
 * edge with no mbid receives the incoming one; an mbid already there is never overwritten, and a different
 * one is reported through `mbidConflict`. Nothing else of the existing edge changes. Pure.
 */
export function mergeReverseEdge(existing: EdgeRef, incoming: EdgeRef): MergedReverseEdge {
	if (!incoming.mbid) return { edge: existing, mbidConflict: false };
	if (!existing.mbid) return { edge: { ...existing, mbid: incoming.mbid }, mbidConflict: false };
	return { edge: existing, mbidConflict: existing.mbid.toLowerCase() !== incoming.mbid.toLowerCase() };
}
