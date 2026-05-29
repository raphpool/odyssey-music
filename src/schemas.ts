import { z } from "zod";
import { EDGE_TARGET_TYPES_BY_TYPE } from "./node-spec.js";
import { isValidSlug } from "./slug.js";
import { NODE_TYPES, type NodeType } from "./types.js";

const slugSchema = z.string().refine(isValidSlug, { message: "invalid slug" });

const nodeTypeSchema = z.enum(NODE_TYPES);

const edgeRefBase = z.object({
	slug: slugSchema,
	type: nodeTypeSchema,
	name: z.string().min(1),
	// Optional MBID stamped when the edge was emitted from a MusicBrainz lookup. If present,
	// the JIT chip-click on this edge passes it back as ?mbid= so the downstream materialize
	// uses the exact entity (avoids "click Drake's ICEMAN → land on Sub Society 1990 ICEMAN"
	// — Raph 2026-05-19).
	mbid: z.string().uuid().optional(),
	// Stamped on artist.discography edges (2026-05-24 Raph): year shows on chip; releaseType
	// lets the frontend tag EPs/singles distinctly from full albums.
	year: z.string().optional(),
	releaseType: z.enum(["album", "ep", "single"]).optional(),
});

/** Build an edge schema whose `type` is constrained to one of `allowed` and whose `slug` prefix matches. */
function typedEdge(allowed: readonly NodeType[]) {
	const set = new Set(allowed);
	return edgeRefBase.superRefine((val, ctx) => {
		if (!set.has(val.type)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `edge.type must be one of ${[...set].join("|")}, got ${val.type}`,
			});
		}
		const prefix = `${val.type}:`;
		if (!val.slug.startsWith(prefix)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `edge.slug must start with "${prefix}" to match edge.type`,
			});
		}
	});
}

function typedEdgeFor(type: NodeType, field: string) {
	const allowed = EDGE_TARGET_TYPES_BY_TYPE[type][field];
	if (!allowed) throw new Error(`No edge target spec for ${type}.${field}`);
	return typedEdge(allowed);
}

const citationSchema = z.object({
	url: z.string().url(),
	title: z.string().optional(),
});

const metricsSchema = z
	.object({
		input_tokens: z.number().int().nonnegative(),
		output_tokens: z.number().int().nonnegative(),
		cache_read_tokens: z.number().int().nonnegative(),
		cache_write_tokens: z.number().int().nonnegative(),
		cost_usd: z.number().nonnegative(),
		llm_calls: z.number().int().nonnegative(),
		search_calls: z.number().int().nonnegative(),
		fetch_calls: z.number().int().nonnegative(),
		turns: z.number().int().nonnegative(),
		emit_attempts: z.number().int().nonnegative(),
		agent_ms: z.number().nonnegative(),
		model_id: z.string(),
		search_provider: z.enum(["tavily", "firecrawl"]),
	})
	.optional();

// Tighter floors at the disk layer: even if a future caller skips pipeline validation,
// the persisted file must have a real article and a real citation.
const baseFields = {
	slug: slugSchema,
	name: z.string().min(1),
	editorial_article: z.string().min(80),
	citations: z.array(citationSchema).min(1),
	materialized_at: z.string().datetime(),
	_metrics: metricsSchema,
	disambiguator: z.string().optional(),
	mbid: z.string().uuid().optional(),
};

const genreSchema = z.object({
	...baseFields,
	type: z.literal("genre"),
	editorial_definition: z.string().min(1),
	era: z.string().optional(),
	origin: z.string().optional(),
	sonic_markers: z.string().optional(),
	parent_genres: z.array(typedEdgeFor("genre", "parent_genres")),
	subgenres: z.array(typedEdgeFor("genre", "subgenres")),
	related_genres: z.array(typedEdgeFor("genre", "related_genres")),
	key_artists: z.array(typedEdgeFor("genre", "key_artists")),
	key_labels: z.array(typedEdgeFor("genre", "key_labels")),
	landmark_projects: z.array(typedEdgeFor("genre", "landmark_projects")),
	landmark_tracks: z.array(typedEdgeFor("genre", "landmark_tracks")),
});

