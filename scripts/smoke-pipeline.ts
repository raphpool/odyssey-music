import { loadEnv } from "../src/env.js";
import { type PipelineInput, runPipeline } from "../src/pipeline.js";

const SEEDS: PipelineInput[] = [
	{ type: "track", name: "Tendency", disambiguator: "Jan Jelinek" },
	{ type: "artist", name: "Aphex Twin" },
	{ type: "label", name: "Warp Records" },
	{ type: "genre", name: "Ambient techno" },
	{ type: "project", name: "Selected Ambient Works 85-92" },
	{ type: "artist", name: "Ryoji Ikeda" },
	{ type: "track", name: "Windowlicker", disambiguator: "Aphex Twin" },
	{ type: "label", name: "Mille Plateaux" },
];

async function main(): Promise<void> {
	const env = loadEnv();
	const concurrency = Number.parseInt(process.argv[2] ?? "4", 10);
	const seeds = SEEDS.slice(0, Number.parseInt(process.argv[3] ?? "8", 10));
	console.log(`[pipeline-bench] ${seeds.length} seeds, concurrency=${concurrency}`);
	const results: {
		slug: string;
		ms: number;
		search: number;
		fetch: number;
		llm: number;
		cost: number;
		tokens: number;
	}[] = [];
	const fails: { input: string; ms: number; err: string }[] = [];
	const queue = [...seeds];
	const t0 = Date.now();
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (true) {
				const seed = queue.shift();
				if (!seed) return;
				const tStart = Date.now();
				try {
					const r = await runPipeline(seed, {
						tavilyApiKey: env.TAVILY_API_KEY,
						firecrawlApiKey: env.FIRECRAWL_API_KEY,
					});
					results.push({
						slug: r.slug,
						ms: r.metrics.totalMs,
						search: r.metrics.searchMs,
						fetch: r.metrics.fetchMs,
						llm: r.metrics.llmMs,
						cost: r.metrics.costUsd,
						tokens: r.metrics.inputTokens + r.metrics.outputTokens,
					});
					console.log(
						`  OK ${r.slug} total=${r.metrics.totalMs}ms (search=${r.metrics.searchMs} fetch=${r.metrics.fetchMs} llm=${r.metrics.llmMs}) tokens=${r.metrics.inputTokens + r.metrics.outputTokens} cost=$${r.metrics.costUsd.toFixed(5)}`,
					);
				} catch (e) {
					const ms = Date.now() - tStart;
					const msg = e instanceof Error ? e.message : String(e);
					fails.push({ input: `${seed.type}:${seed.name}`, ms, err: msg });
					console.log(`  FAIL ${seed.type}:${seed.name} ${ms}ms — ${msg.slice(0, 120)}`);
				}
			}
		}),
	);
	const wall = Date.now() - t0;
	const mss = results.map((r) => r.ms).sort((a, b) => a - b);
	const pct = (p: number): number => mss[Math.min(mss.length - 1, Math.floor(mss.length * p))] ?? 0;
	const avg = mss.length ? mss.reduce((a, b) => a + b, 0) / mss.length : 0;
	console.log(
		`\n[pipeline-bench] ${results.length}/${seeds.length} OK · wall=${wall}ms · concurrency=${concurrency}`,
	);
	console.log(
		`[pipeline-bench] per-node ms: avg=${Math.round(avg)} p50=${pct(0.5)} p90=${pct(0.9)} max=${mss[mss.length - 1] ?? 0}`,
	);
	if (results.length) {
		const totalCost = results.reduce((a, r) => a + r.cost, 0);
		console.log(
			`[pipeline-bench] total cost: $${totalCost.toFixed(4)} (avg $${(totalCost / results.length).toFixed(5)}/node)`,
		);
	}
	if (fails.length) {
		console.log("\nFails:");
		for (const f of fails) console.log(`  ${f.input} ${f.ms}ms — ${f.err}`);
	}
}

main().catch((e: unknown) => {
	process.stderr.write(`error: ${e instanceof Error ? e.stack : String(e)}\n`);
	process.exit(1);
});
