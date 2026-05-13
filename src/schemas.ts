import { z } from "zod";
import { isValidSlug } from "./slug.js";
import { NODE_TYPES } from "./types.js";

const slugSchema = z.string().refine(isValidSlug, { message: "invalid slug" });

const nodeTypeSchema = z.enum(NODE_TYPES);

const edgeRefSchema = z.object({
	slug: slugSchema,
	type: nodeTypeSchema,
	name: z.string().min(1),
});

const citationSchema = z.object({
	url: z.string().url(),
	title: z.string().optional(),
});

const baseFields = {
	slug: slugSchema,
	name: z.string().min(1),
	editorial_article: z.string().min(1),
	citations: z.array(citationSchema),
	materialized_at: z.string().datetime(),
};

const edgeList = () => z.array(edgeRefSchema);

const genreSchema = z.object({
	...baseFields,
	type: z.literal("genre"),
	editorial_definition: z.string().min(1),
	era: z.string().optional(),
	origin: z.string().optional(),
	sonic_markers: z.string().optional(),
	parent_genres: edgeList(),
	subgenres: edgeList(),
	related_genres: edgeList(),
	key_artists: edgeList(),
	key_labels: edgeList(),
	landmark_projects: edgeList(),
	landmark_tracks: edgeList(),
});

const labelSchema = z.object({
	...baseFields,
	type: z.literal("label"),
	editorial_description: z.string().min(1),
	founded: z.string().optional(),
	location: z.string().optional(),
	founders: z.string().optional(),
	active_years: z.string().optional(),
	genres: edgeList(),
	roster: edgeList(),
	notable_releases: edgeList(),
});

const artistSchema = z.object({
	...baseFields,
	type: z.literal("artist"),
	editorial_bio: z.string().min(1),
	photo_url: z.string().url().optional(),
	origin: z.string().optional(),
	active_years: z.string().optional(),
	genres: edgeList(),
	labels: edgeList(),
	discography: edgeList(),
	notable_tracks: edgeList(),
	influences: edgeList(),
	influenced: edgeList(),
	collaborators: edgeList(),
	aliases: edgeList(),
	members: edgeList(),
});

const projectSchema = z.object({
	...baseFields,
	type: z.literal("project"),
	editorial_pitch: z.string().min(1),
	cover_url: z.string().url().optional(),
	year: z.string().optional(),
	artists: edgeList(),
	label: edgeRefSchema.optional(),
	genres: edgeList(),
	tracklist: edgeList(),
	producers: edgeList(),
	related_projects: edgeList(),
});

const trackSchema = z.object({
	...baseFields,
	type: z.literal("track"),
	editorial_teaser: z.string().min(1),
	cover_url: z.string().url().optional(),
	year: z.string().optional(),
	duration: z.string().optional(),
	artists: edgeList(),
	project: edgeRefSchema.optional(),
	genres: edgeList(),
	producers: edgeList(),
	samples: edgeList(),
	sampled_by: edgeList(),
	remix_of: edgeRefSchema.optional(),
	remixed_by: edgeList(),
});

export const nodePayloadSchema = z.discriminatedUnion("type", [
	genreSchema,
	labelSchema,
	artistSchema,
	projectSchema,
	trackSchema,
]);

export const edgeRefSchemaExport = edgeRefSchema;

export type NodePayloadParsed = z.infer<typeof nodePayloadSchema>;
