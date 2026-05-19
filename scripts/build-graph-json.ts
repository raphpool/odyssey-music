/**
 * Pack the slug-keyed cache directory into a single graph.json suitable for the
 * dropcliffs lab visualization (vis-network).
 *
 * Output shape:
 *   { generated_at, total, types: {...}, nodes: [...], edges: [{source, target, kind}] }
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backfillGenreReverses } from "../src/reverse-edges.js";
import { nodePayloadSchema } from "../src/schemas.js";
import {
	type EdgeRef,
	LIST_EDGES_BY_TYPE,
	type NodePayload,
	OPTIONAL_TEXT_FIELDS,
	SINGULAR_EDGES_BY_TYPE,
} from "../src/types.js";

interface VizNode {
	id: string;
	type: NodePayload["type"];
	name: string;
	teaser: string;
	article: string;
	citations: { url: string; title?: string }[];
	edges: Record<string, EdgeRef[] | EdgeRef>;
	facts: Record<string, string>;
}

interface VizEdge {
	source: string;
	target: string;
	kind: string;
}

async function main(): Promise<void> {
	const cacheDir = process.argv[2];
	const outFile = process.argv[3];
	if (!cacheDir || !outFile) {
		process.stderr.write("usage: build-graph-json.ts <cache-dir> <out.json>\n");
		process.exit(2);
	}
	const nodesDir = join(cacheDir, "nodes");
	const nodes: VizNode[] = [];
	const seen = new Set<string>();
	const teaserField: Record<NodePayload["type"], string> = {
		genre: "editorial_definition",
		label: "editorial_description",
		artist: "editorial_bio",
		project: "editorial_pitch",
		track: "editorial_teaser",
	};
	for (const t of await readdir(nodesDir)) {
		for (const f of await readdir(join(nodesDir, t))) {
			if (!f.endsWith(".json")) continue;
			const raw = await readFile(join(nodesDir, t, f), "utf8");
			const obj = JSON.parse(raw) as unknown;
			const parsed = nodePayloadSchema.parse(obj) as NodePayload;
			if (seen.has(parsed.slug)) continue;
			seen.add(parsed.slug);
			const teaserVal = (parsed as unknown as Record<string, unknown>)[teaserField[parsed.type]];
			const facts: Record<string, string> = {};
			for (const field of OPTIONAL_TEXT_FIELDS[parsed.type]) {
				const v = (parsed as unknown as Record<string, unknown>)[field];
				if (typeof v === "string" && v.trim()) facts[field] = v;
			}
			const node: VizNode = {
				id: parsed.slug,
				type: parsed.type,
				name: parsed.name,
				teaser: typeof teaserVal === "string" ? teaserVal : "",
				article: parsed.editorial_article,
				citations: parsed.citations,
				edges: {},
				facts,
			};
			for (const field of LIST_EDGES_BY_TYPE[parsed.type]) {
				const v = (parsed as unknown as Record<string, unknown>)[field];
				if (Array.isArray(v) && v.length) node.edges[field] = v as EdgeRef[];
			}
			for (const field of SINGULAR_EDGES_BY_TYPE[parsed.type]) {
				const v = (parsed as unknown as Record<string, unknown>)[field];
				if (v && typeof v === "object") node.edges[field] = v as EdgeRef;
			}
			nodes.push(node);
		}
	}

	backfillGenreReverses(nodes);

	const edges: VizEdge[] = [];
	const dedup = new Set<string>();
	for (const n of nodes) {
		for (const [kind, value] of Object.entries(n.edges)) {
			const refs: EdgeRef[] = Array.isArray(value) ? value : [value];
			for (const ref of refs) {
				if (!seen.has(ref.slug)) continue; // dangling: target not in cache, skip
				const key = `${n.id}|${ref.slug}|${kind}`;
				if (dedup.has(key)) continue;
				dedup.add(key);
				edges.push({ source: n.id, target: ref.slug, kind });
			}
		}
	}

	// Quarantine: drop genre nodes that have zero genre↔genre connections
	// (parent_genres, subgenres, related_genres). These are scraper failures —
	// they appear as floating islands in the graph. Front-end will JIT-reload
	// them on demand via /api/odyssey/materialize.
	const GENRE_LINK_KINDS = new Set(["parent_genres", "subgenres", "related_genres"]);
	const genreLinkCount = new Map<string, number>();
	for (const e of edges) {
		if (e.source.startsWith("genre:") && e.target.startsWith("genre:") && GENRE_LINK_KINDS.has(e.kind)) {
			genreLinkCount.set(e.source, (genreLinkCount.get(e.source) ?? 0) + 1);
			genreLinkCount.set(e.target, (genreLinkCount.get(e.target) ?? 0) + 1);
		}
	}
	const quarantine: { id: string; name: string; reason: string }[] = [];
	const quarantineIds = new Set<string>();
	for (const n of nodes) {
		if (n.type !== "genre") continue;
		if ((genreLinkCount.get(n.id) ?? 0) === 0) {
			quarantine.push({ id: n.id, name: n.name, reason: "no genre-genre edges" });
			quarantineIds.add(n.id);
		}
	}
	const keptNodes = nodes.filter((n) => !quarantineIds.has(n.id));
	const keptEdges = edges.filter((e) => !quarantineIds.has(e.source) && !quarantineIds.has(e.target));

	const types: Record<string, number> = {};
	for (const n of keptNodes) types[n.type] = (types[n.type] ?? 0) + 1;

	const out = {
		generated_at: new Date().toISOString(),
		total: keptNodes.length,
		types,
		nodes: keptNodes,
		edges: keptEdges,
		quarantine,
	};
	await writeFile(outFile, JSON.stringify(out, null, 2));
	console.log(
		`wrote ${outFile}: ${keptNodes.length} nodes, ${keptEdges.length} edges (quarantined ${quarantine.length} orphan genres)`,
	);
}

main().catch((e: unknown) => {
	process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
