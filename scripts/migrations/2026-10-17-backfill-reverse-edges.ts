/**
 * Backfill the missing reverse edges (TRA-486, plan docs/plans/graph-integrity.md, part 2). TRA-454 declared
 * the cross-type pairs of REVERSE_EDGE_PAIRS for future writes; the cache written before it keeps its holes
 * (a label roster without the artists that name the label, a project without the artists of its credit, ...).
 * This pass applies every pair to every node of an existing cache. Offline and deterministic: no network,
 * no LLM. To run after the identity migrations (TRA-483), so the slugs it reads are the stable ones.
 *
 * Rules:
 * - Dry-run by default; `--apply` writes. Idempotent: a second run plans nothing (written === 0).
 * - Only additions: an existing edge is never removed or modified. Every added edge points at a node in the
 *   cache; a reference to a node that is not cached goes to pending-reverses.json (as NodeCache does), once.
 * - A singular reverse field already set to ANOTHER target is never overwritten (`conflicts`): the cache
 *   says two different things, which a script must not arbitrate. When two sources claim the same empty
 *   singular, the first one in slug order wins and the other is reported the same way.
 * - An artist's release link is NOT reversed onto a work credited to someone else (`foreign-credit`): a
 *   homonym's album in a discography (Rohff -> Akuma's Fitna) would otherwise get the wrong artist grafted
 *   onto its credit, which would also make scripts/audit-cache.ts stop flagging it (homonym-release-links).
 *   Same test as the audit: the work's artists + producers must name the artist, or a group that lists the
 *   artist as a member. A work with no credit at all takes every artist that lists it (the point of the backfill).
 * - Nodes are read as raw JSON and the reverse is applied to copies of the TARGETS, from the unmodified
 *   SOURCES. Deliberately not through NodeCache.write / update: they emit the reverses of the reverses and
 *   merge pendings, which is not a backfill.
 * - Every node to write is validated (nodePayloadSchema) before the first write, and the validation must not
 *   drop a field the node carries (the schema strips undeclared ones). One refusal blocks the whole run
 *   (exit 1 in a dry-run, 2 with --apply): nothing is written.
 *
 * Apply order: node files, then pending-reverses.json. After a crash between the two, a re-run completes it.
 *
 * Usage: tsx scripts/migrations/2026-10-17-backfill-reverse-edges.ts <cache-dir> [--apply]
 *        [--manifest out/reverse-edges.json]
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { applySingleReverse, atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { EDGE_FIELDS_BY_TYPE, type NodeType } from "../../src/node-spec.js";
import { reverseFor, reversibleFields } from "../../src/reverse-edges.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { isReadableSlug } from "../../src/slug.js";
import type { EdgeRef, NodePayload } from "../../src/types.js";
import {
	type CacheNodeFile,
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	readTextOrDefault,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-17-backfill-reverse-edges";
export const DEFAULT_MANIFEST_PATH = "out/reverse-edges.json";

type Obj = Record<string, unknown>;
type PendingFile = Record<string, PendingReverse[]>;

export interface ReverseConflict {
	/** The node holding the forward edge, and its field. */
	source: string;
	field: string;
	/** The node that should receive the reverse edge, and its field. */
	target: string;
	targetField: string;
	kind: "single-occupied" | "target-field" | "foreign-credit";
	/** single-occupied: the slug the singular field already points to. foreign-credit: the first credited slug. */
	existing?: string;
}

export interface Manifest {
	migration: string;
	mode: "dry-run" | "apply";
	/** Node files written (planned, in a dry-run). */
	written: number;
	/** Reverse edges added per pair, keyed "source.field→target.field". */
	added: Record<string, number>;
	/** New pending-reverses.json entries (the target is not in the cache). */
	pendingAdded: number;
	/** Reverse edges already in place, plus pending entries already queued. */
	unchanged: number;
	conflicts: ReverseConflict[];
	errors: string[];
}

export interface Plan {
	/** Raw node to write, by file path. */
	writes: Map<string, Obj>;
	/** The whole pending file after the run, or null when it does not change. */
	pending: PendingFile | null;
	manifest: Manifest;
}

const pendingFileSchema = z.record(
	z.string(),
	z.array(
		z.object({
			field: z.string(),
			cardinality: z.enum(["list", "single"]),
			edge: z.object({ slug: z.string(), type: z.string(), name: z.string() }).passthrough(),
		}),
	),
);

function refsOf(value: unknown): Obj[] {
	if (Array.isArray(value)) return value.filter(isRecord);
	return isRecord(value) ? [value] : [];
}

