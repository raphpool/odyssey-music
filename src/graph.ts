import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeCache } from "./cache.js";
import { isNotFoundError } from "./errors.js";
import { loadRedirects } from "./genre-registry.js";
import { loadGenreTaxonomy } from "./genre-taxonomy.js";
import { type GenreTaxonomyProjection, projectGenreTaxonomy } from "./genre-taxonomy-projection.js";
import { logger } from "./logger.js";
import {
	EDGE_TARGET_TYPES_BY_TYPE,
	LIST_EDGES_BY_TYPE,
	OPTIONAL_TEXT_FIELDS,
	REVERSE_EDGE_PAIRS,
	SINGULAR_EDGES_BY_TYPE,
	TEASER_FIELD_BY_TYPE,
} from "./node-spec.js";
import type { Citation, EdgeRef, ImageSource, NodePayload, NodeType } from "./types.js";

const log = logger.child({ module: "graph" });

// Genre taxonomy logic (orphan detection, reverse backfill) only concerns genre -> genre pairs.
// Since TRA-454 (2026-10-14) REVERSE_EDGE_PAIRS also holds genre.key_artists -> artist.genres and
// siblings, so filtering on the source type alone would pull cross-type pairs into the taxonomy.
const GENRE_TO_GENRE_PAIRS = REVERSE_EDGE_PAIRS.filter((pair) => {
	const targets = EDGE_TARGET_TYPES_BY_TYPE[pair.sourceType][pair.sourceField];
	return pair.sourceType === "genre" && targets?.length === 1 && targets[0] === "genre";
});

// Absolute, module-relative resolution of data/genre-taxonomy.json (mirrors loadGenreRedirects's
// own default in genre-registry.ts). Exported so the live service and the static build both pass
// it explicitly instead of relying on loadGenreTaxonomy's own cwd-relative default -- otherwise
// taxonomy resolution silently depends on the process's working directory, and the two exports
// can only agree on it by accident (TRA-134 review).
export const DEFAULT_TAXONOMY_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"data",
	"genre-taxonomy.json",
);

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
	image_source?: ImageSource;
	// Wikidata entity id, genre nodes only — mirrors GenreNode.qid (TRA-17/TRA-19). Kept out of
	// facts/UI: toVizNode below is the sole gate that lets it onto a VizNode.
	qid?: string;
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
	// Loser slug -> canonical slug, sourced from data/genre-redirects.json (TRA-22's
	// duplicate-merge migration output) so a deep link to a merged-away genre slug can be
	// resolved by the front (TRA-23, 2026-09-10). Absent when the table has no entries.
	redirects?: Record<string, string>;
	// Picker-v2 projection of data/genre-taxonomy.json (TRA-133/TRA-134). Absent when the
	// `taxonomy` option isn't set, the source file isn't present, or (in "degrade" mode) it
	// failed to load/project against this cache -- keeps a graph built without it byte-identical
	// to before, mirroring quarantine/redirects above.
	taxonomy?: GenreTaxonomyProjection;
}

export interface BuildGraphOptions {
	quarantineOrphanGenres?: boolean;
	scrubQuarantinedRefs?: boolean;
	// Override for data/genre-redirects.json's default location, mirroring loadGenreRedirects's
	// own `path` param — test-only injection point (TRA-23, 2026-09-10).
	redirectsPath?: string;
	// Same, for data/slug-redirects.json (TRA-453: the all-types table loaded next to the genre one).
	slugRedirectsPath?: string;
	// Projects data/genre-taxonomy.json onto this graph (TRA-134). Unset (default) skips it
	// entirely, so callers that don't ask for it see no behavior change. A taxonomy file that's
	// genuinely absent is always a silent no-op in both modes -- the two modes only differ on a
	// file that's *present but broken relative to this cache* (invalid JSON/schema, or a declared
	// source slug missing from it):
	//   - "strict": the failure propagates. Use for the static build, so CI catches a taxonomy
	//     that has drifted from the committed cache/ before it ships.
	//   - "degrade": the failure is logged (see log.error below) and `taxonomy` is left off the
	//     graph, which is otherwise served normally. Use for the live service, whose cache can
	//     lag the repo's (deploy/deploy-server.sh excludes cache/) -- a stale server cache must
	//     never 500 the whole explorer over a genre that hasn't been deployed yet (TRA-134 review).
	taxonomy?: "strict" | "degrade";
	// Explicit override for data/genre-taxonomy.json's location. Both real callers pass
	// DEFAULT_TAXONOMY_PATH (exported above) rather than omitting this and relying on
	// loadGenreTaxonomy's own cwd-relative default; tests point it at a fixture.
	taxonomyPath?: string;
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

