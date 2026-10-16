import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { NodeCache } from "./cache.js";
import { cliConfig } from "./config.js";
import {
	backfillSeedGenres,
	type CrawlOptions,
	type CrawlProgress,
	crawl,
	crawlGenreSeeds,
	refreshGenre,
} from "./crawler.js";
import { type ApiEnv, loadEnv } from "./env.js";
import { type GenreSeed, type GenreSeeds, loadGenreSeeds } from "./genre-seeds.js";
import { type GenreTaxonomy as CanonicalGenreTaxonomy, validateGenreTaxonomy } from "./genre-taxonomy.js";
import { resolveImage } from "./images/resolve-image.js";
import { logger } from "./logger.js";
import type { PipelineDeps } from "./pipeline.js";

export const program = new Command();
const log = logger.child({ module: "cli" });

type GenreTaxonomy = {
	families: readonly { key: string }[];
	genres: readonly { id: string; family: string }[];
};

type CliMode =
	| { kind: "text"; seed: string; maxDepth: number }
	| { kind: "genre-seeds"; path: string; genreId?: string; family?: string; backfill?: boolean }
	| { kind: "genre-refresh"; slug: string; genreSeedsPath?: string };

type GenreSeedRunner = (options: CrawlOptions, seeds: GenreSeeds) => Promise<Record<string, unknown>>;

type CliModeOptions = {
	seed?: string;
	genreSeeds?: string;
	genreId?: string;
	family?: string;
	refreshGenre?: string;
	maxDepth?: number;
	backfillSeedGenres?: boolean;
};

// TRA-242: --search-provider is validated up front, before loadEnv() or any network call, so
// an unknown value fails fast with a clear message instead of surfacing deep inside the pipeline.
export function resolveSearchProvider(value: string): "tavily" | "firecrawl" {
	if (value === "tavily" || value === "firecrawl") return value;
	throw new Error(`--search-provider must be "tavily" or "firecrawl" (got: ${value})`);
}

// Extracted (TRA-242 review) so the CLI -> pipeline wiring for searchProvider is itself
// testable: inlined in the action closure, a dropped `searchProvider` field is invisible to
// every existing test (nothing asserts on `deps` directly), so the CLI's --search-provider
// flag could silently stop reaching the pipeline without a single red test.
export function buildCrawlDeps(
	searchProvider: "tavily" | "firecrawl",
	env: ApiEnv,
	// TRA-479: the cache directory the crawl writes to. Given, the nodes it materializes get an image
	// (a derived cover reads edges already in that cache). Left out, no image step -- as before.
	out?: string,
): PipelineDeps {
	return {
		tavilyApiKey: env.TAVILY_API_KEY,
		firecrawlApiKey: env.FIRECRAWL_API_KEY,
		searchProvider,
		...(out === undefined
			? {}
			: { resolveImage: (node) => resolveImage(node, { cache: new NodeCache(out) }) }),
	};
}

export function resolveCliMode(options: CliModeOptions): CliMode {
	const selectorCount = [options.genreId, options.family].filter((value) => value !== undefined).length;

	// TRA-263: the backfill mode only rewrites nodes already read from a --genre-seeds plan --
	// it has no seed source of its own.
	if (options.backfillSeedGenres && options.genreSeeds === undefined) {
		throw new Error("--backfill-seed-genres requires --genre-seeds");
	}
	if (
		options.seed !== undefined &&
		(options.genreSeeds !== undefined || options.refreshGenre !== undefined)
	) {
		throw new Error("--genre-seeds and --refresh-genre are exclusive of --seed");
	}
	if (options.refreshGenre !== undefined) {
		// TRA-252: --genre-seeds is allowed alongside --refresh-genre (not exclusive of it) —
		// it names the seed dossier registry to look up the target genre's curated QID in,
		// so a targeted refresh can stamp/verify it. --genre-id and --family remain exclusive:
		// they select genre-seeds *crawl* mode's batch, which doesn't apply to a single refresh.
		if (selectorCount > 0) {
			throw new Error("--refresh-genre is exclusive of --genre-id and --family");
		}
		return {
			kind: "genre-refresh",
			slug: options.refreshGenre,
			...(options.genreSeeds !== undefined ? { genreSeedsPath: options.genreSeeds } : {}),
		};
	}
	if (options.genreSeeds !== undefined) {
		if (selectorCount !== 1) {
			throw new Error("--genre-seeds requires exactly one of --genre-id or --family");
		}
		if (options.genreId !== undefined) {
			return {
				kind: "genre-seeds",
				path: options.genreSeeds,
				genreId: options.genreId,
				...(options.backfillSeedGenres ? { backfill: true } : {}),
			};
		}
		if (options.family !== undefined) {
			return {
				kind: "genre-seeds",
				path: options.genreSeeds,
				family: options.family,
				...(options.backfillSeedGenres ? { backfill: true } : {}),
			};
		}
	}
	if (selectorCount > 0) {
		throw new Error("--genre-id and --family require --genre-seeds");
	}
	if (options.seed === undefined) {
		throw new Error("--seed is required unless --genre-seeds is provided");
	}
	if (options.maxDepth === undefined) {
		throw new Error("--max-depth is required with --seed");
	}
	return { kind: "text", seed: options.seed, maxDepth: options.maxDepth };
}

