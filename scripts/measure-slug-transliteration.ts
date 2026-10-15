/**
 * Read-only measure of the TRA-528 slug transliteration (ø æ œ ł ß đ þ) on the committed cache.
 *
 * Lists (1) the nodes whose slug would change, (2) the edges whose target slug would change, with old
 * and new slug, and flags every COLLISION: a new slug equal to the slug of another node, or two
 * different old slugs mapping to the same new one. The old -> new table (`mapping`) comes from
 * transliteratedSlug(), the same pure function the identity migration (TRA-478) calls, so what this
 * prints is what the migration will apply once ODYSSEY_SCOPED_RELEASE_SLUGS is flipped (TRA-509).
 *
 * Nodes are read as raw JSON, like audit-cache.ts. Nothing is ever written under <cache-dir>.
 *
 * Usage: measure-slug-transliteration.ts <cache-dir> [--json <file>]
 * Exit:  0 report printed (a collision is a finding, not a failure), 2 usage or read error.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EDGE_FIELDS_BY_TYPE, NODE_TYPES } from "../src/node-spec.js";
import { hasTransliteratedLetter, transliteratedSlug } from "../src/slug.js";

export type RawNode = Record<string, unknown>;

export interface SlugChange {
	from: string;
	to: string;
	name: string;
}
export interface EdgeTargetChange extends SlugChange {
	/** Number of edges in the cache pointing at `from`. */
	edges: number;
	/** The target has no node of its own in the cache. */
	dangling: boolean;
}
export interface Collision {
	from: string;
	to: string;
	/** Why `to` is taken: an existing node, or another old slug migrating to the same place. */
	with: string;
}
export interface Unresolved {
	slug: string;
	name: string;
	where: "node" | "edge";
}
export interface TransliterationReport {
	nodeCount: number;
	nodeChanges: SlugChange[];
	edgeChanges: EdgeTargetChange[];
	collisions: Collision[];
	/** Slugs whose name has a transliterated letter but that cannot be re-derived from it. */
	unresolved: Unresolved[];
	/** Old -> new, node slugs and edge targets together. */
	mapping: Record<string, string>;
}

