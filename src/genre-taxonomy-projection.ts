import type { NodeCache } from "./cache.js";
import { measureGenreCoverage } from "./genre-coverage.js";
import type { GenreRedirects } from "./genre-registry.js";
import type { GenreTaxonomy, GenreTaxonomyEntry } from "./genre-taxonomy.js";
import type { GraphProjection } from "./graph.js";
import type { Slug } from "./types.js";

export interface ProjectedTaxonomyFamily {
	key: string;
	label: string;
	order: number;
	qid?: string;
	slug?: Slug;
}

export interface ProjectedTaxonomyGenre {
	id: string;
	name: string;
	family: string;
	slugs: Slug[];
}

export interface GenreTaxonomyProjection {
	version: 2;
	families: ProjectedTaxonomyFamily[];
	genres: ProjectedTaxonomyGenre[];
	legacySelectionBySlug: Record<Slug, string[]>;
}

// Disjoint from real taxonomy ids (QIDs or "local:*"), so a probe never collides with a real entry.
const FAMILY_PROBE_PREFIX = "family-root:";

// Stands in for a family's own root genre node, so resolving "is this family's QID materialized
// and not quarantined" reuses measureGenreCoverage's resolution/quarantine logic instead of
// duplicating it; genre-taxonomy.ts already forbids a real entry from reusing a family's QID.
function familyProbe(family: GenreTaxonomy["families"][number]): GenreTaxonomyEntry | undefined {
	if (family.qid === undefined) return undefined;
	return {
		id: `${FAMILY_PROBE_PREFIX}${family.key}`,
		qid: family.qid,
		name: family.label,
		family: family.key,
		published: true,
	};
}

// Projects a validated GenreTaxonomy onto the already-built base graph: publishable genres, each
// family's slug, and a legacy-slug migration table -- reusing measureGenreCoverage throughout, so
// this never reconstructs the graph or recurses into the cache on its own.
export async function projectGenreTaxonomy(
	taxonomy: GenreTaxonomy,
	cache: NodeCache,
	graph: GraphProjection,
	redirects: GenreRedirects,
): Promise<GenreTaxonomyProjection> {
	const probes = taxonomy.families.flatMap((family) => familyProbe(family) ?? []);
	const report = await measureGenreCoverage(
		{ version: 2, families: taxonomy.families, genres: [...taxonomy.genres, ...probes] },
		cache,
		graph,
	);

	const legacySelectionBySlug: Record<Slug, string[]> = {};
	const addLegacy = (slug: Slug, id: string): void => {
		if (!legacySelectionBySlug[slug]) legacySelectionBySlug[slug] = [];
		legacySelectionBySlug[slug].push(id);
	};

	const genres: ProjectedTaxonomyGenre[] = [];
	for (const genre of taxonomy.genres) {
		const entry = report.entries[genre.id];
		if (!genre.published || !entry?.publishable) continue;
		genres.push({ id: genre.id, name: genre.name, family: genre.family, slugs: entry.resolvedSources });
		// Every declared source (even a missing one, so a stored legacy pick still resolves).
		const known = new Set<Slug>([...(genre.sourceSlugs ?? []), ...entry.resolvedSources]);
		for (const slug of known) addLegacy(slug, genre.id);
		for (const [loser, target] of redirects) {
			if (entry.resolvedSources.includes(target)) addLegacy(loser, genre.id);
		}
	}

	const families: ProjectedTaxonomyFamily[] = [];
	for (const family of taxonomy.families) {
		const probe = familyProbe(family);
		const slug = probe ? report.entries[probe.id]?.resolvedSources[0] : undefined;
		families.push({
			key: family.key,
			label: family.label,
			order: family.order,
			...(family.qid === undefined ? {} : { qid: family.qid }),
			...(slug === undefined ? {} : { slug }),
		});
		// Old family slug -> published children within it.
		if (slug !== undefined) {
			const children = genres.filter((entry) => entry.family === family.key).map((entry) => entry.id);
			if (children.length > 0) legacySelectionBySlug[slug] = children;
		}
	}

	return { version: 2, families, genres, legacySelectionBySlug };
}
