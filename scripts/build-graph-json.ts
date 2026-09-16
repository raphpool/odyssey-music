/**
 * Pack the slug-keyed cache directory into a single graph.json suitable for the
 * dropcliffs lab visualization (vis-network).
 *
 * Output shape:
 *   { generated_at, total, types: {...}, nodes: [...], edges: [{source, target, kind}] }
 */
import { writeFile } from "node:fs/promises";
import type { BuildGraphOptions } from "../src/graph.js";
import { buildGraphFromCache, DEFAULT_TAXONOMY_PATH } from "../src/graph.js";

// Exported so test/graph.test.ts can reuse the exact options this script runs with -- rather than
// a hand-copied duplicate that could silently drift from what actually ships (TRA-134 review).
// "strict": CI must fail loudly if data/genre-taxonomy.json has drifted from the committed cache/
// (an invalid file, or a declared source slug that no longer exists).
export const STATIC_GRAPH_OPTIONS: BuildGraphOptions = {
	includeImageUrls: true,
	quarantineOrphanGenres: true,
	scrubQuarantinedRefs: true,
	taxonomy: "strict",
	taxonomyPath: DEFAULT_TAXONOMY_PATH,
};

async function main(): Promise<void> {
	const cacheDir = process.argv[2];
	const outFile = process.argv[3];
	if (!cacheDir || !outFile) {
		process.stderr.write("usage: build-graph-json.ts <cache-dir> <out.json>\n");
		process.exit(2);
	}
	const out = await buildGraphFromCache(cacheDir, STATIC_GRAPH_OPTIONS);
	await writeFile(outFile, JSON.stringify(out, null, 2));
	console.log(
		`wrote ${outFile}: ${out.nodes.length} nodes, ${out.edges.length} edges (quarantined ${out.quarantine?.length ?? 0} orphan genres, taxonomy ${out.taxonomy ? `${out.taxonomy.genres.length} genres` : "absent"})`,
	);
}

// Only run as a CLI entry point -- importing this module (test/graph.test.ts, to reuse
// STATIC_GRAPH_OPTIONS) must not also trigger main()'s argv parsing / process.exit (TRA-134 review).
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
