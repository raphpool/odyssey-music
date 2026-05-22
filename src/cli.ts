import { Command } from "commander";
import { cliConfig } from "./config.js";
import { type CrawlOptions, type CrawlProgress, crawl } from "./crawler.js";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";

const program = new Command();
const log = logger.child({ module: "cli" });

program.name("odyssey-crawl").description("Culture Graph background crawler (Phase 1)").version("0.1.0");

program
	.command("run", { isDefault: true })
	.requiredOption("-s, --seed <text>", "Seed input (free text, e.g. 'jan jelinek tendency')")
	.requiredOption("-d, --max-depth <n>", "Max BFS depth", (v) => Number.parseInt(v, 10))
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
			seed: string;
			maxDepth: number;
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
			const env = loadEnv();
			const t0 = Date.now();
			const strategy: "bfs" | "popularity" | "hybrid" =
				opts.strategy === "bfs" ? "bfs" : opts.strategy === "popularity" ? "popularity" : "hybrid";
			const base: CrawlOptions = {
				seed: opts.seed,
				maxDepth: opts.maxDepth,
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

			const result = await crawl(base);
			const summary = {
				seed: opts.seed,
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

program.parseAsync().catch((e: unknown) => {
	const msg = e instanceof Error ? e.message : String(e);
	log.error("command failed", { error: msg });
	process.exit(1);
});