export function selectGenreSeeds(
	seeds: GenreSeeds,
	mode: Extract<CliMode, { kind: "genre-seeds" }>,
	taxonomy: GenreTaxonomy,
): GenreSeeds {
	if (mode.genreId !== undefined) {
		const selected = seeds[mode.genreId];
		if (selected === undefined) {
			throw new Error(`No genre seed found for --genre-id ${mode.genreId}`);
		}
		return { [mode.genreId]: selected };
	}

	if (mode.family === undefined || !taxonomy.families.some((family) => family.key === mode.family)) {
		throw new Error(`Unknown genre family: ${mode.family ?? ""}`);
	}
	const genreIds = new Set(
		taxonomy.genres.filter((genre) => genre.family === mode.family).map((genre) => genre.id),
	);
	const selectedEntries = Object.entries(seeds).filter(
		([id, seed]) => genreIds.has(id) || (seed.genre.qid !== undefined && genreIds.has(seed.genre.qid)),
	);
	if (selectedEntries.length === 0) {
		throw new Error(`No genre seeds found for --family ${mode.family}`);
	}
	return Object.fromEntries(selectedEntries);
}

const defaultGenreSeedRunner: GenreSeedRunner = async (options, seeds) => ({
	...(await crawlGenreSeeds(options, seeds)),
});

export async function runGenreSeedCrawl(
	options: CrawlOptions,
	seeds: GenreSeeds,
	runner: GenreSeedRunner = defaultGenreSeedRunner,
): Promise<Record<string, unknown>> {
	return runner(options, seeds);
}

// TRA-252: locates the curated seed dossier for a --refresh-genre slug, so refreshGenre can
// inherit/verify its QID. Matched by the dossier's own genre slug, not the taxonomy key — the
// key can be a QID or a "local:" id, neither of which is the slug the CLI is refreshing.
export function findGenreSeedFolder(seeds: GenreSeeds, slug: string): GenreSeed | undefined {
	return Object.values(seeds).find((folder) => folder.genre.slug === slug);
}

program.name("odyssey-crawl").description("Culture Graph background crawler (Phase 1)").version("0.1.0");

