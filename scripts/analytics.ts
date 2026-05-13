/**
 * Aggregate per-node _metrics across the cache: total cost, total tokens, tool calls,
 * percentiles, and a top-N list of the most expensive nodes.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nodePayloadSchema } from "../src/schemas.js";
import type { NodePayload } from "../src/types.js";

interface Metrics {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cost_usd: number;
	llm_calls: number;
	search_calls: number;
	fetch_calls: number;
	turns: number;
	emit_attempts: number;
	agent_ms: number;
	model_id: string;
	search_provider: string;
}

async function main(): Promise<void> {
	const dir = process.argv[2];
	if (!dir) {
		process.stderr.write("usage: analytics.ts <cache-dir>\n");
		process.exit(2);
	}
	const nodesDir = join(dir, "nodes");
	const rows: { slug: string; m: Metrics }[] = [];
	let nodesWithMetrics = 0;
	let totalNodes = 0;
	for (const t of await readdir(nodesDir)) {
		for (const f of await readdir(join(nodesDir, t))) {
			if (!f.endsWith(".json")) continue;
			totalNodes++;
			const raw = await readFile(join(nodesDir, t, f), "utf8");
			const parsed = nodePayloadSchema.parse(JSON.parse(raw)) as NodePayload;
			const m = (parsed as unknown as Record<string, unknown>)._metrics;
			if (m && typeof m === "object") {
				nodesWithMetrics++;
				rows.push({ slug: parsed.slug, m: m as Metrics });
			}
		}
	}
	if (!rows.length) {
		console.log(
			`${totalNodes} nodes loaded, 0 carry _metrics. Re-crawl after this commit to capture analytics.`,
		);
		return;
	}
	const sum = rows.reduce(
		(a, r) => ({
			input_tokens: a.input_tokens + r.m.input_tokens,
			output_tokens: a.output_tokens + r.m.output_tokens,
			cache_read_tokens: a.cache_read_tokens + r.m.cache_read_tokens,
			cache_write_tokens: a.cache_write_tokens + r.m.cache_write_tokens,
			cost_usd: a.cost_usd + r.m.cost_usd,
			llm_calls: a.llm_calls + r.m.llm_calls,
			search_calls: a.search_calls + r.m.search_calls,
			fetch_calls: a.fetch_calls + r.m.fetch_calls,
			turns: a.turns + r.m.turns,
			agent_ms: a.agent_ms + r.m.agent_ms,
			emit_attempts: a.emit_attempts + r.m.emit_attempts,
		}),
		{
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			cost_usd: 0,
			llm_calls: 0,
			search_calls: 0,
			fetch_calls: 0,
			turns: 0,
			agent_ms: 0,
			emit_attempts: 0,
		},
	);
	const n = rows.length;
	const pct = (xs: number[], p: number): number => {
		const s = [...xs].sort((a, b) => a - b);
		return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
	};
	const costs = rows.map((r) => r.m.cost_usd);
	const mss = rows.map((r) => r.m.agent_ms);
	const tokens = rows.map((r) => r.m.input_tokens + r.m.output_tokens);

	console.log(`=== Per-node analytics over ${n} nodes (of ${totalNodes} in cache) ===`);
	console.log(`Total cost:     $${sum.cost_usd.toFixed(4)} (avg $${(sum.cost_usd / n).toFixed(5)}/node)`);
	console.log(
		`Total tokens:   in=${sum.input_tokens.toLocaleString()} out=${sum.output_tokens.toLocaleString()} cacheRead=${sum.cache_read_tokens.toLocaleString()} cacheWrite=${sum.cache_write_tokens.toLocaleString()}`,
	);
	console.log(`Total LLM calls: ${sum.llm_calls} (avg ${(sum.llm_calls / n).toFixed(1)}/node)`);
	console.log(`Total tool calls: web_search=${sum.search_calls} fetch_page=${sum.fetch_calls}`);
	console.log(
		`Total agent time: ${(sum.agent_ms / 1000).toFixed(0)}s (avg ${(sum.agent_ms / n / 1000).toFixed(1)}s/node)`,
	);
	console.log("");
	console.log("Cost per node:");
	console.log(
		`  p50=$${pct(costs, 0.5).toFixed(5)}  p90=$${pct(costs, 0.9).toFixed(5)}  p99=$${pct(costs, 0.99).toFixed(5)}  max=$${Math.max(...costs).toFixed(5)}`,
	);
	console.log("Tokens per node (input+output):");
	console.log(
		`  p50=${pct(tokens, 0.5)}  p90=${pct(tokens, 0.9)}  p99=${pct(tokens, 0.99)}  max=${Math.max(...tokens)}`,
	);
	console.log("Wall time per node (ms):");
	console.log(`  p50=${pct(mss, 0.5)}  p90=${pct(mss, 0.9)}  p99=${pct(mss, 0.99)}  max=${Math.max(...mss)}`);
	console.log("");
	console.log("Projections:");
	const avgCost = sum.cost_usd / n;
	const avgSearch = sum.search_calls / n;
	const avgFetch = sum.fetch_calls / n;
	for (const target of [1000, 5000, 10000]) {
		console.log(
			`  ${target} nodes ≈ $${(avgCost * target).toFixed(2)} (${Math.round(avgSearch * target)} tavily + ${Math.round(avgFetch * target)} firecrawl calls)`,
		);
	}
	const top = [...rows].sort((a, b) => b.m.cost_usd - a.m.cost_usd).slice(0, 10);
	console.log("\nTop 10 most expensive nodes:");
	for (const r of top) {
		console.log(
			`  $${r.m.cost_usd.toFixed(5)}  ${r.slug}  (in=${r.m.input_tokens} out=${r.m.output_tokens} calls=${r.m.llm_calls} attempts=${r.m.emit_attempts})`,
		);
	}
}

main().catch((e: unknown) => {
	process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
