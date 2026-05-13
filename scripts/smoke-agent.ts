import { runAgent } from "../src/agent.js";
import { loadEnv } from "../src/env.js";

async function main(): Promise<void> {
	const env = loadEnv();
	const seed = process.argv[2] ?? "jan jelinek tendency";
	process.stderr.write(`[smoke] seed=${JSON.stringify(seed)}\n`);
	const t0 = Date.now();
	const r = await runAgent(
		{ text: seed },
		{
			tavilyApiKey: env.TAVILY_API_KEY,
			firecrawlApiKey: env.FIRECRAWL_API_KEY,
			logger: (line) => process.stderr.write(`AGENT ${line}\n`),
		},
	);
	const ms = Date.now() - t0;
	process.stderr.write(`[smoke] OK ${r.slug} turns=${r.turns} ${ms}ms\n`);
	process.stdout.write(`${JSON.stringify(r.node, null, 2)}\n`);
}

main().catch((e: unknown) => {
	process.stderr.write(`[smoke] FAIL: ${e instanceof Error ? e.stack : String(e)}\n`);
	process.exit(1);
});
