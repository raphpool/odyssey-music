import type { NodeCache } from "./cache.js";
import { resolveReadSlug } from "./genre-registry.js";
import type { GenreTaxonomy } from "./genre-taxonomy.js";
import type { GraphProjection, VizNode } from "./graph.js";
import type { Slug } from "./types.js";

const REQUIRED_NEIGHBOURS = 3;
const EMPTY_REDIRECTS = new Map<Slug, Slug>();
export interface GenreCoverageEntry {
	resolvedSources: Slug[];
	missingSources: Slug[];
	quarantinedSources: Slug[];
	neighbourCount: number;
	deficit: number;
	publishable: boolean;
}
export interface GenreCoverageFamily {
	entries: number;
	publishable: number;
	deficit: number;
}
export interface GenreCoverageReport {
	entries: Record<string, GenreCoverageEntry>;
	families: Record<string, GenreCoverageFamily>;
}
function quarantinedGenreIds(projection: GraphProjection, nodes: Map<string, VizNode>): Set<string> {
	const connected = new Set<string>();
	const quarantined = new Set(projection.quarantine?.map((entry) => entry.id));
	for (const edge of projection.edges) {
		const source = nodes.get(edge.source);
		const target = nodes.get(edge.target);
		if (source?.type === "genre" && target?.type === "genre" && source.id !== target.id) {
			connected.add(source.id);
			connected.add(target.id);
		}
	}
	for (const node of projection.nodes) {
		if (node.type === "genre" && !connected.has(node.id)) quarantined.add(node.id);
	}
	return quarantined;
}
function countNeighbours(
	projection: GraphProjection,
	sources: Set<string>,
	nodes: Map<string, VizNode>,
): number {
	const neighbours = new Set<string>();
	for (const edge of projection.edges) {
		const source = nodes.get(edge.source);
		const target = nodes.get(edge.target);
		const neighbour = sources.has(edge.source) ? target : sources.has(edge.target) ? source : undefined;
		if (
			neighbour &&
			(neighbour.type === "artist" || neighbour.type === "project" || neighbour.type === "track")
		) {
			neighbours.add(neighbour.id);
		}
	}
	return neighbours.size;
}
export async function measureGenreCoverage(
	taxonomy: GenreTaxonomy,
	cache: NodeCache,
	projection: GraphProjection,
): Promise<GenreCoverageReport> {
	const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
	const quarantined = quarantinedGenreIds(projection, nodes);
	const owners = new Map<Slug, string>();
	const entries: Record<string, GenreCoverageEntry> = {};
	const families: Record<string, GenreCoverageFamily> = Object.fromEntries(
		taxonomy.families.map((family) => [family.key, { entries: 0, publishable: 0, deficit: 0 }]),
	);
	for (const genre of taxonomy.genres) {
		const candidates = new Set<Slug>(genre.sourceSlugs ?? []);
		if (genre.qid) {
			const qidSource = await cache.findGenreSlugByQid(genre.qid);
			if (qidSource) candidates.add(await resolveReadSlug(qidSource, EMPTY_REDIRECTS, cache));
		}
		const resolvedSources: Slug[] = [];
		const missingSources: Slug[] = [];
		const quarantinedSources: Slug[] = [];
		let sourceQid: string | undefined;
		for (const candidate of candidates) {
			const source = await resolveReadSlug(candidate, EMPTY_REDIRECTS, cache);
			if (!(await cache.has(source))) {
				missingSources.push(source);
				continue;
			}
			const payload = await cache.get(source);
			if (payload.type !== "genre") throw new Error(`Genre source ${source} is not a genre node`);
			const expectedQid = genre.qid ?? sourceQid;
			if (payload.qid && expectedQid && payload.qid !== expectedQid) {
				throw new Error(`Contradictory source QID for genre ${genre.id}`);
			}
			sourceQid ??= payload.qid;
			const owner = owners.get(source);
			if (owner !== undefined && owner !== genre.id) {
				throw new Error(`Source slug ${source} is assigned to multiple genres`);
			}
			owners.set(source, genre.id);
			if (quarantined.has(source)) {
				quarantinedSources.push(source);
			} else if (nodes.get(source)?.type !== "genre") {
				missingSources.push(source);
			} else {
				resolvedSources.push(source);
			}
		}
		const neighbourCount = countNeighbours(projection, new Set(resolvedSources), nodes);
		const deficit = Math.max(0, REQUIRED_NEIGHBOURS - neighbourCount);
		const publishable = resolvedSources.length > 0 && deficit === 0;
		entries[genre.id] = {
			resolvedSources,
			missingSources,
			quarantinedSources,
			neighbourCount,
			deficit,
			publishable,
		};
		const family = families[genre.family];
		if (!family) throw new Error(`Unknown genre family ${genre.family}`);
		family.entries++;
		family.deficit += deficit;
		if (publishable) family.publishable++;
	}

	return { entries, families };
}
