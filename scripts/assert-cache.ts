import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { reverseFor, reversibleFields } from "../src/reverse-edges.js";
import { nodePayloadSchema } from "../src/schemas.js";
import type { EdgeRef, NodePayload, NodeType, Slug } from "../src/types.js";

async function main(): Promise<void> {
	const [out, maxNodesStr] = [process.argv[2], process.argv[3]];
	if (!out || !maxNodesStr) {
		process.stderr.write("usage: assert-cache.ts <out-dir> <max-nodes>\n");
		process.exit(2);
	}
	const maxNodes = Number.parseInt(maxNodesStr, 10);
	const nodesDir = join(out, "nodes");
	const types = await readdir(nodesDir);

	const nodes = new Map<Slug, NodePayload>();
	for (const t of types) {
		const files = await readdir(join(nodesDir, t));
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const raw = await readFile(join(nodesDir, t, f), "utf8");
			const obj = JSON.parse(raw) as unknown;
			const parsed = nodePayloadSchema.parse(obj) as NodePayload;
			if (nodes.has(parsed.slug)) {
				fail(`duplicate slug on disk: ${parsed.slug}`);
			}
			nodes.set(parsed.slug, parsed);
		}
	}

	const count = nodes.size;
	console.log(`[assert] ${count} nodes loaded`);
	if (count < Math.min(maxNodes, 25)) {
		fail(`only ${count} nodes materialized, expected at least ${Math.min(maxNodes, 25)}`);
	}
	if (count > maxNodes) {
		fail(`materialized ${count} nodes, exceeds maxNodes ${maxNodes}`);
	}

	let reverseChecked = 0;
	let editorialChars = 0;
	let articlesWithCitations = 0;
	for (const node of nodes.values()) {
		if ((node.editorial_article ?? "").length < 200) {
			fail(`node ${node.slug} has suspiciously short editorial_article`);
		}
		editorialChars += node.editorial_article.length;
		if (node.citations.length > 0) articlesWithCitations++;

		// Verify reverse-edge invariants for any reversible field whose target is in the cache.
		const fields = reversibleFields(node.type);
		for (const field of fields) {
			const spec = reverseFor(node.type as NodeType, field);
			if (!spec) continue;
			const value = (node as unknown as Record<string, unknown>)[field];
			const refs: EdgeRef[] = Array.isArray(value)
				? (value as EdgeRef[])
				: value && typeof value === "object"
					? [value as EdgeRef]
					: [];
			for (const ref of refs) {
				const target = nodes.get(ref.slug);
				if (!target) continue;
				const tv = (target as unknown as Record<string, unknown>)[spec.field];
				const targetRefs: EdgeRef[] = Array.isArray(tv)
					? (tv as EdgeRef[])
					: tv && typeof tv === "object"
						? [tv as EdgeRef]
						: [];
				const found = targetRefs.some((e) => e.slug === node.slug);
				if (!found) {
					fail(
						`reverse-edge missing: ${node.slug}.${field} contains ${ref.slug} ` +
							`but ${ref.slug}.${spec.field} does not contain ${node.slug}`,
					);
				}
				reverseChecked++;
			}
		}
	}

	const citationCoverage = articlesWithCitations / count;
	if (citationCoverage < 0.6) {
		fail(`only ${Math.round(citationCoverage * 100)}% of nodes have >=1 citation; need >=60%`);
	}

	console.log(
		`[assert] OK: ${count} nodes, ${reverseChecked} reverse-edge invariants verified, ` +
			`avg editorial=${Math.round(editorialChars / count)} chars, ` +
			`citation coverage=${Math.round(citationCoverage * 100)}%`,
	);
}

function fail(msg: string): never {
	process.stderr.write(`[assert] FAIL ${msg}\n`);
	process.exit(1);
}

main().catch((e: unknown) => {
	process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
