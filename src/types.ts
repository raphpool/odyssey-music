export const NODE_TYPES = ["genre", "label", "artist", "project", "track"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export type Slug = `${NodeType}:${string}`;

export interface EdgeRef {
	slug: Slug;
	type: NodeType;
	name: string;
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
	artists: EdgeRef[];
	label?: EdgeRef;
	genres: EdgeRef[];
	tracklist: EdgeRef[];
	producers: EdgeRef[];
	related_projects: EdgeRef[];
}

export interface TrackNode extends BaseNode {
	type: "track";
	editorial_teaser: string;
	cover_url?: string;
	year?: string;
	duration?: string;
	artists: EdgeRef[];
	project?: EdgeRef;
	genres: EdgeRef[];
	producers: EdgeRef[];
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
	project: ["artists", "genres", "tracklist", "producers", "related_projects"],
	track: ["artists", "genres", "producers", "samples", "sampled_by", "remixed_by"],
};

export const SINGULAR_EDGES_BY_TYPE: Record<NodeType, readonly string[]> = {
	genre: [],
	label: [],
	artist: [],
	project: ["label"],
	track: ["project", "remix_of"],
};