interface Target {
	slug: string;
	name: string;
	/** Candidate scope artists, in order: the first one the slug's scope matches wins. */
	artists: string[];
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

function creditedArtists(node: RawNode): string[] {
	const artists = node.artists;
	if (!Array.isArray(artists)) return [];
	return artists.flatMap((a: unknown) =>
		a && typeof a === "object" ? (str((a as RawNode).name) ?? []) : [],
	);
}

function* edgeRefs(node: RawNode): Generator<Target> {
	const type = str(node.slug)?.split(":")[0];
	const fields = EDGE_FIELDS_BY_TYPE[type as keyof typeof EDGE_FIELDS_BY_TYPE];
	if (!fields) return;
	for (const field of Object.keys(fields)) {
		const value = node[field];
		const refs: unknown[] = Array.isArray(value) ? value : value ? [value] : [];
		for (const ref of refs) {
			if (!ref || typeof ref !== "object") continue;
			const r = ref as RawNode;
			const slug = str(r.slug);
			const artist = str(r.artist);
			if (slug) yield { slug, name: str(r.name) ?? "", artists: artist ? [artist] : [] };
		}
	}
}

export function measureSlugTransliteration(nodes: readonly RawNode[]): TransliterationReport {
	const existing = new Set<string>();
	for (const n of nodes) {
		const slug = str(n.slug);
		if (slug) existing.add(slug);
	}

	const mapping = new Map<string, string>();
	const names = new Map<string, string>();
	const unresolved = new Map<string, Unresolved>();

	// A slug is settled by the first reference that re-derives it; a reference that cannot (an edge with
	// no `artist`, a stale name) must not hide a later one that can, whatever the iteration order.
	const settled = new Set<string>();
	const resolveTarget = (t: Target, where: "node" | "edge"): void => {
		if (settled.has(t.slug)) return;
		for (const artist of t.artists.length > 0 ? t.artists : [undefined]) {
			const result = transliteratedSlug(t.slug, t.name, artist);
			if (!result.ok) continue;
			settled.add(t.slug);
			unresolved.delete(t.slug);
			if (result.slug !== t.slug) {
				mapping.set(t.slug, result.slug);
				names.set(t.slug, t.name);
			}
			return;
		}
		if (hasTransliteratedLetter(t.name) || t.artists.some(hasTransliteratedLetter)) {
			if (!unresolved.has(t.slug)) unresolved.set(t.slug, { slug: t.slug, name: t.name, where });
		}
	};

	// Nodes first: a node's own name is more reliable than the name an edge happens to carry.
	for (const n of nodes) {
		const slug = str(n.slug);
		if (slug) resolveTarget({ slug, name: str(n.name) ?? "", artists: creditedArtists(n) }, "node");
	}
	const edgeCounts = new Map<string, number>();
	for (const n of nodes) {
		for (const t of edgeRefs(n)) {
			edgeCounts.set(t.slug, (edgeCounts.get(t.slug) ?? 0) + 1);
			resolveTarget(t, "edge");
		}
	}

	const nodeChanges: SlugChange[] = [];
	const edgeChanges: EdgeTargetChange[] = [];
	for (const [from, to] of mapping) {
		const change = { from, to, name: names.get(from) ?? "" };
		if (existing.has(from)) nodeChanges.push(change);
		const edges = edgeCounts.get(from) ?? 0;
		if (edges > 0) edgeChanges.push({ ...change, edges, dangling: !existing.has(from) });
	}

	const collisions: Collision[] = [];
	const claimedBy = new Map<string, string>();
	for (const [from, to] of mapping) {
		// `to` is already in use: a node of its own, or a slug that edges point at (dangling).
		if (existing.has(to) || edgeCounts.has(to)) {
			const kind = existing.has(to) ? "existing node" : "dangling edge target";
			const note = [
				mapping.has(to) ? `${to} is itself renamed to ${mapping.get(to)}` : null,
				existing.has(from) ? "two nodes would merge" : "`from` has no node: its edges re-attach to it",
			]
				.filter(Boolean)
				.join("; ");
			collisions.push({ from, to, with: `${kind} ${to} (${note})` });
		}
		const other = claimedBy.get(to);
		if (other !== undefined) collisions.push({ from, to, with: `also the target of ${other}` });
		else claimedBy.set(to, from);
	}

	const byFrom = (a: { from: string }, b: { from: string }): number => a.from.localeCompare(b.from);
	return {
		nodeCount: existing.size,
		nodeChanges: nodeChanges.sort(byFrom),
		edgeChanges: edgeChanges.sort(byFrom),
		collisions: collisions.sort(byFrom),
		unresolved: [...unresolved.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
		mapping: Object.fromEntries([...mapping].sort(([a], [b]) => a.localeCompare(b))),
	};
}

export async function readNodes(cacheDir: string): Promise<RawNode[]> {
	const nodes: RawNode[] = [];
	for (const type of NODE_TYPES) {
		const dir = join(cacheDir, "nodes", type);
		let files: string[];
		try {
			files = await readdir(dir);
		} catch {
			continue;
		}
		for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
			nodes.push(JSON.parse(await readFile(join(dir, file), "utf8")) as RawNode);
		}
	}
	return nodes;
}

export function formatReport(r: TransliterationReport): string {
	const out: string[] = [];
	out.push(`nodes read: ${r.nodeCount}`);
	out.push(`\nnodes whose slug would change: ${r.nodeChanges.length}`);
	for (const c of r.nodeChanges) out.push(`  ${c.from} -> ${c.to}   (${c.name})`);
	out.push(`\nedge targets whose slug would change: ${r.edgeChanges.length}`);
	for (const c of r.edgeChanges) {
		out.push(`  ${c.from} -> ${c.to}   (${c.name}; ${c.edges} edge(s)${c.dangling ? ", dangling" : ""})`);
	}
	out.push(`\ncollisions: ${r.collisions.length}`);
	for (const c of r.collisions) out.push(`  ${c.from} -> ${c.to}   ${c.with}`);
	out.push(`\nnot re-derivable from the name (kept as is, review by hand): ${r.unresolved.length}`);
	for (const u of r.unresolved) out.push(`  ${u.slug}   (${u.name}; ${u.where})`);
	return out.join("\n");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const jsonIdx = args.indexOf("--json");
	const jsonFile = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;
	const cacheDir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--json");
	if (!cacheDir || (jsonIdx >= 0 && !jsonFile)) {
		process.stderr.write("usage: measure-slug-transliteration.ts <cache-dir> [--json <file>]\n");
		process.exit(2);
	}
	const report = measureSlugTransliteration(await readNodes(resolve(cacheDir)));
	console.log(formatReport(report));
	if (jsonFile) await writeFile(jsonFile, `${JSON.stringify(report, null, "\t")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	});
}
