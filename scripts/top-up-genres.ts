import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeCache } from "../src/cache.js";
import { type CrawlOptions, crawlGenreSeeds, refreshGenre } from "../src/crawler.js";
import { loadEnv } from "../src/env.js";
import { type GenreCoverageReport, measureGenreCoverage } from "../src/genre-coverage.js";
import { loadGenreResolver } from "../src/genre-identity.js";
import { createGenreRegistry, loadGenreRedirects } from "../src/genre-registry.js";
import { type GenreSeed, type GenreSeeds, loadGenreSeeds } from "../src/genre-seeds.js";
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
export interface GenreTopUpRunResult {
	calls: number;
	consumed: number;
	nodesWritten: number;
	refused: number;
	failed: number;
}
export type GenreTopUpAttempt =
	| { candidateId: string; status: "written" }
	| { candidateId: string; status: "refused" }
	| { candidateId: string; status: "failed"; error: string };
export interface GenreTopUpExecution extends GenreTopUpRunResult {
	attempts: GenreTopUpAttempt[];
}
export type GenreTopUpRunner = (
	candidate: GenreTopUpCandidate,
	maxNodes: number,
) => Promise<GenreTopUpRunResult>;
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
function emptyExecution(): GenreTopUpExecution {
	return { calls: 0, consumed: 0, nodesWritten: 0, refused: 0, failed: 0, attempts: [] };
}
/** Runs only the candidates selected for this batch; the runner receives the shared remaining cap. */
export async function executeGenreTopUp(
	candidates: readonly GenreTopUpCandidate[],
	maxNodes: number,
	runner: GenreTopUpRunner,
): Promise<GenreTopUpExecution> {
	assertNonNegativeInteger(maxNodes, "maxNodes");
	const result = emptyExecution();
	for (const candidate of candidates) {
		const remaining = maxNodes - result.consumed;
		if (remaining === 0) {
			result.refused++;
			result.attempts.push({ candidateId: candidate.id, status: "refused" });
			continue;
		}
		try {
			const run = await runner(candidate, remaining);
			result.calls += run.calls;
			result.consumed += run.consumed;
			result.nodesWritten += run.nodesWritten;
			result.refused += run.refused;
			result.failed += run.failed;
			if (run.failed > 0) {
				result.attempts.push({ candidateId: candidate.id, status: "failed", error: "pipeline failed" });
			} else if (run.refused > 0) {
				result.attempts.push({ candidateId: candidate.id, status: "refused" });
			} else {
				result.attempts.push({ candidateId: candidate.id, status: "written" });
			}
		} catch (error: unknown) {
			result.calls++;
			result.consumed++;
			result.failed++;
			result.attempts.push({
				candidateId: candidate.id,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}
function isGenreSlug(slug: Slug): slug is `genre:${string}` {
	return slug.startsWith("genre:");
}
export function createGenreTopUpRunner(
	cache: NodeCache,
	seeds: GenreSeeds,
	base: CrawlOptions,
): GenreTopUpRunner {
	return async (candidate, maxNodes) => {
		const sourceSlug = candidate.sourceSlug;
		const options = { ...base, maxNodes, concurrency: 1 };
		if (sourceSlug !== undefined && isGenreSlug(sourceSlug) && (await cache.has(sourceSlug))) {
			return refreshGenre(options, sourceSlug);
		}
		const slug =
			sourceSlug !== undefined && isGenreSlug(sourceSlug) ? sourceSlug : makeSlug("genre", candidate.name);
		const folder: GenreSeed = seeds[candidate.id] ?? {
			genre: { slug, name: candidate.name, ...(candidate.qid ? { qid: candidate.qid } : {}) },
			anchors: [],
			targets: [],
		};
		return crawlGenreSeeds(options, { [candidate.id]: folder });
	};
}
export async function createLiveGenreTopUpRunner(
	cache: NodeCache,
	cacheDir: string,
	seeds: GenreSeeds,
): Promise<GenreTopUpRunner> {
	const [resolver, redirects] = await Promise.all([loadGenreResolver(), loadGenreRedirects()]);
	const env = loadEnv();
	const base: CrawlOptions = {
		seed: "genre-top-up",
		maxDepth: 0,
		maxNodes: 0,
		concurrency: 1,
		out: cacheDir,
		deps: {
			tavilyApiKey: env.TAVILY_API_KEY,
			firecrawlApiKey: env.FIRECRAWL_API_KEY,
			genreRegistry: createGenreRegistry({ cache, resolver, redirects }),
		},
	};
	return createGenreTopUpRunner(cache, seeds, base);
}
export async function runGenreTopUp(
	taxonomy: GenreTaxonomy,
	cache: NodeCache,
	projection: GraphProjection,
	seeds: GenreSeeds,
	maxNodes: number,
	options: GenreTopUpOptions = {},
	runner?: GenreTopUpRunner,
): Promise<GenreTopUpPlan & { execution: GenreTopUpExecution }> {
	const plan = await planGenreTopUp(taxonomy, cache, projection, seeds, options);
	if (options.dryRun) return { ...plan, execution: emptyExecution() };
	if (!runner) throw new Error("A genre top-up runner is required outside dry-run mode");
	return { ...plan, execution: await executeGenreTopUp(plan.candidates, maxNodes, runner) };
}
function readOption(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	return args[index + 1];
}
async function main(args = process.argv.slice(2)): Promise<number> {
	try {
		const dryRun = args.includes("--dry-run");
		const cacheDir = readOption(args, "--out") ?? "cache";
		const maxNew = Number.parseInt(readOption(args, "--max-new") ?? String(DEFAULT_MAX_NEW), 10);
		const maxNodesArg = readOption(args, "--max-nodes");
		if (maxNodesArg === undefined) throw new Error("--max-nodes is required");
		const maxNodes = Number.parseInt(maxNodesArg, 10);
		assertNonNegativeInteger(maxNew, "maxNew");
		assertNonNegativeInteger(maxNodes, "maxNodes");
		const taxonomy = validateGenreTaxonomy(
			JSON.parse(await readFile("data/genre-taxonomy.json", "utf8")) as unknown,
		);
		const seeds = await loadGenreSeeds();
		const cache = new NodeCache(cacheDir);
		const projection = await buildGraphFromCache(cacheDir, { quarantineOrphanGenres: true });
		const runner = dryRun ? undefined : await createLiveGenreTopUpRunner(cache, cacheDir, seeds);
		const result = await runGenreTopUp(
			taxonomy,
			cache,
			projection,
			seeds,
			maxNodes,
			{ maxNew, dryRun },
			runner,
		);
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
