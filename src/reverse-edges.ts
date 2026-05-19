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
	// personnel / label have no clean reverse: the source is a track but artist.collaborators
	// is artist[] only, and label.notable_releases is project[] only. Pushing a track ref into
	// either fails zod validation (caught in production 2026-05-19). Leave reverses null —
	// graph still connects via the forward edges.
	personnel: null,
	label: null,
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

// Genre↔genre reverses. Without these, the scraper produced partial nodes:
// e.g. `micro-house` lists `minimal-techno` as a parent, but `minimal-techno`
// never learned it had `micro-house` as a subgenre. Henry caught this 2026-05-14.
const GENRE_REVERSES: Record<string, ReverseEdgeSpec | null> = {
	parent_genres: { field: "subgenres", cardinality: "list" },
	subgenres: { field: "parent_genres", cardinality: "list" },
	related_genres: { field: "related_genres", cardinality: "list" },
	key_artists: null,
	key_labels: null,
	landmark_projects: null,
	landmark_tracks: null,
};

const PROJECT_REVERSES: Record<string, ReverseEdgeSpec | null> = {
	// project.personnel has no clean reverse on artist (artist.collaborators wants artist refs,
	// not project refs). Leave null.
	personnel: null,
	artists: null,
	genres: null,
	tracklist: null,
	producers: null,
	label: null,
	related_projects: null,
};

const REVERSES_BY_TYPE: Record<NodeType, Record<string, ReverseEdgeSpec | null>> = {
	track: TRACK_REVERSES,
	artist: ARTIST_REVERSES,
	project: PROJECT_REVERSES,
	label: {},
	genre: GENRE_REVERSES,
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
