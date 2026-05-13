import { Command } from "commander";
import { crawl } from "./crawler.js";
import { loadEnv } from "./env.js";

const program = new Command();

program.name("odyssey-crawl").description("Culture Graph background crawler (Phase 1)").version("0.1.0");

program
	.command("run", { isDefault: true })
	.requiredOption("-s, --seed <text>", "Seed input (free text, e.g. 'jan jelinek tendency')")
	.requiredOption("-d, --max-depth <n>", "Max BFS depth", (v) => Number.parseInt(v, 10))
	.requiredOption("-n, --max-nodes <n>", "Max total nodes to materialize", (v) => Number.parseInt(v, 10))
	.requiredOption("-o, --out <dir>", "Output cache directory")
	.option("-c, --concurrency <n>", "Number of parallel agent workers", (v) => Number.parseInt(v, 10), 4)
	.option("--quiet", "Suppress per-node logs", false)
	.action(
		async (opts: {
			seed: string;
			maxDepth: number;
			maxNodes: number;
			out: string;
			concurrency: number;
			quiet: boolean;
		}) => {
			const env = loadEnv();
			const t0 = Date.now();
			const crawlOpts = {
				seed: opts.seed,
				maxDepth: opts.maxDepth,
				maxNodes: opts.maxNodes,
				concurrency: opts.concurrency,
				out: opts.out,
				deps: { tavilyApiKey: env.TAVILY_API_KEY, firecrawlApiKey: env.FIRECRAWL_API_KEY },
			};
			const result = await crawl(
				opts.quiet
					? crawlOpts
					: {
							...crawlOpts,
							logger: (line: string): void => {
								process.stderr.write(`${line}\n`);
							},
						},
			);
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

program.parseAsync().catch((e: unknown) => {
	const msg = e instanceof Error ? e.message : String(e);
	process.stderr.write(`error: ${msg}\n`);
	process.exit(1);
});
