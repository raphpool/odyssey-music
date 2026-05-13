/**
 * Targeted top-up: read the cache, find the most-referenced dangling targets,
 * then run the agent on each of them, writing into the SAME cache dir. The
 * crawler's BFS expansion is skipped — we materialize the top-N dangling
 * targets directly because they are exactly what's missing.
 *
 * Re-runnable: anything already in cache is skipped by cache.has() before the
 * agent runs. Crashes / kills are safe; rerun resumes.
 *
 * Usage: top-up-dangling.ts <cache-dir> <max-new-nodes> [concurrency]
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentInput, runAgent } from "../src/agent.js";
import { NodeCache } from "../src/cache.js";
import { loadEnv } from "../src/env.js";
import { nodePayloadSchema } from "../src/schemas.js";
import { parseSlug } from "../src/slug.js";
import type { EdgeRef, NodePayload, NodeType, Slug } from "../src/types.js";
import { LIST_EDGES_BY_TYPE, SINGULAR_EDGES_BY_TYPE } from "../src/types.js";

async function main(): Promise<void> {
	const dir = process.argv[2];
	const maxNew = Number.parseInt(process.argv[3] ?? "200", 10);
	const concurrency = Number.parseInt(process.argv[4] ?? "16", 10);
	if (!dir) {
		process.stderr.write("usage: top-up-dangling.ts <cache-dir> <max-new-nodes> [concurrency]\n");
		process.exit(2);
	}
	const env = loadEnv();
	const cache = new NodeCache(dir);

	// 1. Index materialized slugs and count dangling references.
	const nodesDir = join(dir, "nodes");
	const slugs = new Set<Slug>();
	const dangling = new Map<Slug, { type: NodeType; name: string; count: number }>();
	for (const t of await readdir(nodesDir)) {
		for (const f of await readdir(join(nodesDir, t))) {
			if (!f.endsWith(".json")) continue;
			const parsed = nodePayloadSchema.parse(
				JSON.parse(await readFile(join(nodesDir, t, f), "utf8")),
			) as NodePayload;
			slugs.add(parsed.slug);
		}
	}
	for (const t of await readdir(nodesDir)) {
		for (const f of await readdir(join(nodesDir, t))) {
			if (!f.endsWith(".json")) continue;
			const parsed = nodePayloadSchema.parse(
				JSON.parse(await readFile(join(nodesDir, t, f), "utf8")),
			) as NodePayload;
			const obj = parsed as unknown as Record<string, unknown>;
			const inspect = (e: EdgeRef): void => {
				if (slugs.has(e.slug)) return;
				const cur = dangling.get(e.slug);
				if (cur) cur.count++;
				else dangling.set(e.slug, { type: e.type, name: e.name, count: 1 });
			};
			for (const field of LIST_EDGES_BY_TYPE[parsed.type]) {
				const v = obj[field];
				if (Array.isArray(v)) for (const e of v as EdgeRef[]) inspect(e);
			}
			for (const field of SINGULAR_EDGES_BY_TYPE[parsed.type]) {
				const v = obj[field];
				if (v && typeof v === "object") inspect(v as EdgeRef);
			}
		}
	}

	const targets = [...dangling.entries()]
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, maxNew)
		.map(([slug, info]) => ({ slug, ...info }));
	console.log(`[top-up] indexed ${slugs.size} cached nodes, ${dangling.size} unique dangling targets`);
	console.log(`[top-up] selecting top ${targets.length} most-referenced dangling targets to materialize`);
	console.log(`[top-up] concurrency=${concurrency}`);

	let okCount = 0;
	let failCount = 0;
	let abandonCount = 0;
	const startedAt = Date.now();

	const queue = targets.slice();
	const workers = Array.from({ length: concurrency }, async (_unused, i) => {
		while (true) {
			const t = queue.shift();
			if (!t) return;
			try {
				if (await cache.has(t.slug)) {
					okCount++;
					continue;
				}
				const parsed = parseSlug(t.slug);
				const input: AgentInput = { type: parsed.type, name: t.name };
				const t0 = Date.now();
				const result = await runAgent(input, {
					tavilyApiKey: env.TAVILY_API_KEY,
					firecrawlApiKey: env.FIRECRAWL_API_KEY,
				});
				if (await cache.has(result.slug)) {
					okCount++;
					console.log(`[w${i + 1}] dedup ${result.slug} (collision)`);
					continue;
				}
				await cache.write(result.node);
				okCount++;
				console.log(
					`[w${i + 1}] OK ${result.slug} cost=$${result.metrics.cost_usd.toFixed(5)} tok=${result.metrics.input_tokens + result.metrics.output_tokens} ${Date.now() - t0}ms (${okCount}/${targets.length})`,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (msg.includes("abandoned:")) {
					abandonCount++;
					console.log(`[w${i + 1}] ABANDON ${t.slug}: ${msg}`);
				} else {
					failCount++;
					console.log(`[w${i + 1}] FAIL ${t.slug}: ${msg}`);
				}
			}
		}
	});
	await Promise.all(workers);
	const wall = Math.round((Date.now() - startedAt) / 1000);
	console.log(`\n[top-up] DONE: ok=${okCount} fail=${failCount} abandon=${abandonCount} in ${wall}s`);
}

main().catch((e: unknown) => {
	process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
