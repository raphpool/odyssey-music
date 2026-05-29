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
