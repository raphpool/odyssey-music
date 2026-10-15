/**
 * Read-only measure of the TRA-528 slug transliteration (ø æ œ ł ß đ þ) on the committed cache.
 *
 * Lists (1) the nodes whose slug would change, (2) the edges whose target slug would change, with old
 * and new slug, and flags every COLLISION: a new slug equal to the slug of another node, or two
 * different old slugs mapping to the same new one. An old slug that two references name differently
 * ("MØ" and "M" both on artist:m) is a CONFLICT: reported, never mapped. The old -> new table (`mapping`) comes from
 * transliteratedSlug(), the same pure function the identity migration (TRA-478) calls, so what this
 * prints is what the migration will apply once ODYSSEY_SCOPED_RELEASE_SLUGS is flipped (TRA-509).
 *
 * cache/pending-reverses.json is read too: its keys are target slugs the migration must rename as well.
 *
 * Nodes are read as raw JSON, like audit-cache.ts. Nothing is ever written under <cache-dir>.
 *
 * Usage: measure-slug-transliteration.ts <cache-dir> [--json <file>]
 * Exit:  0 report printed (a collision is a finding, not a failure), 2 usage, or an unreadable cache (missing
 *        nodes/ directory, no node, invalid JSON: the message names the file).
 */
import { access, readdir, readFile, writeFile } from "node:fs/promises";
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
export interface Conflict {
	slug: string;
	/** Each distinct new slug the references to `slug` ask for, with the first name that asks for it. */
	candidates: Array<{ to: string; name: string }>;
}
export interface PendingKey {
	from: string;
	to: string;
	/** Number of pending reverse edges stored under `from`. */
	entries: number;
}
export interface TransliterationReport {
	nodeCount: number;
	nodeChanges: SlugChange[];
	edgeChanges: EdgeTargetChange[];
	collisions: Collision[];
	/** Slugs whose name has a transliterated letter but that cannot be re-derived from it. */
	unresolved: Unresolved[];
	/** Slugs the references disagree on: not in `mapping`, to settle by hand. */
	conflicts: Conflict[];
	/** Keys of cache/pending-reverses.json that the migration must rename. */
	pendingReverses: PendingKey[];
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

export function measureSlugTransliteration(
	nodes: readonly RawNode[],
	pendingReverses: Record<string, unknown> = {},
): TransliterationReport {
	const existing = new Set<string>();
	for (const n of nodes) {
		const slug = str(n.slug);
		if (slug) existing.add(slug);
	}

	// Every reference to a slug votes for the new slug it implies (the first artist credit that matches the
	// scope wins within a reference). References that cannot re-derive the slug (an edge with no `artist`,
	// a stale name) do not vote, and cannot hide a later one that can, whatever the iteration order.
	const votes = new Map<string, Map<string, string>>();
	const failed = new Map<string, Unresolved>();
	const resolveTarget = (t: Target, where: "node" | "edge"): void => {
		for (const artist of t.artists.length > 0 ? t.artists : [undefined]) {
			const result = transliteratedSlug(t.slug, t.name, artist);
			if (!result.ok) continue;
			const forSlug = votes.get(t.slug) ?? new Map<string, string>();
			if (!forSlug.has(result.slug)) forSlug.set(result.slug, t.name);
			votes.set(t.slug, forSlug);
			return;
		}
		if (hasTransliteratedLetter(t.name) || t.artists.some(hasTransliteratedLetter)) {
			if (!failed.has(t.slug)) failed.set(t.slug, { slug: t.slug, name: t.name, where });
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
	// The edge a pending reverse will add carries a name too; its key is a node not yet written.
	for (const entries of Object.values(pendingReverses)) {
		for (const entry of Array.isArray(entries) ? entries : []) {
			const edge = entry && typeof entry === "object" ? (entry as RawNode).edge : undefined;
			if (!edge || typeof edge !== "object") continue;
			const r = edge as RawNode;
			const slug = str(r.slug);
			const artist = str(r.artist);
			if (slug) resolveTarget({ slug, name: str(r.name) ?? "", artists: artist ? [artist] : [] }, "edge");
		}
	}

	const mapping = new Map<string, string>();
	const names = new Map<string, string>();
	const conflicts: Conflict[] = [];
	for (const [slug, forSlug] of votes) {
		failed.delete(slug);
		const candidates = [...forSlug].map(([to, name]) => ({ to, name }));
		const only = candidates[0];
		if (candidates.length > 1) conflicts.push({ slug, candidates });
		else if (only && only.to !== slug) {
			mapping.set(slug, only.to);
			names.set(slug, only.name);
		}
	}
	const unresolved = failed;

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

	const pendingKeys: PendingKey[] = [];
	for (const [from, entries] of Object.entries(pendingReverses)) {
		const to = mapping.get(from);
		if (to) pendingKeys.push({ from, to, entries: Array.isArray(entries) ? entries.length : 0 });
	}

	const byFrom = (a: { from: string }, b: { from: string }): number => a.from.localeCompare(b.from);
	return {
		nodeCount: existing.size,
		nodeChanges: nodeChanges.sort(byFrom),
		edgeChanges: edgeChanges.sort(byFrom),
		collisions: collisions.sort(byFrom),
		unresolved: [...unresolved.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
		conflicts: conflicts.sort((a, b) => a.slug.localeCompare(b.slug)),
		pendingReverses: pendingKeys.sort(byFrom),
		mapping: Object.fromEntries([...mapping].sort(([a], [b]) => a.localeCompare(b))),
	};
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as unknown;
	} catch (err) {
		throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Throws (exit 2) when `<cacheDir>/nodes` is missing or empty: an empty report must mean "nothing to do". */
export async function readNodes(cacheDir: string): Promise<RawNode[]> {
	const root = join(cacheDir, "nodes");
	const nodes: RawNode[] = [];
	try {
		await readdir(root);
	} catch {
		throw new Error(`${root} is not a readable directory`);
	}
	for (const type of NODE_TYPES) {
		const dir = join(root, type);
		const files = await readdir(dir).catch(() => [] as string[]);
		for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
			const node = await readJson(join(dir, file));
			if (!node || typeof node !== "object") throw new Error(`${join(dir, file)} is not a JSON object`);
			nodes.push(node as RawNode);
		}
	}
	if (nodes.length === 0) throw new Error(`no node found under ${root}`);
	return nodes;
}

/** Absent file = no pending reverse; anything else unreadable throws. */
export async function readPendingReverses(cacheDir: string): Promise<Record<string, unknown>> {
	const file = join(cacheDir, "pending-reverses.json");
	try {
		await access(file);
	} catch {
		return {};
	}
	const parsed = await readJson(file);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${file} is not a JSON object`);
	}
	return parsed as Record<string, unknown>;
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
	out.push(`\nconflicting references (left out of the table, settle by hand): ${r.conflicts.length}`);
	for (const c of r.conflicts) {
		out.push(`  ${c.slug}: ${c.candidates.map((x) => `${x.to} (${x.name})`).join(" | ")}`);
	}
	out.push(`\npending-reverses.json keys to rename: ${r.pendingReverses.length}`);
	for (const k of r.pendingReverses)
		out.push(`  ${k.from} -> ${k.to}   (${k.entries} entr${k.entries === 1 ? "y" : "ies"})`);
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
	const root = resolve(cacheDir);
	const report = measureSlugTransliteration(await readNodes(root), await readPendingReverses(root));
	console.log(formatReport(report));
	if (jsonFile) await writeFile(jsonFile, `${JSON.stringify(report, null, "\t")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	});
}
