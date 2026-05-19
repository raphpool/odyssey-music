import { z } from "zod";
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
});

/** Build an edge schema whose `type` is constrained to one of `allowed` and whose `slug` prefix matches. */
function typedEdge(...allowed: NodeType[]) {
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

// Tighter floors at the disk layer: even if a future caller skips runAgent's gate,
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
	parent_genres: z.array(typedEdge("genre")),
	subgenres: z.array(typedEdge("genre")),
	related_genres: z.array(typedEdge("genre")),
	key_artists: z.array(typedEdge("artist")),
	key_labels: z.array(typedEdge("label")),
	landmark_projects: z.array(typedEdge("project")),
	landmark_tracks: z.array(typedEdge("track")),
});

const labelSchema = z.object({
	...baseFields,
	type: z.literal("label"),
	editorial_description: z.string().min(1),
	founded: z.string().optional(),
	location: z.string().optional(),
	founders: z.string().optional(),
	active_years: z.string().optional(),
	genres: z.array(typedEdge("genre")),
	roster: z.array(typedEdge("artist")),
	notable_releases: z.array(typedEdge("project")),
});

const artistSchema = z.object({
	...baseFields,
	type: z.literal("artist"),
	editorial_bio: z.string().min(1),
	photo_url: z.string().url().optional(),
	origin: z.string().optional(),
	active_years: z.string().optional(),
	genres: z.array(typedEdge("genre")),
	labels: z.array(typedEdge("label")),
	discography: z.array(typedEdge("project")),
	notable_tracks: z.array(typedEdge("track")),
	influences: z.array(typedEdge("artist")),
	influenced: z.array(typedEdge("artist")),
	collaborators: z.array(typedEdge("artist")),
	aliases: z.array(typedEdge("artist")),
	members: z.array(typedEdge("artist")),
});

const projectSchema = z.object({
	...baseFields,
	type: z.literal("project"),
	editorial_pitch: z.string().min(1),
	cover_url: z.string().url().optional(),
	year: z.string().optional(),
	bpm: z.string().optional(),
	musical_key: z.string().optional(),
	vocals: z.string().optional(),
	samples_notes: z.string().optional(),
	inspirations: z.string().optional(),
	artists: z.array(typedEdge("artist")),
	label: typedEdge("label").optional(),
	genres: z.array(typedEdge("genre")),
	tracklist: z.array(typedEdge("track")),
	producers: z.array(typedEdge("artist")),
	personnel: z.array(typedEdge("artist")).default([]),
	related_projects: z.array(typedEdge("project")),
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
	artists: z.array(typedEdge("artist")),
	project: typedEdge("project").optional(),
	label: typedEdge("label").optional(),
	genres: z.array(typedEdge("genre")),
	producers: z.array(typedEdge("artist")),
	personnel: z.array(typedEdge("artist")).default([]),
	samples: z.array(typedEdge("track")),
	sampled_by: z.array(typedEdge("track")),
	remix_of: typedEdge("track").optional(),
	remixed_by: z.array(typedEdge("track")),
});

export const nodePayloadSchema = z.discriminatedUnion("type", [
	genreSchema,
	labelSchema,
	artistSchema,
	projectSchema,
	trackSchema,
]);

export const edgeRefSchemaExport = edgeRefBase;

export type NodePayloadParsed = z.infer<typeof nodePayloadSchema>;
