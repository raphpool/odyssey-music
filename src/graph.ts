import { NodeCache } from "./cache.js";
import { isNotFoundError } from "./errors.js";
import {
	LIST_EDGES_BY_TYPE,
	OPTIONAL_TEXT_FIELDS,
	REVERSE_EDGE_PAIRS,
	SINGULAR_EDGES_BY_TYPE,
	TEASER_FIELD_BY_TYPE,
} from "./node-spec.js";
import type { Citation, EdgeRef, NodePayload, NodeType } from "./types.js";

export interface VizNode {
	id: string;
	type: NodeType;
	name: string;
	teaser: string;
	article: string;
	citations: Citation[];
	edges: Record<string, EdgeRef[] | EdgeRef>;
	facts: Record<string, string>;
	materialized_at: string;
	image_url?: string;
}

export interface VizEdge {
	source: string;
	target: string;
	kind: string;
}

export interface GraphProjection {
	generated_at: string;
	total: number;
	types: Record<string, number>;
	nodes: VizNode[];
	edges: VizEdge[];
	quarantine?: { id: string; name: string; reason: string }[];
}

export interface BuildGraphOptions {
	includeImageUrls?: boolean;
	quarantineOrphanGenres?: boolean;
	scrubQuarantinedRefs?: boolean;
}

export async function buildGraphFromCache(
	cacheDir: string,
	options: BuildGraphOptions = {},
): Promise<GraphProjection> {
	const cache = new NodeCache(cacheDir);
	const slugs = await cache.listSlugs();
	const payloads: NodePayload[] = [];
	const seen = new Set<string>();
	for (const slug of slugs) {
		const node = await cache.get(slug).catch((e: unknown) => {
			if (isNotFoundError(e)) return null;
			throw e;
		});
		if (!node || seen.has(node.slug)) continue;
		payloads.push(node);
		seen.add(node.slug);
	}

	const nodes = payloads.map((node) => toVizNode(node, options));
	backfillGenreReverses(nodes);
	let edges = collectEdges(nodes, new Set(nodes.map((node) => node.id)));
	let quarantine: { id: string; name: string; reason: string }[] | undefined;

	if (options.quarantineOrphanGenres) {
		const quarantineIds = findOrphanGenreIds(nodes, edges);
		quarantine = nodes
			.filter((node) => quarantineIds.has(node.id))
			.map((node) => ({ id: node.id, name: node.name, reason: "no genre-genre edges" }));
		if (quarantineIds.size > 0) {
			for (let i = nodes.length - 1; i >= 0; i--) {
				const node = nodes[i];
				if (node && quarantineIds.has(node.id)) nodes.splice(i, 1);
			}
			edges = edges.filter((edge) => !quarantineIds.has(edge.source) && !quarantineIds.has(edge.target));
			if (options.scrubQuarantinedRefs) scrubRefs(nodes, quarantineIds);
		}
	}

	const types: Record<string, number> = {};
	for (const node of nodes) types[node.type] = (types[node.type] ?? 0) + 1;
	const out: GraphProjection = {
		generated_at: new Date().toISOString(),
		total: nodes.length,
		types,
		nodes,
		edges,
	};
	if (quarantine) out.quarantine = quarantine;
	return out;
}

function toVizNode(node: NodePayload, options: BuildGraphOptions): VizNode {
	const raw = node as unknown as Record<string, unknown>;
	const teaserVal = raw[TEASER_FIELD_BY_TYPE[node.type]];
	const facts: Record<string, string> = {};
	for (const field of OPTIONAL_TEXT_FIELDS[node.type]) {
		const v = raw[field];
		if (typeof v === "string" && v.trim()) facts[field] = v;
	}
	const edges: Record<string, EdgeRef[] | EdgeRef> = {};
	for (const field of LIST_EDGES_BY_TYPE[node.type]) {
		const v = raw[field];
		if (Array.isArray(v) && v.length) edges[field] = v as EdgeRef[];
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[node.type]) {
		const v = raw[field];
		if (v && typeof v === "object") edges[field] = v as EdgeRef;
	}
	const viz: VizNode = {
		id: node.slug,
		type: node.type,
		name: node.name,
		teaser: typeof teaserVal === "string" ? teaserVal : "",
		article: node.editorial_article,
		citations: node.citations,
		edges,
		facts,
		materialized_at: node.materialized_at,
	};
	if (options.includeImageUrls) {
		const imageField =
			node.type === "artist"
				? "photo_url"
				: node.type === "project" || node.type === "track"
					? "cover_url"
					: null;
		const imageUrl =
			imageField && typeof raw[imageField] === "string" ? (raw[imageField] as string) : undefined;
		if (imageUrl) viz.image_url = imageUrl;
	}
	return viz;
}