/** The edge a source node's slug becomes on the target: what NodeCache.emitReverses builds, plus the credit. */
function sourceEdgeOf(source: CacheNodeFile): EdgeRef | null {
	const { node } = source;
	if (typeof node.name !== "string" || node.name === "") return null;
	const edge: EdgeRef = { slug: source.slug as EdgeRef["slug"], type: source.type, name: node.name };
	if (source.type === "genre" && typeof node.qid === "string" && node.qid !== "") edge.qid = node.qid;
	if (source.type === "project" || source.type === "track") {
		const first = refsOf(node.artists)[0];
		if (first && typeof first.name === "string" && first.name !== "") edge.artist = first.name;
	}
	return edge;
}

function pairKey(sourceType: NodeType, field: string, targetType: NodeType, targetField: string): string {
	return `${sourceType}.${field}→${targetType}.${targetField}`;
}

/**
 * True when the work was credited (artists + producers) before this run and neither that credit, as it has
 * grown since, names `artistSlug` nor a group listing it. A work with no credit at the start takes every
 * artist that lists it: crediting only the first would turn the others into homonym links in the audit.
 */
function foreignCredit(
	artistSlug: string,
	original: Obj,
	current: Obj,
	bySlug: ReadonlyMap<string, CacheNodeFile>,
): boolean {
	if (refsOf(original.artists).length + refsOf(original.producers).length === 0) return false;
	const credited = [...refsOf(current.artists), ...refsOf(current.producers)].map((e) => e.slug);
	return !credited.some(
		(slug) =>
			slug === artistSlug ||
			(typeof slug === "string" && refsOf(bySlug.get(slug)?.node.members).some((m) => m.slug === artistSlug)),
	);
}

/** Pure plan: what to write and what to report. Does not touch the disk. */
export function planBackfill(nodes: readonly CacheNodeFile[], currentPending: PendingFile): Plan {
	const bySlug = new Map(nodes.map((n) => [n.slug, n]));
	// Copies of the targets edited so far; sources are always read from the original nodes.
	const working = new Map<string, Obj>();
	const added: Record<string, number> = {};
	const conflicts: ReverseConflict[] = [];
	const errors: string[] = [];
	let unchanged = 0;
	let pendingAdded = 0;
	const nextPending: PendingFile = structuredClone(currentPending);

	// The credit guard (foreignCredit) reads the credit as it stands, which this pass itself grows: a member
	// can be seen before the group that credits it. One pass would then leave edges a second run adds, so the
	// pass is repeated until it adds nothing (credits only grow, so it ends); `unchanged` and the pending
	// counts are those of the first pass (what was already there), `conflicts` those of the last.
	for (let pass = 0; ; pass++) {
		const first = pass === 0;
		const addedBefore = Object.values(added).reduce((sum, n) => sum + n, 0);
		conflicts.length = 0;
		for (const source of nodes) {
			const sourceEdge = sourceEdgeOf(source);
			if (!sourceEdge) {
				if (first && reversibleFields(source.type).some((f) => refsOf(source.node[f]).length > 0)) {
					errors.push(`${source.slug}: no name, cannot build a reverse edge from it`);
				}
				continue;
			}
			for (const field of reversibleFields(source.type)) {
				const reverse = reverseFor(source.type, field);
				if (!reverse) continue;
				for (const ref of refsOf(source.node[field])) {
					if (typeof ref.slug !== "string" || !isReadableSlug(ref.slug)) continue;
					const target = bySlug.get(ref.slug);
					if (!target) {
						if (!first) continue;
						const queue = nextPending[ref.slug] ?? [];
						if (queue.some((p) => p.field === reverse.field && p.edge.slug === sourceEdge.slug)) {
							unchanged++;
						} else {
							queue.push({ field: reverse.field, cardinality: reverse.cardinality, edge: sourceEdge });
							nextPending[ref.slug] = queue;
							pendingAdded++;
						}
						continue;
					}
					const accepts = (
						EDGE_FIELDS_BY_TYPE[target.type] as Record<string, { targets: readonly NodeType[] }>
					)[reverse.field];
					const base = { source: source.slug, field, target: target.slug, targetField: reverse.field };
					if (!accepts?.targets.includes(source.type)) {
						conflicts.push({ ...base, kind: "target-field" });
						continue;
					}
					const current = working.get(target.slug) ?? target.node;
					if (
						source.type === "artist" &&
						reverse.field === "artists" &&
						foreignCredit(source.slug, target.node, current, bySlug)
					) {
						conflicts.push({
							...base,
							kind: "foreign-credit",
							existing: String(refsOf(current.artists)[0]?.slug),
						});
						continue;
					}
					const held = current[reverse.field];
					if (reverse.cardinality === "list") {
						if (refsOf(held).some((e) => e.slug === sourceEdge.slug)) {
							if (first) unchanged++;
							continue;
						}
					} else if (isRecord(held)) {
						if (held.slug === sourceEdge.slug) {
							if (first) unchanged++;
						} else conflicts.push({ ...base, kind: "single-occupied", existing: String(held.slug) });
						continue;
					}
					working.set(
						target.slug,
						applySingleReverse(current as unknown as NodePayload, {
							field: reverse.field,
							cardinality: reverse.cardinality,
							edge: sourceEdge,
						}) as unknown as Obj,
					);
					const key = pairKey(source.type, field, target.type, reverse.field);
					added[key] = (added[key] ?? 0) + 1;
				}
			}
		}
		if (Object.values(added).reduce((sum, n) => sum + n, 0) === addedBefore) break;
	}

	// Validate every node to write before the caller writes any.
	const writes = new Map<string, Obj>();
	for (const [slug, next] of [...working].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const path = bySlug.get(slug)?.path;
		if (!path) continue;
		const parsed = nodePayloadSchema.safeParse(next);
		if (!parsed.success) {
			errors.push(`${slug}: refusing to write an invalid node: ${parsed.error.message}`);
		} else if (!onlyAddsSchemaDefaults(next, parsed.data)) {
			errors.push(`${slug}: refusing to write: validation would alter fields the node carries`);
		} else {
			writes.set(path, parsed.data as unknown as Obj);
		}
	}

	return {
		writes,
		pending: pendingAdded > 0 ? nextPending : null,
		manifest: {
			migration: MIGRATION_NAME,
			mode: "dry-run",
			written: writes.size,
			added: Object.fromEntries(Object.entries(added).sort(([a], [b]) => (a < b ? -1 : 1))),
			pendingAdded,
			unchanged,
			conflicts,
			errors,
		},
	};
}

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
}

