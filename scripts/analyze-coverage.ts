/**
 * Analyze edge coverage in a slug-keyed cache:
 *  - how many edges point to slugs that ARE materialized vs DANGLING
 *  - top dangling target slugs (most-referenced unmaterialized entities)
 *  - per-type coverage rates
 *  - estimated nodes needed to reach >95% / >99% coverage by greedy expansion
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nodePayloadSchema } from "../src/schemas.js";
import {
	type EdgeRef,
	LIST_EDGES_BY_TYPE,
	type NodePayload,
	type NodeType,
	SINGULAR_EDGES_BY_TYPE,
} from "../src/types.js";

async function main(): Promise<void> {
	const dir = process.argv[2];
	if (!dir) {
		process.stderr.write("usage: analyze-coverage.ts <cache-dir>\n");
		process.exit(2);
	}
	const nodesDir = join(dir, "nodes");
	const nodes = new Map<string, NodePayload>();
	for (const t of await readdir(nodesDir)) {
		for (const f of await readdir(join(nodesDir, t))) {
			if (!f.endsWith(".json")) continue;
			const raw = await readFile(join(nodesDir, t, f), "utf8");
			const parsed = nodePayloadSchema.parse(JSON.parse(raw)) as NodePayload;
			nodes.set(parsed.slug, parsed);
		}
	}

	const totalNodes = nodes.size;
	let totalEdges = 0;
	let danglingEdges = 0;
	const danglingCount = new Map<string, number>();
	const perTypeStats: Record<NodeType, { total: number; dangling: number }> = {
		genre: { total: 0, dangling: 0 },
		label: { total: 0, dangling: 0 },
		artist: { total: 0, dangling: 0 },
		project: { total: 0, dangling: 0 },
		track: { total: 0, dangling: 0 },
	};

	for (const node of nodes.values()) {
		const obj = node as unknown as Record<string, unknown>;
		const collect = (e: EdgeRef): void => {
			totalEdges++;
			perTypeStats[e.type].total++;
			if (!nodes.has(e.slug)) {
				danglingEdges++;
				perTypeStats[e.type].dangling++;
				danglingCount.set(e.slug, (danglingCount.get(e.slug) ?? 0) + 1);
			}
		};
		for (const field of LIST_EDGES_BY_TYPE[node.type]) {
			const v = obj[field];
			if (Array.isArray(v)) for (const e of v as EdgeRef[]) collect(e);
		}
		for (const field of SINGULAR_EDGES_BY_TYPE[node.type]) {
			const v = obj[field];
			if (v && typeof v === "object") collect(v as EdgeRef);
		}
	}

	const coverage = ((totalEdges - danglingEdges) / Math.max(1, totalEdges)) * 100;

	// Greedy projection: if we materialized the top-K most-referenced dangling targets, what % coverage?
	const sortedDangling = [...danglingCount.entries()].sort((a, b) => b[1] - a[1]);
	const projections: { k: number; coverage: number; cumulativeAdded: number }[] = [];
	const targets = [100, 250, 500, 1000, 2000, 5000];
	for (const k of targets) {
		let curedEdges = 0;
		for (let i = 0; i < Math.min(k, sortedDangling.length); i++) {
			curedEdges += sortedDangling[i]?.[1] ?? 0;
		}
		const totalEdgesProj = totalEdges;
		const newDangling = Math.max(0, danglingEdges - curedEdges);
		const newCoverage = ((totalEdgesProj - newDangling) / Math.max(1, totalEdgesProj)) * 100;
		projections.push({ k, coverage: newCoverage, cumulativeAdded: curedEdges });
	}

	console.log("=== Edge coverage ===");
	console.log(`Materialized nodes:  ${totalNodes}`);
	console.log(`Total edges emitted: ${totalEdges}`);
	console.log(`In-cache edges:      ${totalEdges - danglingEdges}`);
	console.log(
		`Dangling edges:      ${danglingEdges} (${((danglingEdges / Math.max(1, totalEdges)) * 100).toFixed(1)}%)`,
	);
	console.log(`Click-through rate:  ${coverage.toFixed(1)}%`);
	console.log(`Unique dangling targets: ${danglingCount.size}`);

	console.log("\n=== Per-target-type ===");
	for (const t of Object.keys(perTypeStats) as NodeType[]) {
		const s = perTypeStats[t];
		const inCache = s.total - s.dangling;
		const rate = s.total ? ((inCache / s.total) * 100).toFixed(1) : "n/a";
		console.log(`  ${t.padEnd(8)} ${inCache}/${s.total} clickable (${rate}%)`);
	}

	console.log("\n=== Projection: if we materialize the top-K most-referenced dangling targets ===");
	for (const p of projections) {
		console.log(
			`  +${String(p.k).padStart(5)} nodes → ${p.coverage.toFixed(1)}% coverage (would cure ${p.cumulativeAdded} edges)`,
		);
	}

	console.log("\n=== Top 20 most-referenced dangling targets ===");
	for (const [slug, n] of sortedDangling.slice(0, 20)) {
		console.log(`  ${String(n).padStart(4)}× ${slug}`);
	}
}

main().catch((e: unknown) => {
	process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
