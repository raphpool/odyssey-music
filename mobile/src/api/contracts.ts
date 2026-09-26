import { z } from "zod";

export const nodeTypeSchema = z.enum(["artist", "project", "track", "genre", "label"]);
export type NodeType = z.infer<typeof nodeTypeSchema>;

const identitySchema = z.string().regex(/^(artist|project|track|genre|label):[a-z0-9][a-z0-9-]*$/);
const edgeSchema = z.record(z.unknown());

const nodeSummaryFields = z.object({
	id: identitySchema,
	type: nodeTypeSchema,
	name: z.string().min(1),
	teaser: z.string().nullable(),
	edges: z.array(edgeSchema),
});

function enforceNodeIdentity<T extends { id: string; type: NodeType }>(
	node: T,
	context: z.RefinementCtx,
): void {
	if (!node.id.startsWith(`${node.type}:`)) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "Node identity and type must agree." });
	}
}

export const catalogSchema = z.object({
	version: z.literal("v1"),
	revision: z.string().min(1),
	taxonomy: z.object({ mode: z.string().min(1), available: z.boolean() }),
	nodes: z.array(
		z
			.object({
				identity: identitySchema,
				type: nodeTypeSchema,
				name: z.string().min(1),
				teaser: z.string().nullable(),
			})
			.superRefine((node, context) => enforceNodeIdentity({ id: node.identity, type: node.type }, context)),
	),
	edges: z.array(
		z.object({
			source: identitySchema,
			target: identitySchema,
			type: z.string().min(1),
		}),
	),
});
export type Catalog = z.infer<typeof catalogSchema>;

export const nodeResponseSchema = z.object({
	node: nodeSummaryFields
		.extend({
			article: z.string(),
			citations: z.array(z.record(z.unknown())),
			facts: z.record(z.unknown()),
			materialized_at: z.string().datetime(),
			image_url: z.string().url().nullable().optional(),
			qid: z
				.string()
				.regex(/^Q\d+$/)
				.optional(),
		})
		.superRefine(enforceNodeIdentity),
	source: z.literal("cache"),
	redirected_from: identitySchema.optional(),
});
export type NodeResponse = z.infer<typeof nodeResponseSchema>;

export const imageResponseSchema = z.object({ image: z.string().url().nullable() });
export type ImageResponse = z.infer<typeof imageResponseSchema>;

export const linksResponseSchema = z.object({ links: z.record(z.unknown()).nullable() });
export type LinksResponse = z.infer<typeof linksResponseSchema>;

export const searchResponseSchema = z.object({
	q: z.string(),
	hits: z.array(
		z.object({
			source: z.string().min(1),
			type: nodeTypeSchema,
			name: z.string().min(1),
			slug: z.string().optional(),
			mbid: z.string().optional(),
			subtitle: z.string().optional(),
			extra: z.record(z.unknown()).optional(),
		}),
	),
	sources: z.array(z.string()),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const generationResponseSchema = z
	.object({
		request_id: z.string().min(1),
		status: z.enum(["queued", "running", "succeeded", "failed", "interrupted"]),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
		node_id: identitySchema.optional(),
		error: z.string().min(1).optional(),
	})
	.superRefine((generation, context) => {
		if (generation.status === "succeeded" && generation.node_id === undefined) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Succeeded generations require a node id." });
		}
		if (
			(generation.status === "failed" || generation.status === "interrupted") &&
			generation.error === undefined
		) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Terminal failures require a public error." });
		}
	});
export type Generation = z.infer<typeof generationResponseSchema>;

export const apiErrorSchema = z.object({
	error: z.object({
		code: z.string().min(1),
		message: z.string(),
	}),
});
