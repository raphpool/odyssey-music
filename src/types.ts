import type { NodeType } from "./node-spec.js";

export {
	EDGE_FIELDS_BY_TYPE,
	EDGE_TARGET_TYPES_BY_TYPE,
	LIST_EDGES_BY_TYPE,
	NODE_SPEC_JSON,
	NODE_TYPES,
	OPTIONAL_TEXT_FIELDS,
	REVERSE_EDGE_PAIRS,
	SINGULAR_EDGES_BY_TYPE,
	TEASER_FIELD_BY_TYPE,
} from "./node-spec.js";

export type { NodeType };

export type Slug = `${NodeType}:${string}`;

// Wikidata entity id format (e.g. "Q170611"). Shared by schemas.ts (edgeRefBase/genreSchema
// validation) and pipeline.ts (normalizeEdge's pre-filter) so the two never drift apart (TRA-17).
export const QID_PATTERN = /^Q[1-9]\d*$/;

export interface EdgeRef {
	slug: Slug;
	type: NodeType;
	name: string;
	mbid?: string;
	qid?: string; // Wikidata entity id, genre edges only.
	year?: string;
	releaseType?: "album" | "ep" | "single";
	// Name of the primary credited artist; set on project/track targets, whose slug is scoped by it.
	artist?: string;
}

export interface Citation {
	url: string;
	title?: string;
}

// "legacy" = an existing photo_url / cover_url on an allowed host copied into image_url by the backfill.
export const IMAGE_SOURCES = [
	"wikidata-p18",
	"wikidata-p154",
	"caa",
	"itunes-verified",
	"derived-cover",
	"legacy",
] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];

export interface BaseNode {
	slug: Slug;
	type: NodeType;
	name: string;
	editorial_article: string;
	citations: Citation[];
	materialized_at: string;
	mbid?: string;
	// Single display image for any node type (TRA-455, plan decision 5). Host-restricted at the
	// schema layer (src/images/hosts.ts): third-party data is untrusted. photo_url / cover_url
	// stay declared below and are still read as fallbacks by toVizNode.
	image_url?: string;
	// Provenance of image_url, so a resolver batch can be invalidated or re-run by source.
	image_source?: ImageSource;
}

export interface GenreNode extends BaseNode {
	type: "genre";
	editorial_definition: string;
	// Wikidata entity id for this genre itself, from the catalog. Plumbing only — kept out of
	// node-spec's OPTIONAL_TEXT_FIELDS so it never surfaces in facts/UI (TRA-17).
	qid?: string;
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
	// A person and a group are distinct artist nodes; absent until the backfill classifies them.
	artist_kind?: "person" | "group";
	editorial_bio: string;
	photo_url?: string;
	origin?: string;
	active_years?: string;
	genres: EdgeRef[];
	labels: EdgeRef[];
	discography: EdgeRef[];
	notable_tracks: EdgeRef[];
	/** Flagship album (target type `project`). Meant to belong to `discography`; enforced by the pipeline (TRA-470). */
	landmark_project?: EdgeRef;
	/** Reference track (target type `track`). Meant to belong to `notable_tracks`; enforced by the pipeline (TRA-470). */
	reference_track?: EdgeRef;
	influences: EdgeRef[];
	influenced: EdgeRef[];
	collaborators: EdgeRef[];
	aliases: EdgeRef[];
	members: EdgeRef[];
	// 0-10 artist edges, fed by ListenBrainz (by MBID) then a graph-computed fallback, never by the LLM.
	similar_artists: EdgeRef[];
}

export interface ProjectNode extends BaseNode {
	type: "project";
	editorial_pitch: string;
	cover_url?: string;
	year?: string;
	/** Release format. Sourced from MusicBrainz release-group primary-type
	 * during materialization (kept narrow to match EdgeRef.releaseType so chips
	 * and node payloads agree). Falls back to undefined when MB doesn't return
	 * a primary-type or returns a non-album/ep/single value. */
	release_type?: "album" | "ep" | "single";
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
