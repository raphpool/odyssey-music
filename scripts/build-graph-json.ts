/**
 * Pack the slug-keyed cache directory into a single graph.json suitable for the
 * dropcliffs lab visualization (vis-network).
 *
 * Output shape:
 *   { generated_at, total, types: {...}, nodes: [...], edges: [{source, target, kind}] }
 */
import { writeFile } from "node:fs/promises";
import { buildGraphFromCache } from "../src/graph.js";

async function main(): Promise<void> {
	const cacheDir = process.argv[2];
	const outFile = process.argv[3];
	if (!cacheDir || !outFile) {
		process.stderr.write("usage: build-graph-json.ts <cache-dir> <out.json>\n");
		process.exit(2);
	}
	const out = await buildGraphFromCache(cacheDir, {
		includeImageUrls: true,
		quarantineOrphanGenres: true,
		scrubQuarantinedRefs: true,
		includeTaxonomy: true,
	});
	await writeFile(outFile, JSON.stringify(out, null, 2));
	console.log(
		`wrote ${outFile}: ${out.nodes.length} nodes, ${out.edges.length} edges (quarantined ${out.quarantine?.length ?? 0} orphan genres, taxonomy ${out.taxonomy ? `${out.taxonomy.genres.length} genres` : "absent"})`,
	);
}

main().catch((e: unknown) => {
	process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
