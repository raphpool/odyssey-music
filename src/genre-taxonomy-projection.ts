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
// duplicating it. Always measured through its own, isolated measureGenreCoverage call (see below):
// genre-taxonomy.ts's invariants only forbid a real entry's own `qid` from reusing a family's QID,
// not its `sourceSlugs` (the loader accepts a local: entry that lists a family root slug there),
// so sharing one owners registry between probes and real entries could let a single such entry
// throw "assigned to multiple genres" and take the whole projection down with it.
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

function indexId(index: Map<Slug, Set<string>>, slug: Slug, id: string): void {
	let ids = index.get(slug);
	if (!ids) {
		ids = new Set();
		index.set(slug, ids);
	}
	ids.add(id);
}

// Projects a validated GenreTaxonomy onto the already-built base graph: publishable genres, each
// family's slug, and a legacy-slug migration table -- reusing measureGenreCoverage throughout, so
// this never reconstructs the graph or recurses into the cache on its own. Assumes `taxonomy` came
// from loadGenreTaxonomy: every genre's sourceSlugs is already canonicalized (a live node winning
// over its own stale redirect entry) and guaranteed present in `cache`.
export async function projectGenreTaxonomy(
	taxonomy: GenreTaxonomy,
	cache: NodeCache,
	graph: GraphProjection,
	redirects: GenreRedirects,
): Promise<GenreTaxonomyProjection> {
	const report = await measureGenreCoverage(taxonomy, cache, graph);
	const probes = taxonomy.families.flatMap((family) => familyProbe(family) ?? []);
	const probeReport =
		probes.length === 0
			? undefined
			: await measureGenreCoverage({ version: 2, families: taxonomy.families, genres: probes }, cache, graph);

	// Every exported genre's admissible AND quarantined sources are "known" migration keys --
	// loadGenreTaxonomy guarantees a declared source exists in cache, so quarantine and (below)
	// old redirected slugs are the only ways a key here ends up outside the served graph.
	const idsBySlug = new Map<Slug, Set<string>>();
	const genres: ProjectedTaxonomyGenre[] = [];
	for (const genre of taxonomy.genres) {
		const entry = report.entries[genre.id];
		if (!genre.published || !entry?.publishable) continue;
		genres.push({ id: genre.id, name: genre.name, family: genre.family, slugs: entry.resolvedSources });
		for (const slug of [...entry.resolvedSources, ...entry.quarantinedSources]) {
			indexId(idsBySlug, slug, genre.id);
		}
	}

	const families: ProjectedTaxonomyFamily[] = [];
	for (const family of taxonomy.families) {
		const probe = familyProbe(family);
		const slug = probe ? probeReport?.entries[probe.id]?.resolvedSources[0] : undefined;
		families.push({
			key: family.key,
			label: family.label,
			order: family.order,
			...(family.qid === undefined ? {} : { qid: family.qid }),
			...(slug === undefined ? {} : { slug }),
		});
		// Old family slug -> published children within it.
		if (slug !== undefined) {
			for (const child of genres) if (child.family === family.key) indexId(idsBySlug, slug, child.id);
		}
	}

	// A redirect's old slug is a migration key only when it is itself dead. A live old slug keeps
	// resolving to whatever it is a real source of (already indexed above, if anything) and never
	// inherits its target's ids -- this is resolveReadSlug's "a live node always wins" rule,
	// applied here directly rather than through measureGenreCoverage (which performs no redirect
	// resolution of its own at all -- see genre-coverage.ts, TRA-235).
	//
	// TRA-235 (review nit on TRA-133): this is a single hop by design, not by oversight. A chain
	// (a -> b -> c, b itself retired) can never reach `redirects` here: parseGenreRedirects (this
	// table's only producer, genre-registry.ts) throws "genre-redirects.json is not flattened" the
	// moment any value also appears as a key, before this function -- or anything else -- ever sees
	// the table (see test/genre-registry.test.ts, "rejects a table where a value is also a key").
	// Walking a multi-hop chain here would be defensive code against an input the loader already
	// makes structurally impossible.
	for (const [loser, target] of redirects) {
		// The table covers every node type since TRA-453 (project/track renames); only genre
		// keys can matter here, and skipping the rest avoids a disk read per non-genre key.
		if (!loser.startsWith("genre:") || (await cache.has(loser))) continue;
		const targetIds = idsBySlug.get(target);
		if (!targetIds) continue;
		for (const id of targetIds) indexId(idsBySlug, loser, id);
	}

	const legacySelectionBySlug: Record<Slug, string[]> = {};
	for (const [slug, ids] of idsBySlug) legacySelectionBySlug[slug] = [...ids];

	return { version: 2, families, genres, legacySelectionBySlug };
}