program
	.command("run", { isDefault: true })
	.option("-s, --seed <text>", "Seed input (free text, e.g. 'jan jelinek tendency')")
	.option(
		"--genre-seeds <path>",
		"Validated genre seed registry JSON. With --refresh-genre, looks up that genre's dossier for its QID.",
	)
	.option("--genre-id <id>", "Select one genre seed by taxonomy ID")
	.option("--family <key>", "Select all genre seeds in one taxonomy family")
	.option("--refresh-genre <slug>", "Refresh one cached genre without traversing its references")
	.option(
		"--backfill-seed-genres",
		"With --genre-seeds, relink cached targets missing their folder's genre edge (no pipeline calls)",
		false,
	)
	.option("-d, --max-depth <n>", "Max BFS depth", (v) => Number.parseInt(v, 10))
	.requiredOption("-n, --max-nodes <n>", "Max total nodes to materialize", (v) => Number.parseInt(v, 10))
	.requiredOption("-o, --out <dir>", "Output cache directory")
	.option("-c, --concurrency <n>", "Parallel agent workers", (v) => Number.parseInt(v, 10), 4)
	.option(
		"-r, --reasoning <level>",
		"Pi thinkingLevel: off|minimal|low|medium|high|xhigh (default off)",
		"off",
	)
	.option(
		"--search-provider <p>",
		"Web search backend: tavily | firecrawl (default tavily). Use firecrawl when Tavily quota is exhausted.",
		"tavily",
	)
	.option(
		"--fetcher <p>",
		"Page fetcher: local (fetch + Mozilla Readability + Turndown, ~300ms, default) | firecrawl (1-8s, more robust on JS-rendered/anti-bot sites).",
		"local",
	)
	.option(
		"--strategy <s>",
		"Frontier order: bfs | popularity | hybrid (default hybrid — BFS head then popularity).",
		"hybrid",
	)
	.option(
		"--bfs-head <n>",
		"With --strategy hybrid, how many BFS pops before switching to popularity.",
		(v) => Number.parseInt(v, 10),
		40,
	)
	.option("--heartbeat-ms <n>", "Heartbeat interval (ms)", (v) => Number.parseInt(v, 10), 90_000)
	.option(
		"--heartbeat-webhook <url>",
		"POST a JSON progress snapshot here every heartbeat (e.g. WA bridge URL)",
	)
	.option("--heartbeat-payload <json>", "Static JSON merged into each heartbeat POST body")
	.option("--quiet", "Suppress per-node logs", false)
	.action(
		async (opts: {
			seed?: string;
			genreSeeds?: string;
			genreId?: string;
			family?: string;
			refreshGenre?: string;
			backfillSeedGenres: boolean;
			maxDepth?: number;
			maxNodes: number;
			out: string;
			concurrency: number;
			reasoning: string;
			searchProvider: string;
			fetcher: string;
			strategy: string;
			bfsHead: number;
			heartbeatMs: number;
			heartbeatWebhook?: string;
			heartbeatPayload?: string;
			quiet: boolean;
		}) => {
			const mode = resolveCliMode(opts);
			const searchProvider = resolveSearchProvider(opts.searchProvider);
			const isBackfill = mode.kind === "genre-seeds" && mode.backfill === true;
			// TRA-263: backfillSeedGenres makes no pipeline or search call (it only relinks nodes
			// already on disk), so it needs none of the provider API keys loadEnv() would
			// otherwise require -- forcing them here would block a pure cache-maintenance run in
			// an environment that never configured Gemini/Tavily/Firecrawl.
			const deps: PipelineDeps = isBackfill
				? { tavilyApiKey: "", firecrawlApiKey: "" }
				: buildCrawlDeps(searchProvider, loadEnv({ searchProvider }), opts.out);
			const t0 = Date.now();
			const strategy: "bfs" | "popularity" | "hybrid" =
				opts.strategy === "bfs" ? "bfs" : opts.strategy === "popularity" ? "popularity" : "hybrid";
			const base: CrawlOptions = {
				seed: mode.kind === "text" ? mode.seed : mode.kind === "genre-seeds" ? "genre-seeds" : mode.slug,
				maxDepth: mode.kind === "text" ? mode.maxDepth : 0,
				maxNodes: opts.maxNodes,
				concurrency: opts.concurrency,
				out: opts.out,
				heartbeatMs: opts.heartbeatMs,
				strategy,
				bfsHead: opts.bfsHead,
				deps,
			};
			if (!opts.quiet) {
				base.logger = (line: string): void => {
					log.info(line);
				};
			}
			const extraPayload = opts.heartbeatPayload
				? (JSON.parse(opts.heartbeatPayload) as Record<string, unknown>)
				: {};
			if (opts.heartbeatWebhook && !isAllowedWebhookUrl(opts.heartbeatWebhook)) {
				throw new Error(
					`--heartbeat-webhook must be an http(s) URL targeting localhost or 127.0.0.1 (got: ${opts.heartbeatWebhook}). ` +
						"Arbitrary internal URLs are blocked to prevent SSRF when the CLI is wrapped by a service.",
				);
			}
			base.onHeartbeat = (snap: CrawlProgress): void => {
				const line = formatHeartbeat(snap);
				log.info(`HEARTBEAT ${line}`);
				if (opts.heartbeatWebhook) {
					void postHeartbeat(opts.heartbeatWebhook, snap, line, extraPayload);
				}
			};

			if (mode.kind === "genre-seeds") {
				const taxonomyPath = join(dirname(mode.path), "genre-taxonomy.json");
				const taxonomy = await readGenreTaxonomy(taxonomyPath);
				const seeds = await loadGenreSeeds(mode.path, taxonomyPath);
				const selected = selectGenreSeeds(seeds, mode, taxonomy);
				const result = mode.backfill
					? await backfillSeedGenres(base, selected)
					: await runGenreSeedCrawl(base, selected);
				process.stdout.write(
					`${JSON.stringify(
						{
							genreSeeds: mode.path,
							...(mode.genreId !== undefined ? { genreId: mode.genreId } : { family: mode.family }),
							out: opts.out,
							...result,
							wallSec: Math.round((Date.now() - t0) / 1000),
						},
						null,
					)}\n`,
				);
				return;
			}
			if (mode.kind === "genre-refresh") {
				// TRA-252: --genre-seeds, when given alongside --refresh-genre, names the seed
				// dossier registry to look the target genre up in (by its slug, not the taxonomy
				// key — see findGenreSeedFolder). Its QID is then inherited/verified by refreshGenre.
				const seedFolder = mode.genreSeedsPath
					? findGenreSeedFolder(
							await loadGenreSeeds(
								mode.genreSeedsPath,
								join(dirname(mode.genreSeedsPath), "genre-taxonomy.json"),
							),
							mode.slug,
						)
					: undefined;
				const result = await refreshGenre(base, mode.slug as `genre:${string}`, seedFolder);
				process.stdout.write(
					`${JSON.stringify(
						{
							refreshGenre: mode.slug,
							out: opts.out,
							...result,
							wallSec: Math.round((Date.now() - t0) / 1000),
						},
						null,
					)}\n`,
				);
				return;
			}

			const result = await crawl(base);
			const summary = {
				seed: mode.seed,
				out: opts.out,
				nodesWritten: result.nodesWritten,
				revUpdates: result.revUpdates,
				failed: result.failed,
				durationMs: result.durationMs,
				wallSec: Math.round((Date.now() - t0) / 1000),
			};
			process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		},
	);

