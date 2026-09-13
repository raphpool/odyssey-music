import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeCache } from "../src/cache.js";
import { type GenreCoverageReport, measureGenreCoverage } from "../src/genre-coverage.js";
import { type GenreSeeds, loadGenreSeeds } from "../src/genre-seeds.js";
import { type GenreTaxonomy, validateGenreTaxonomy } from "../src/genre-taxonomy.js";
import { buildGraphFromCache, type GraphProjection } from "../src/graph.js";
import { makeSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";

const DEFAULT_FAMILY_FLOOR = 5;
const DEFAULT_MAX_NEW = 20;
export type GenreTopUpPriority = "family-deficit" | "required" | "reserve";
export interface GenreTopUpCandidate {
	id: string;
	name: string;
	family: string;
	deficit: number;
	priority: GenreTopUpPriority;
	sourceSlug?: Slug;
	qid?: string;
}
export interface GenreTopUpOptions {
	maxNew?: number;
	familyFloor?: number;
	dryRun?: boolean;
}
export interface GenreTopUpPlan {
	coverage: GenreCoverageReport;
	candidates: GenreTopUpCandidate[];
}
export type MeasureGenreCoverage = (
	taxonomy: GenreTaxonomy,
	cache: NodeCache,
	projection: GraphProjection,
) => Promise<GenreCoverageReport>;

function assertNonNegativeInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}
export function selectGenreTopUps(
	taxonomy: GenreTaxonomy,
	coverage: GenreCoverageReport,
	seeds: GenreSeeds,
	options: GenreTopUpOptions = {},
): GenreTopUpCandidate[] {
	const maxNew = options.maxNew ?? DEFAULT_MAX_NEW;
	const familyFloor = options.familyFloor ?? DEFAULT_FAMILY_FLOOR;
	assertNonNegativeInteger(maxNew, "maxNew");
	assertNonNegativeInteger(familyFloor, "familyFloor");
	const familyOrder = new Map(taxonomy.families.map((family) => [family.key, family.order]));
	const candidates = taxonomy.genres.flatMap((genre) => {
		const entry = coverage.entries[genre.id];
		if (!entry) throw new Error(`Coverage entry missing from taxonomy: ${genre.id}`);
		if (entry.publishable) return [];
		const family = coverage.families[genre.family];
		if (!family) throw new Error(`Coverage family missing from taxonomy: ${genre.family}`);

		// Required choices stay ahead of optional reserves even when their family is already healthy.
		const priority: GenreTopUpPriority =
			family.publishable < familyFloor
				? "family-deficit"
				: genre.published || seeds[genre.id] !== undefined
					? "required"
					: "reserve";
		const sourceSlug =
			entry.missingSources[0] ??
			entry.quarantinedSources[0] ??
			entry.resolvedSources[0] ??
			seeds[genre.id]?.genre.slug ??
			makeSlug("genre", genre.name);
		const candidate: GenreTopUpCandidate = {
			id: genre.id,
			name: genre.name,
			family: genre.family,
			deficit: entry.deficit,
			priority,
		};
		if (sourceSlug !== undefined) candidate.sourceSlug = sourceSlug as Slug;
		if (genre.qid !== undefined) candidate.qid = genre.qid;
		return [candidate];
	});
	const priorityOrder: Record<GenreTopUpPriority, number> = {
		"family-deficit": 0,
		required: 1,
		reserve: 2,
	};
	return candidates
		.sort(
			(left, right) =>
				priorityOrder[left.priority] - priorityOrder[right.priority] ||
				right.deficit - left.deficit ||
				(familyOrder.get(left.family) ?? Number.MAX_SAFE_INTEGER) -
					(familyOrder.get(right.family) ?? Number.MAX_SAFE_INTEGER) ||
				(left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
		)
		.slice(0, maxNew);
}
export async function planGenreTopUp(
	taxonomy: GenreTaxonomy,
	cache: NodeCache,
	projection: GraphProjection,
	seeds: GenreSeeds,
	options: GenreTopUpOptions = {},
	measure: MeasureGenreCoverage = measureGenreCoverage,
): Promise<GenreTopUpPlan> {
	const coverage = await measure(taxonomy, cache, projection);
	return { coverage, candidates: selectGenreTopUps(taxonomy, coverage, seeds, options) };
}
export async function topUpGenres(
	taxonomy: GenreTaxonomy,
	cache: NodeCache,
	projection: GraphProjection,
	seeds: GenreSeeds,
	options: GenreTopUpOptions = {},
	measure: MeasureGenreCoverage = measureGenreCoverage,
): Promise<GenreTopUpPlan> {
	return planGenreTopUp(taxonomy, cache, projection, seeds, options, measure);
}
async function main(args = process.argv.slice(2)): Promise<number> {
	try {
		const dryRun = args.includes("--dry-run");
		const positional = args.filter((argument) => argument !== "--dry-run");
		const cacheDir = positional[0] ?? "cache";
		const maxNew = Number.parseInt(positional[1] ?? String(DEFAULT_MAX_NEW), 10);
		assertNonNegativeInteger(maxNew, "maxNew");
		const taxonomy = validateGenreTaxonomy(
			JSON.parse(await readFile("data/genre-taxonomy.json", "utf8")) as unknown,
		);
		const seeds = await loadGenreSeeds();
		const cache = new NodeCache(cacheDir);
		const projection = await buildGraphFromCache(cacheDir, { quarantineOrphanGenres: true });
		const result = await topUpGenres(taxonomy, cache, projection, seeds, { maxNew, dryRun });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return 0;
	} catch (error: unknown) {
		process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
	void main().then((status) => {
		process.exitCode = status;
	});
}
