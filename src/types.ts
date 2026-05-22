export const NODE_TYPES = ["genre", "label", "artist", "project", "track"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export type Slug = `${NodeType}:${string}`;

export interface EdgeRef {
	slug: Slug;
	type: NodeType;
	name: string;
	mbid?: string;
}

export interface Citation {
	url: string;
	title?: string;
}

export interface BaseNode {
	slug: Slug;
	type: NodeType;
	name: string;
	editorial_article: string;
	citations: Citation[];
	materialized_at: string;
	mbid?: string;
	// Provenance of the resolved image (cover_url / photo_url) when not part of
	// the materialization output. "itunes-jit" = resolved on-demand via the
	// iTunes Search fallback in GET /image/:slug. Unset = came from the
	// editorial pipeline itself. Lets us invalidate JIT picks in batch later.
	image_source?: "itunes-jit";
}

export interface GenreNode extends BaseNode {
	type: "genre";
	editorial_definition: string;
	era?: string;
	origin?: string;
	sonic_markers?: string;
	parent_genres: EdgeRef[];
	subgenres: EdgeRef[];
	related_genres: EdgeRef[];
	key_artists: EdgeRef[];
	key_labels: EdgeRef[];
	landmark_projects: EdgeRef[];
	landmark_tracks: EdgeRef[];
}

export interface LabelNode extends BaseNode {
	type: "label";
	editorial_description: string;
	founded?: string;
	location?: string;
	founders?: string;
	active_years?: string;
	genres: EdgeRef[];
	roster: EdgeRef[];
	notable_releases: EdgeRef[];
}

export interface ArtistNode extends BaseNode {
	type: "artist";
	editorial_bio: string;
	photo_url?: string;
	origin?: string;
	active_years?: string;
	genres: EdgeRef[];
	labels: EdgeRef[];
	discography: EdgeRef[];
	notable_tracks: EdgeRef[];
	influences: EdgeRef[];
	influenced: EdgeRef[];
	collaborators: EdgeRef[];
	aliases: EdgeRef[];
	members: EdgeRef[];
}

export interface ProjectNode extends BaseNode {
	type: "project";
	editorial_pitch: string;
	cover_url?: string;
	year?: string;
	bpm?: string;
	musical_key?: string;
	vocals?: string;
	samples_notes?: string;
	inspirations?: string;
	artists: EdgeRef[];
	label?: EdgeRef;
	genres: EdgeRef[];
	tracklist: EdgeRef[];
	producers: EdgeRef[];
	personnel: EdgeRef[];
	related_projects: EdgeRef[];
}

export interface TrackNode extends BaseNode {
	type: "track";
	editorial_teaser: string;
	cover_url?: string;
	year?: string;
	duration?: string;
	bpm?: string;
	musical_key?: string;
	vocals?: string;
	samples_notes?: string;
	inspirations?: string;
	artists: EdgeRef[];
	project?: EdgeRef;
	label?: EdgeRef;
	genres: EdgeRef[];
	producers: EdgeRef[];
	personnel: EdgeRef[];
	samples: EdgeRef[];
	sampled_by: EdgeRef[];
	remix_of?: EdgeRef;
	remixed_by: EdgeRef[];
}

export type NodePayload = GenreNode | LabelNode | ArtistNode | ProjectNode | TrackNode;

/**
 * The set of edge field names on each node type that hold lists of EdgeRefs.
 * Singular-edge fields (project, label, remix_of) are handled separately.
 */
export const LIST_EDGES_BY_TYPE: Record<NodeType, readonly string[]> = {
	genre: [
		"parent_genres",
		"subgenres",
		"related_genres",
		"key_artists",
		"key_labels",
		"landmark_projects",
		"landmark_tracks",
	],
	label: ["genres", "roster", "notable_releases"],
	artist: [
		"genres",
		"labels",
		"discography",
		"notable_tracks",
		"influences",
		"influenced",
		"collaborators",
		"aliases",
		"members",
	],
	project: ["artists", "genres", "tracklist", "producers", "personnel", "related_projects"],
	track: ["artists", "genres", "producers", "personnel", "samples", "sampled_by", "remixed_by"],
};

/**
 * Optional text/scalar fields per node type that should be threaded through
 * the viz layer (build-graph-json + server.buildGraph) into VizNode.facts so
 * the frontend can render them as fact pills.
 */
export const OPTIONAL_TEXT_FIELDS: Record<NodeType, readonly string[]> = {
	genre: ["era", "origin", "sonic_markers"],
	label: ["founded", "location", "founders", "active_years"],
	artist: ["photo_url", "origin", "active_years"],
	project: ["cover_url", "year", "bpm", "musical_key", "vocals", "samples_notes", "inspirations"],
	track: ["cover_url", "year", "duration", "bpm", "musical_key", "vocals", "samples_notes", "inspirations"],
};

export const SINGULAR_EDGES_BY_TYPE: Record<NodeType, readonly string[]> = {
	genre: [],
	label: [],
	artist: [],
	project: ["label"],
	track: ["project", "label", "remix_of"],
};
