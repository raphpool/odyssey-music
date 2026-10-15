export const NODE_TYPES = ["genre", "label", "artist", "project", "track"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export type EdgeCardinality = "list" | "single";

export interface EdgeFieldSpec {
	cardinality: EdgeCardinality;
	targets: readonly NodeType[];
}

export interface ReverseEdgeSpec {
	field: string;
	cardinality: EdgeCardinality;
}

export const EDGE_FIELDS_BY_TYPE = {
	genre: {
		parent_genres: { cardinality: "list", targets: ["genre"] },
		subgenres: { cardinality: "list", targets: ["genre"] },
		related_genres: { cardinality: "list", targets: ["genre"] },
		key_artists: { cardinality: "list", targets: ["artist"] },
		key_labels: { cardinality: "list", targets: ["label"] },
		landmark_projects: { cardinality: "list", targets: ["project"] },
		landmark_tracks: { cardinality: "list", targets: ["track"] },
	},
	label: {
		genres: { cardinality: "list", targets: ["genre"] },
		roster: { cardinality: "list", targets: ["artist"] },
		notable_releases: { cardinality: "list", targets: ["project"] },
	},
	artist: {
		genres: { cardinality: "list", targets: ["genre"] },
		labels: { cardinality: "list", targets: ["label"] },
		discography: { cardinality: "list", targets: ["project"] },
		notable_tracks: { cardinality: "list", targets: ["track"] },
		influences: { cardinality: "list", targets: ["artist"] },
		influenced: { cardinality: "list", targets: ["artist"] },
		collaborators: { cardinality: "list", targets: ["artist"] },
		aliases: { cardinality: "list", targets: ["artist"] },
		members: { cardinality: "list", targets: ["artist"] },
		similar_artists: { cardinality: "list", targets: ["artist"] },
	},
	project: {
		artists: { cardinality: "list", targets: ["artist"] },
		label: { cardinality: "single", targets: ["label"] },
		genres: { cardinality: "list", targets: ["genre"] },
		tracklist: { cardinality: "list", targets: ["track"] },
		producers: { cardinality: "list", targets: ["artist"] },
		personnel: { cardinality: "list", targets: ["artist"] },
		related_projects: { cardinality: "list", targets: ["project"] },
	},
	track: {
		artists: { cardinality: "list", targets: ["artist"] },
		project: { cardinality: "single", targets: ["project"] },
		label: { cardinality: "single", targets: ["label"] },
		genres: { cardinality: "list", targets: ["genre"] },
		producers: { cardinality: "list", targets: ["artist"] },
		personnel: { cardinality: "list", targets: ["artist"] },
		samples: { cardinality: "list", targets: ["track"] },
		sampled_by: { cardinality: "list", targets: ["track"] },
		remix_of: { cardinality: "single", targets: ["track"] },
		remixed_by: { cardinality: "list", targets: ["track"] },
	},
} as const satisfies Record<NodeType, Record<string, EdgeFieldSpec>>;

export const LIST_EDGES_BY_TYPE: Record<NodeType, readonly string[]> = Object.fromEntries(
	NODE_TYPES.map((type) => [
		type,
		Object.entries(EDGE_FIELDS_BY_TYPE[type])
			.filter(([, spec]) => spec.cardinality === "list")
			.map(([field]) => field),
	]),
) as unknown as Record<NodeType, readonly string[]>;

export const SINGULAR_EDGES_BY_TYPE: Record<NodeType, readonly string[]> = Object.fromEntries(
	NODE_TYPES.map((type) => [
		type,
		Object.entries(EDGE_FIELDS_BY_TYPE[type])
			.filter(([, spec]) => spec.cardinality === "single")
			.map(([field]) => field),
	]),
) as unknown as Record<NodeType, readonly string[]>;

export const OPTIONAL_TEXT_FIELDS: Record<NodeType, readonly string[]> = {
	genre: ["era", "origin", "sonic_markers"],
	label: ["founded", "location", "founders", "active_years"],
	artist: ["photo_url", "origin", "active_years"],
	project: [
		"cover_url",
		"year",
		"release_type",
		"bpm",
		"musical_key",
		"vocals",
		"samples_notes",
		"inspirations",
	],
	track: ["cover_url", "year", "duration", "bpm", "musical_key", "vocals", "samples_notes", "inspirations"],
};

export const TEASER_FIELD_BY_TYPE: Record<NodeType, string> = {
	genre: "editorial_definition",
	label: "editorial_description",
	artist: "editorial_bio",
	project: "editorial_pitch",
	track: "editorial_teaser",
};

export const EDGE_TARGET_TYPES_BY_TYPE: Record<
	NodeType,
	Record<string, readonly NodeType[]>
> = Object.fromEntries(
	NODE_TYPES.map((type) => [
		type,
		Object.fromEntries(
			Object.entries(EDGE_FIELDS_BY_TYPE[type]).map(([field, spec]) => [field, spec.targets]),
		),
	]),
) as Record<NodeType, Record<string, readonly NodeType[]>>;

export const REVERSE_EDGE_PAIRS: ReadonlyArray<{
	sourceType: NodeType;
	sourceField: string;
	reverse: ReverseEdgeSpec;
}> = [
	{ sourceType: "genre", sourceField: "parent_genres", reverse: { field: "subgenres", cardinality: "list" } },
	{ sourceType: "genre", sourceField: "subgenres", reverse: { field: "parent_genres", cardinality: "list" } },
	{
		sourceType: "genre",
		sourceField: "related_genres",
		reverse: { field: "related_genres", cardinality: "list" },
	},
	{ sourceType: "artist", sourceField: "influences", reverse: { field: "influenced", cardinality: "list" } },
	{ sourceType: "artist", sourceField: "influenced", reverse: { field: "influences", cardinality: "list" } },
	{
		sourceType: "artist",
		sourceField: "collaborators",
		reverse: { field: "collaborators", cardinality: "list" },
	},
	{ sourceType: "artist", sourceField: "aliases", reverse: { field: "aliases", cardinality: "list" } },
	{ sourceType: "artist", sourceField: "members", reverse: { field: "members", cardinality: "list" } },
	{ sourceType: "track", sourceField: "samples", reverse: { field: "sampled_by", cardinality: "list" } },
	{ sourceType: "track", sourceField: "sampled_by", reverse: { field: "samples", cardinality: "list" } },
	{ sourceType: "track", sourceField: "remix_of", reverse: { field: "remixed_by", cardinality: "list" } },
	{ sourceType: "track", sourceField: "remixed_by", reverse: { field: "remix_of", cardinality: "single" } },
	// Cross-type pairs (TRA-454, 2026-10-14): without them 277/458 artist -> label links had no
	// label.roster entry, 111/211 artist -> project links no project.artists entry, etc.
	// Deliberately absent: artist.genres -> genre.key_artists (each artist has ~5 genres, so
	// key_artists would balloon); the genre.key_* -> X.genres direction is the only one kept.
	{ sourceType: "artist", sourceField: "labels", reverse: { field: "roster", cardinality: "list" } },
	{ sourceType: "label", sourceField: "roster", reverse: { field: "labels", cardinality: "list" } },
	{ sourceType: "artist", sourceField: "discography", reverse: { field: "artists", cardinality: "list" } },
	{ sourceType: "project", sourceField: "artists", reverse: { field: "discography", cardinality: "list" } },
	{ sourceType: "artist", sourceField: "notable_tracks", reverse: { field: "artists", cardinality: "list" } },
	{ sourceType: "track", sourceField: "artists", reverse: { field: "notable_tracks", cardinality: "list" } },
	{ sourceType: "project", sourceField: "tracklist", reverse: { field: "project", cardinality: "single" } },
	{ sourceType: "track", sourceField: "project", reverse: { field: "tracklist", cardinality: "list" } },
	{
		sourceType: "label",
		sourceField: "notable_releases",
		reverse: { field: "label", cardinality: "single" },
	},
	{
		sourceType: "project",
		sourceField: "label",
		reverse: { field: "notable_releases", cardinality: "list" },
	},
	{ sourceType: "genre", sourceField: "key_artists", reverse: { field: "genres", cardinality: "list" } },
	{ sourceType: "genre", sourceField: "key_labels", reverse: { field: "genres", cardinality: "list" } },
	{
		sourceType: "genre",
		sourceField: "landmark_projects",
		reverse: { field: "genres", cardinality: "list" },
	},
	{ sourceType: "genre", sourceField: "landmark_tracks", reverse: { field: "genres", cardinality: "list" } },
];

export const NODE_SPEC_JSON = {
	nodeTypes: NODE_TYPES,
	edgeFieldsByType: EDGE_FIELDS_BY_TYPE,
	listEdgesByType: LIST_EDGES_BY_TYPE,
	singularEdgesByType: SINGULAR_EDGES_BY_TYPE,
	optionalTextFields: OPTIONAL_TEXT_FIELDS,
	teaserFieldByType: TEASER_FIELD_BY_TYPE,
	edgeTargetTypesByType: EDGE_TARGET_TYPES_BY_TYPE,
	reverseEdgePairs: REVERSE_EDGE_PAIRS,
};