export async function runMigration(options: RunOptions): Promise<{ manifest: Manifest; exitCode: number }> {
	const { cacheDir, apply } = options;
	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	const pendingPath = join(cacheDir, "pending-reverses.json");
	let pending: PendingFile = {};
	const pendingErrors: string[] = [];
	try {
		const parsed = pendingFileSchema.safeParse(JSON.parse(await readTextOrDefault(pendingPath, "{}")));
		if (parsed.success) pending = parsed.data as PendingFile;
		else pendingErrors.push(`pending-reverses.json is invalid: ${parsed.error.message}`);
	} catch (e) {
		pendingErrors.push(`pending-reverses.json is unreadable: ${e instanceof Error ? e.message : String(e)}`);
	}

	const plan = planBackfill(nodes, pending);
	const manifest = plan.manifest;
	manifest.errors.push(...pendingErrors);
	for (const entry of invalid) manifest.errors.push(`unreadable node file ${entry.path}: ${entry.error}`);
	const blocked = manifest.errors.length > 0;

	if (apply && !blocked) {
		manifest.mode = "apply";
		for (const [path, node] of plan.writes) await atomicWriteJson(path, node);
		if (plan.pending) await atomicWriteJson(pendingPath, plan.pending);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: blocked ? (apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	for (const [key, count] of Object.entries(manifest.added)) lines.push(`  ${key.padEnd(44)} +${count}`);
	lines.push(`  ${"node files written".padEnd(44)} ${manifest.written}`);
	lines.push(`  ${"pending entries added".padEnd(44)} ${manifest.pendingAdded}`);
	lines.push(`  ${"already in place".padEnd(44)} ${manifest.unchanged}`);
	lines.push(`  ${"conflicts".padEnd(44)} ${manifest.conflicts.length}`);
	for (const c of manifest.conflicts.slice(0, 20)) {
		lines.push(
			`conflict (${c.kind}): ${c.source}.${c.field} -> ${c.target}.${c.targetField}` +
				(c.existing ? ` already ${c.existing}` : ""),
		);
	}
	if (manifest.conflicts.length > 20) lines.push(`... ${manifest.conflicts.length - 20} more conflicts`);
	for (const error of manifest.errors) lines.push(`error: ${error}`);
	if (manifestPath) lines.push(`manifest: ${manifestPath}`);
	if (manifest.mode === "dry-run") lines.push("dry-run: nothing written to the cache (re-run with --apply)");
	return lines.join("\n");
}

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
}

/** `<cache-dir> [--apply] [--manifest p]`; null (exit 2) on anything else. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let manifestPath: string | undefined;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--manifest" && manifestPath === undefined) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			manifestPath = value;
		} else return null;
	}
	return { cacheDir, apply, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-17-backfill-reverse-edges.ts <cache-dir> [--apply] [--manifest <path>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runMigration(args);
	console.log(formatSummary(result.manifest, args.manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