function collectEdges(nodes: VizNode[], cachedSet: Set<string>): VizEdge[] {
	const edges: VizEdge[] = [];
	const dedup = new Set<string>();
	for (const node of nodes) {
		for (const [kind, value] of Object.entries(node.edges)) {
			const refs: EdgeRef[] = Array.isArray(value) ? value : [value];
			for (const ref of refs) {
				if (!cachedSet.has(ref.slug)) continue;
				const key = `${node.id}|${ref.slug}|${kind}`;
				if (dedup.has(key)) continue;
				dedup.add(key);
				edges.push({ source: node.id, target: ref.slug, kind });
			}
		}
	}
	return edges;
}

function findOrphanGenreIds(nodes: VizNode[], edges: VizEdge[]): Set<string> {
	const genreLinkKinds = new Set(
		REVERSE_EDGE_PAIRS.filter((p) => p.sourceType === "genre" && p.reverse.field).map((p) => p.sourceField),
	);
	const genreLinkCount = new Map<string, number>();
	for (const edge of edges) {
		if (
			edge.source.startsWith("genre:") &&
			edge.target.startsWith("genre:") &&
			genreLinkKinds.has(edge.kind)
		) {
			genreLinkCount.set(edge.source, (genreLinkCount.get(edge.source) ?? 0) + 1);
			genreLinkCount.set(edge.target, (genreLinkCount.get(edge.target) ?? 0) + 1);
		}
	}
	const quarantineIds = new Set<string>();
	for (const node of nodes) {
		if (node.type === "genre" && (genreLinkCount.get(node.id) ?? 0) === 0) quarantineIds.add(node.id);
	}
	return quarantineIds;
}

function scrubRefs(nodes: VizNode[], removed: Set<string>): void {
	for (const node of nodes) {
		for (const [field, value] of Object.entries(node.edges)) {
			if (Array.isArray(value)) {
				const kept = value.filter((ref) => !removed.has(ref.slug));
				if (kept.length > 0) node.edges[field] = kept;
				else delete node.edges[field];
			} else if (removed.has(value.slug)) {
				delete node.edges[field];
			}
		}
	}
}

function backfillGenreReverses(nodes: VizNode[]): void {
	const byId = new Map<string, VizNode>();
	for (const node of nodes) byId.set(node.id, node);
	const ensureList = (node: VizNode, field: string): EdgeRef[] => {
		const existing = node.edges[field];
		if (Array.isArray(existing)) return existing;
		const fresh: EdgeRef[] = [];
		node.edges[field] = fresh;
		return fresh;
	};
	const addRefIfMissing = (list: EdgeRef[], ref: EdgeRef): void => {
		if (!list.some((edge) => edge.slug === ref.slug)) list.push(ref);
	};
	const genrePairs = REVERSE_EDGE_PAIRS.filter((p) => p.sourceType === "genre");
	for (const node of nodes) {
		if (node.type !== "genre") continue;
		const self: EdgeRef = { slug: node.id as EdgeRef["slug"], type: "genre", name: node.name };
		for (const pair of genrePairs) {
			const refs = node.edges[pair.sourceField];
			const list = Array.isArray(refs) ? refs : [];
			for (const ref of list) {
				const target = byId.get(ref.slug);
				if (target?.type === "genre") addRefIfMissing(ensureList(target, pair.reverse.field), self);
			}
		}
	}
}
