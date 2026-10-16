import { z } from "zod";

export const nodeTypeSchema = z.enum(["artist", "project", "track", "genre", "label"]);
export type NodeType = z.infer<typeof nodeTypeSchema>;

const identitySchema = z
	.string()
	.regex(/^(artist|project|track|genre|label):[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/);
const publicHttpsUrlSchema = z
	.string()
	.url()
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				url.protocol === "https:" &&
				url.username === "" &&
				url.password === "" &&
				url.port === "" &&
				!isPrivateHost(url.hostname)
			);
		} catch {
			return false;
		}
	}, "URL must be public HTTPS without credentials or a custom port.");

function providerUrlSchema(host: string) {
	return publicHttpsUrlSchema.refine((value) => new URL(value).hostname === host, "URL host is not allowed.");
}

function isPrivateHost(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::") return true;
	if (host.includes(":")) {
		if (
			host.startsWith("fc") ||
			host.startsWith("fd") ||
			host.startsWith("fe8") ||
			host.startsWith("fe9") ||
			host.startsWith("fea") ||
			host.startsWith("feb")
		) {
			return true;
		}
		const mapped = parseMappedIpv4(host);
		return mapped === null ? false : isPrivateIpv4(mapped);
	}
	const ipv4 = parseIpv4(host);
	return ipv4 !== null && isPrivateIpv4(ipv4);
}

function isPrivateIpv4(ipv4: [number, number, number, number]): boolean {
	return (
		ipv4[0] === 0 ||
		ipv4[0] === 10 ||
		ipv4[0] === 127 ||
		(ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127) ||
		(ipv4[0] === 169 && ipv4[1] === 254) ||
		(ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
		(ipv4[0] === 192 && ipv4[1] === 168) ||
		(ipv4[0] === 198 && (ipv4[1] === 18 || ipv4[1] === 19))
	);
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
	const parts = hostname.split(".");
	if (parts.length !== 4) return null;
	const values = parts.map((part) => Number(part));
	if (values.some((value, index) => !/^\d+$/.test(parts[index] ?? "") || value < 0 || value > 255))
		return null;
	return values as [number, number, number, number];
}

function parseMappedIpv4(hostname: string): [number, number, number, number] | null {
	if (!hostname.startsWith("::ffff:")) return null;
	const mapped = hostname.slice("::ffff:".length);
	const dotted = parseIpv4(mapped);
	if (dotted) return dotted;
	const words = mapped.split(":");
	if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
	const first = Number.parseInt(words[0] ?? "", 16);
	const second = Number.parseInt(words[1] ?? "", 16);
	return [first >> 8, first & 0xff, second >> 8, second & 0xff];
}

const edgeSchema = z
	.object({
		slug: identitySchema,
		type: nodeTypeSchema,
		name: z.string().min(1),
		mbid: z.string().uuid().optional(),
		qid: z
			.string()
			.regex(/^Q[1-9]\d*$/)
			.optional(),
		year: z.string().min(1).optional(),
		releaseType: z.enum(["album", "ep", "single"]).optional(),
	})
	.strict()
	.superRefine((edge, context) => enforceNodeIdentity({ id: edge.slug, type: edge.type }, context));
const nodeEdgesSchema = z.record(z.union([edgeSchema, z.array(edgeSchema)]));
const citationSchema = z.object({ url: publicHttpsUrlSchema, title: z.string().min(1).optional() }).strict();

const nodeSummaryFields = z.object({
	id: identitySchema,
	type: nodeTypeSchema,
	name: z.string().min(1),
	teaser: z.string().nullable(),
	edges: nodeEdgesSchema,
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
	revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	taxonomy: z.object({ mode: z.literal("degraded"), available: z.boolean() }),
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
			citations: z.array(citationSchema),
			facts: z.record(z.string()),
			materialized_at: z.string().datetime(),
			image_url: publicHttpsUrlSchema.nullable().optional(),
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

export const imageResponseSchema = z.object({
	slug: identitySchema,
	image_url: publicHttpsUrlSchema.nullable(),
	source: z.string().min(1),
});
export type ImageResponse = z.infer<typeof imageResponseSchema>;

export const linksResponseSchema = z.object({
	slug: identitySchema,
	spotify: providerUrlSchema("open.spotify.com").nullable(),
	apple: providerUrlSchema("music.apple.com").nullable(),
	sources: z.record(z.unknown()),
	resolvedAt: z.string().datetime(),
});
export type LinksResponse = z.infer<typeof linksResponseSchema>;

export const searchResponseSchema = z.object({
	q: z.string(),
	hits: z.array(
		z
			.object({
				source: z.enum(["cache", "catalog"]),
				type: nodeTypeSchema,
				name: z.string().min(1),
				slug: identitySchema.optional(),
				mbid: z.string().uuid().optional(),
				subtitle: z.string().optional(),
				// TRA-547: first credited artist of a project/track hit (never cut out of `subtitle`).
				artist: z.string().min(1).optional(),
				artist_slug: identitySchema.refine((slug) => slug.startsWith("artist:")).optional(),
				extra: z.string().min(1).optional(),
			})
			.superRefine((hit, context) => {
				if (hit.source === "cache" && hit.slug === undefined) {
					context.addIssue({ code: z.ZodIssueCode.custom, message: "Cached search hits require a slug." });
				}
			}),
	),
	sources: z
		.object({ cache: z.number().int().nonnegative(), catalog: z.number().int().nonnegative() })
		.strict(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const generationResponseSchema = z
	.object({
		request_id: z.string().uuid(),
		status: z.enum(["queued", "running", "succeeded", "failed", "interrupted"]),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
		node_id: identitySchema.optional(),
		error: z.object({ code: z.string().min(1), message: z.string(), retryable: z.boolean() }).optional(),
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
		retryable: z.boolean().optional(),
	}),
});
