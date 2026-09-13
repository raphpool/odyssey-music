import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { cliConfig } from "./config.js";
import { type CrawlOptions, type CrawlProgress, crawl, crawlGenreSeeds, refreshGenre } from "./crawler.js";
import { loadEnv } from "./env.js";
import { type GenreSeeds, loadGenreSeeds } from "./genre-seeds.js";
import { logger } from "./logger.js";

export const program = new Command();
const log = logger.child({ module: "cli" });

type GenreTaxonomy = {
	families: readonly { key: string }[];
	genres: readonly { id: string; family: string }[];
};

type CliMode =
	| { kind: "text"; seed: string; maxDepth: number }
	| { kind: "genre-seeds"; path: string; genreId?: string; family?: string }
	| { kind: "genre-refresh"; slug: string };

type GenreSeedRunner = (options: CrawlOptions, seeds: GenreSeeds) => Promise<Record<string, unknown>>;

type CliModeOptions = {
	seed?: string;
	genreSeeds?: string;
	genreId?: string;
	family?: string;
	refreshGenre?: string;
	maxDepth?: number;
};

export function resolveCliMode(options: CliModeOptions): CliMode {
	const selectorCount = [options.genreId, options.family].filter((value) => value !== undefined).length;

	if (
		options.seed !== undefined &&
		(options.genreSeeds !== undefined || options.refreshGenre !== undefined)
	) {
		throw new Error("--genre-seeds and --refresh-genre are exclusive of --seed");
	}
	if (options.refreshGenre !== undefined) {
		if (options.genreSeeds !== undefined || selectorCount > 0) {
			throw new Error("--refresh-genre is exclusive of --genre-seeds, --genre-id, and --family");
		}
		return { kind: "genre-refresh", slug: options.refreshGenre };
	}
	if (options.genreSeeds !== undefined) {
		if (selectorCount !== 1) {
			throw new Error("--genre-seeds requires exactly one of --genre-id or --family");
		}
		if (options.genreId !== undefined) {
			return { kind: "genre-seeds", path: options.genreSeeds, genreId: options.genreId };
		}
		if (options.family !== undefined) {
			return { kind: "genre-seeds", path: options.genreSeeds, family: options.family };
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

program.name("odyssey-crawl").description("Culture Graph background crawler (Phase 1)").version("0.1.0");

program
	.command("run", { isDefault: true })
	.option("-s, --seed <text>", "Seed input (free text, e.g. 'jan jelinek tendency')")
	.option("--genre-seeds <path>", "Validated genre seed registry JSON")
	.option("--genre-id <id>", "Select one genre seed by taxonomy ID")
	.option("--family <key>", "Select all genre seeds in one taxonomy family")
	.option("--refresh-genre <slug>", "Refresh one cached genre without traversing its references")
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
			const env = loadEnv();
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
				deps: {
					tavilyApiKey: env.TAVILY_API_KEY,
					firecrawlApiKey: env.FIRECRAWL_API_KEY,
				},
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
				const taxonomy = await loadGenreTaxonomy(taxonomyPath);
				const seeds = await loadGenreSeeds(mode.path, taxonomyPath);
				const selected = selectGenreSeeds(seeds, mode, taxonomy);
				const result = await runGenreSeedCrawl(base, selected);
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
				const result = await refreshGenre(base, mode.slug as `genre:${string}`);
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

async function loadGenreTaxonomy(filePath: string): Promise<GenreTaxonomy> {
	const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
	if (!isRecord(raw) || !Array.isArray(raw.families) || !Array.isArray(raw.genres)) {
		throw new Error(`Invalid genre taxonomy in ${filePath}`);
	}

	const families = raw.families.map((family) => {
		if (!isRecord(family) || typeof family.key !== "string") {
			throw new Error(`Invalid genre taxonomy family in ${filePath}`);
		}
		return { key: family.key };
	});
	const genres = raw.genres.map((genre) => {
		if (!isRecord(genre) || typeof genre.id !== "string" || typeof genre.family !== "string") {
			throw new Error(`Invalid genre taxonomy genre in ${filePath}`);
		}
		return { id: genre.id, family: genre.family };
	});
	return { families, genres };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