// TRA-231: this used to be a local, homonymous `loadGenreTaxonomy` doing its own
// minimal parsing (only checking that families[].key / genres[].id / genres[].family
// were strings), never calling the canonical validator. It silently accepted
// taxonomies the canonical loader would reject (duplicate ids, undeclared families).
// We now delegate validation to `validateGenreTaxonomy` (src/genre-taxonomy.ts), the
// same one `loadGenreSeeds` already uses. We deliberately don't call the canonical
// `loadGenreTaxonomy` export itself: it also resolves sources via `loadSources`,
// which opens a NodeCache on the taxonomy file's own directory and throws if a
// `sourceSlugs` entry isn't in that cache -- coupling the CLI's crawl mode to the
// repo cache instead of the `-o` output cache, and breaking on cache-less fixtures.
export async function readGenreTaxonomy(filePath: string): Promise<CanonicalGenreTaxonomy> {
	return validateGenreTaxonomy(JSON.parse(await readFile(filePath, "utf8")));
}

function formatHeartbeat(s: CrawlProgress): string {
	const elapsedSec = Math.round(s.elapsedMs / 1000);
	const eta = s.etaSec > 0 ? `~${s.etaSec}s ETA` : "ETA n/a";
	const last = s.lastCompleted ? ` last=${s.lastCompleted}` : "";
	return (
		`nodes=${s.nodesWritten}/${s.maxNodes} fails=${s.failed} ` +
		`frontier=${s.frontierSize} inflight=${s.inFlight} ` +
		`elapsed=${elapsedSec}s ${eta} (${s.nodesPerMin}/min)${last}`
	);
}

function isAllowedWebhookUrl(s: string): boolean {
	try {
		const u = new URL(s);
		if (u.protocol !== "http:" && u.protocol !== "https:") return false;
		// Restrict to localhost by default. If you need to call out, set ODYSSEY_WEBHOOK_ALLOW
		// to a comma-separated host allowlist (e.g. "example.com,api.example.com").
		const localhost = ["localhost", "127.0.0.1", "[::1]", "::1"];
		const host = u.hostname.toLowerCase();
		return localhost.includes(host) || cliConfig.webhookAllowlist.includes(host);
	} catch {
		return false;
	}
}

async function postHeartbeat(
	webhookUrl: string,
	snap: CrawlProgress,
	line: string,
	extra: Record<string, unknown>,
): Promise<void> {
	try {
		const body = JSON.stringify({ ...extra, text: `crawl: ${line}`, progress: snap });
		await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
	} catch (e) {
		log.warn("heartbeat POST error", { error: e instanceof Error ? e.message : String(e) });
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	program.parseAsync().catch((e: unknown) => {
		const msg = e instanceof Error ? e.message : String(e);
		log.error("command failed", { error: msg });
		process.exit(1);
	});
}