	const nodes = payloads.map((node) => toVizNode(node));
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

	const redirects = await loadRedirects({ genre: options.redirectsPath, slug: options.slugRedirectsPath });

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
	// Omit when empty, mirroring quarantine above — keeps a data.json built against today's
	// still-empty data/genre-redirects.json skeleton (TRA-22 not yet run) byte-identical to
	// pre-TRA-23 output.
	if (redirects.size > 0) out.redirects = Object.fromEntries(redirects);

	// Enrich after the base projection is filtered above, so quarantined genres are already gone
	// from `out` by the time projectGenreTaxonomy measures coverage against it (TRA-134).
	if (options.taxonomy) {
		const taxonomyPath = options.taxonomyPath ?? DEFAULT_TAXONOMY_PATH;
		try {
			const taxonomy = await loadGenreTaxonomy(taxonomyPath);
			out.taxonomy = await projectGenreTaxonomy(taxonomy, cache, out, redirects);
		} catch (error) {
			// A genuinely absent taxonomy file is a normal, silent no-op in both modes -- the
			// graph stays usable without picker v2, same as before this file was ever authored.
			if (!isTaxonomyAbsent(error)) reportTaxonomyFailure(options.taxonomy, taxonomyPath, error);
		}
	}
	return out;
}

function isTaxonomyAbsent(error: unknown): boolean {
	const cause = error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
	return cause?.code === "ENOENT";
}

// A taxonomy file that's present but broken relative to this cache (invalid JSON/schema, or
// loadGenreTaxonomy/projectGenreTaxonomy hitting a declared source slug missing from it) never
// surfaces with file context on its own -- a bare Zod error, for one, prints as a JSON array of
// issues. Wrapping it here means both the CI-facing "strict" failure and the "degrade" log line
// point at the exact file (TRA-134 review).
function reportTaxonomyFailure(mode: "strict" | "degrade", path: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const wrapped = new Error(`Genre taxonomy at ${path} could not be projected: ${message}`, { cause: error });
	if (mode === "strict") throw wrapped;
	log.error("genre taxonomy projection failed; serving the graph without it", {
		taxonomyPath: path,
		error: wrapped.message,
	});
}

export function toVizNode(node: NodePayload): VizNode {
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
	// Node-level qid whitelist: genre only, mirroring the edge-level one already applied above (TRA-19).
	if (node.type === "genre" && node.qid) viz.qid = node.qid;
	// Same projection for static, live and mobile graphs (TRA-455): image_url first, then the
	// per-type legacy fields. photo_url / cover_url are not host-checked, so consumers must keep
	// treating the value as untrusted. image_source describes image_url only: never project it
	// next to a photo_url / cover_url fallback.
	if (node.image_url) {
		viz.image_url = node.image_url;
		if (node.image_source) viz.image_source = node.image_source;
	} else {
		const fallback = [raw.photo_url, raw.cover_url].find(
			(candidate): candidate is string => typeof candidate === "string" && candidate !== "",
		);
		if (fallback) viz.image_url = fallback;
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
		GENRE_TO_GENRE_PAIRS.filter((p) => p.reverse.field).map((p) => p.sourceField),
	);
	const genreLinkCount = new Map<string, number>();
	for (const edge of edges) {
		if (
			edge.source.startsWith("genre:") &&
			edge.target.startsWith("genre:") &&
			edge.source !== edge.target &&
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
	const genrePairs = GENRE_TO_GENRE_PAIRS;
	for (const node of nodes) {
		if (node.type !== "genre") continue;
		const self: EdgeRef = { slug: node.id as EdgeRef["slug"], type: "genre", name: node.name };
		// Stamp the source's own qid onto the synthesized reverse edge, mirroring emitReverses
		// on the write path (src/cache.ts, TRA-18) — now that node.qid survives toVizNode (TRA-19).
		if (node.qid) self.qid = node.qid;
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