const labelSchema = z.object({
	...baseFields,
	type: z.literal("label"),
	editorial_description: z.string().min(1),
	founded: z.string().optional(),
	location: z.string().optional(),
	founders: z.string().optional(),
	active_years: z.string().optional(),
	genres: z.array(typedEdgeFor("label", "genres")),
	roster: z.array(typedEdgeFor("label", "roster")),
	notable_releases: z.array(typedEdgeFor("label", "notable_releases")),
});

const artistSchema = z.object({
	...baseFields,
	type: z.literal("artist"),
	editorial_bio: z.string().min(1),
	photo_url: z.string().url().optional(),
	origin: z.string().optional(),
	active_years: z.string().optional(),
	genres: z.array(typedEdgeFor("artist", "genres")),
	labels: z.array(typedEdgeFor("artist", "labels")),
	discography: z.array(typedEdgeFor("artist", "discography")),
	notable_tracks: z.array(typedEdgeFor("artist", "notable_tracks")),
	influences: z.array(typedEdgeFor("artist", "influences")),
	influenced: z.array(typedEdgeFor("artist", "influenced")),
	collaborators: z.array(typedEdgeFor("artist", "collaborators")),
	aliases: z.array(typedEdgeFor("artist", "aliases")),
	members: z.array(typedEdgeFor("artist", "members")),
});

const projectSchema = z.object({
	...baseFields,
	type: z.literal("project"),
	editorial_pitch: z.string().min(1),
	cover_url: z.string().url().optional(),
	year: z.string().optional(),
	// MusicBrainz release-group primary-type, narrowed to album/ep/single.
	// See ProjectNode in types.ts for rationale on the narrow set.
	release_type: z.enum(["album", "ep", "single"]).optional(),
	bpm: z.string().optional(),
	musical_key: z.string().optional(),
	vocals: z.string().optional(),
	samples_notes: z.string().optional(),
	inspirations: z.string().optional(),
	artists: z.array(typedEdgeFor("project", "artists")),
	label: typedEdgeFor("project", "label").optional(),
	genres: z.array(typedEdgeFor("project", "genres")),
	tracklist: z.array(typedEdgeFor("project", "tracklist")),
	producers: z.array(typedEdgeFor("project", "producers")),
	personnel: z.array(typedEdgeFor("project", "personnel")).default([]),
	related_projects: z.array(typedEdgeFor("project", "related_projects")),
});

const trackSchema = z.object({
	...baseFields,
	type: z.literal("track"),
	editorial_teaser: z.string().min(1),
	cover_url: z.string().url().optional(),
	year: z.string().optional(),
	duration: z.string().optional(),
	bpm: z.string().optional(),
	musical_key: z.string().optional(),
	vocals: z.string().optional(),
	samples_notes: z.string().optional(),
	inspirations: z.string().optional(),
	artists: z.array(typedEdgeFor("track", "artists")),
	project: typedEdgeFor("track", "project").optional(),
	label: typedEdgeFor("track", "label").optional(),
	genres: z.array(typedEdgeFor("track", "genres")),
	producers: z.array(typedEdgeFor("track", "producers")),
	personnel: z.array(typedEdgeFor("track", "personnel")).default([]),
	samples: z.array(typedEdgeFor("track", "samples")),
	sampled_by: z.array(typedEdgeFor("track", "sampled_by")),
	remix_of: typedEdgeFor("track", "remix_of").optional(),
	remixed_by: z.array(typedEdgeFor("track", "remixed_by")),
});

export const nodePayloadSchema = z.discriminatedUnion("type", [
	genreSchema,
	labelSchema,
	artistSchema,
	projectSchema,
	trackSchema,
]);
