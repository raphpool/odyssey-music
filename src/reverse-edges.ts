import type { NodePayload, NodeType } from "./types.js";

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

const TRACK_REVERSES: Record<string, ReverseEdgeSpec | null> = {
	samples: { field: "sampled_by", cardinality: "list" },
	sampled_by: { field: "samples", cardinality: "list" },
	remix_of: { field: "remixed_by", cardinality: "list" },
	remixed_by: { field: "remix_of", cardinality: "single" },
	artists: null,
	genres: null,
	producers: null,
	project: null,
};

const ARTIST_REVERSES: Record<string, ReverseEdgeSpec | null> = {
	influences: { field: "influenced", cardinality: "list" },
	influenced: { field: "influences", cardinality: "list" },
	collaborators: { field: "collaborators", cardinality: "list" },
	aliases: { field: "aliases", cardinality: "list" },
	members: { field: "members", cardinality: "list" },
	genres: null,
	labels: null,
	discography: null,
	notable_tracks: null,
};

const REVERSES_BY_TYPE: Record<NodeType, Record<string, ReverseEdgeSpec | null>> = {
	track: TRACK_REVERSES,
	artist: ARTIST_REVERSES,
	project: {},
	label: {},
	genre: {},
};

export function reverseFor(sourceType: NodeType, sourceField: string): ReverseEdgeSpec | null {
	const map = REVERSES_BY_TYPE[sourceType];
	if (!(sourceField in map)) return null;
	return map[sourceField] ?? null;
}

/** All forward edge field names that participate in automatic reverse materialization. */
export function reversibleFields(type: NodeType): string[] {
	const map = REVERSES_BY_TYPE[type];
	return Object.keys(map).filter((k) => map[k] !== null);
}

export type AnyNode = NodePayload;
