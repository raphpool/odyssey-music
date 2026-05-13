/**
 * Latency benchmark: run the agent on N fresh seeds in parallel and report
 * p50/p90/p99 wall-clock + tool-call breakdown.
 */
import { runAgent } from "../src/agent.js";
import { loadEnv } from "../src/env.js";

const SEEDS = [
	{ type: "track" as const, name: "Windowlicker" },
	{ type: "artist" as const, name: "Pole" },
	{ type: "label" as const, name: "Mille Plateaux" },
	{ type: "genre" as const, name: "Ambient techno" },
	{ type: "project" as const, name: "Selected Ambient Works 85-92" },
	{ type: "track" as const, name: "Strings of Life" },
	{ type: "artist" as const, name: "Mouse on Mars" },
	{ type: "label" as const, name: "Kompakt" },
];

async function main(): Promise<void> {
	const env = loadEnv();
	const concurrency = Number.parseInt(process.argv[2] ?? "4", 10);
	const seeds = SEEDS.slice(0, Number.parseInt(process.argv[3] ?? "8", 10));
	console.log(`[bench] ${seeds.length} seeds, concurrency=${concurrency}`);

	const results: {
		slug: string;
		ms: number;
		turns: number;
		searches: number;
		fetches: number;
		cost: number;
		attempts: number;
	}[] = [];
	const queue = [...seeds];
	const t0 = Date.now();
	const workers = Array.from({ length: concurrency }, async () => {
		while (true) {
			const seed = queue.shift();
			if (!seed) return;
			const start = Date.now();
			try {
				const r = await runAgent(seed, {
					tavilyApiKey: env.TAVILY_API_KEY,
					firecrawlApiKey: env.FIRECRAWL_API_KEY,
				});
				const ms = Date.now() - start;
				results.push({
					slug: r.slug,
					ms,
					turns: r.metrics.turns,
					searches: r.metrics.search_calls,
					fetches: r.metrics.fetch_calls,
					cost: r.metrics.cost_usd,
					attempts: r.metrics.emit_attempts,
				});
				console.log(
					`  ${r.slug} ${ms}ms turns=${r.metrics.turns} search=${r.metrics.search_calls} fetch=${r.metrics.fetch_calls} attempts=${r.metrics.emit_attempts} cost=$${r.metrics.cost_usd.toFixed(5)}`,
				);
			} catch (e) {
				const ms = Date.now() - start;
				console.log(
					`  FAIL ${seed.type}:${seed.name} ${ms}ms — ${e instanceof Error ? e.message.slice(0, 80) : ""}`,
				);
			}
		}
	});
	await Promise.all(workers);
	const wall = Date.now() - t0;
	const mss = results.map((r) => r.ms).sort((a, b) => a - b);
	const pct = (p: number): number => mss[Math.min(mss.length - 1, Math.floor(mss.length * p))] ?? 0;
	const avg = mss.reduce((a, b) => a + b, 0) / Math.max(1, mss.length);
	console.log(`\n[bench] ${results.length}/${seeds.length} OK · wall=${wall}ms · concurrency=${concurrency}`);
	console.log(
		`[bench] per-node ms: avg=${Math.round(avg)} p50=${pct(0.5)} p90=${pct(0.9)} p99=${pct(0.99)} max=${mss[mss.length - 1] ?? 0}`,
	);
	const totalCost = results.reduce((a, r) => a + r.cost, 0);
	const totalSearch = results.reduce((a, r) => a + r.searches, 0);
	const totalFetch = results.reduce((a, r) => a + r.fetches, 0);
	const totalAttempts = results.reduce((a, r) => a + r.attempts, 0);
	console.log(
		`[bench] totals: cost=$${totalCost.toFixed(4)} searches=${totalSearch} fetches=${totalFetch} emit_attempts=${totalAttempts}`,
	);
}

main().catch((e: unknown) => {
	process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
