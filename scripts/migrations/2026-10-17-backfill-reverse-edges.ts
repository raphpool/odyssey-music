/**
 * Backfill the missing reverse edges (TRA-486, plan docs/plans/graph-integrity.md, part 2) for the four
 * SAFE directions only. TRA-454 declared the cross-type pairs of REVERSE_EDGE_PAIRS for future writes; the
 * cache written before it keeps its holes (a label roster without the artists that name the label, ...).
 * Offline and deterministic: no network, no LLM. To run after the identity migrations (TRA-483).
 *
 * SAFE_BACKFILL_PAIRS: the source is a declared CREDIT or MEMBERSHIP and the target is a LIST on an artist or
 * a label (what an artist released, what a label released or signed). Nothing here ever writes a credit, a
 * parent, a genre, a project or a label ON A WORK or on another artist from the list of a different node.
 * Every other pair of REVERSE_EDGE_PAIRS is skipped and listed in the manifest (`skippedPairs`) with its
 * reason, because the deep review of the first version (PR #484, 2026-10-16) measured what they do on the
 * real cache: a work lists a homonym's artist as its credit (Moderat's "II" would get 2 Unlimited, Deep
 * Space a credit for two artists who list other "Deep Space"), a producer is promoted to artist (Chris
 * Thomas on Never Mind the Bollocks), a homonym's tracklist or genre is copied. They come back with an
 * identity guard in a follow-up ticket.
 * - Skipped, reverse writes a credit on a work (`project.artists`, `track.artists`): the artist's list of
 *   works is not a credit; it holds namesakes' works.
 * - Skipped, reverse writes a work's `project`, `tracklist`, `label` or `genres`: a work-to-work or
 *   genre-to-work link copied from the other side carries the same homonym errors.
 * - Skipped, reverse writes `artist.genres`, `label.genres`, `label.roster`-from-label, `artist.labels`:
 *   a genre or label list on an artist is copied from a node that is not the artist's own claim.
 * - Skipped, reverse writes a relation between two nodes of the same kind (genre parents and subgenres,
 *   artist collaborators / members / aliases / influences, sample and remix links): symmetric by
 *   construction, not a hole of the cross-type kind this backfill targets.
 *
 * Rules:
 * - Dry-run by default; `--apply` writes. Idempotent: a second run plans nothing (written === 0).
 * - The edge it adds is built by `reverseEdgeFor` (src/reverse-edges.ts), the builder NodeCache uses at runtime
 *   (TRA-624, 2026-10-24): same slug, type, name, primary credit and, toward `artist.discography`, project mbid.
 * - Only additions: an existing edge is never removed or modified (the runtime enriches an existing edge with
 *   a missing mbid when the project is rewritten; this script does not). Every added edge points at a node in the
 *   cache; a reference to a node that is not cached goes to pending-reverses.json (as NodeCache does), once,
 *   and only for these four pairs, so a pending entry is always a list entry on an artist or a label.
 * - A reference of the wrong type, or a target whose field holds a malformed value, is never written: it is
 *   listed in `conflicts`.
 * - Nodes are read as raw JSON and the reverse is applied to copies of the TARGETS, from the unmodified
 *   SOURCES. Deliberately not through NodeCache.write / update: they emit the reverses of the reverses and
 *   merge pendings, which is not a backfill.
 * - Every node to write is validated (nodePayloadSchema) before the first write, and the validation must not
 *   drop a field the node carries (the schema strips undeclared ones). One refusal blocks the whole run
 *   (exit 1 in a dry-run, 2 with --apply): nothing is written.
 *
 * Apply order: node files, then pending-reverses.json. After a crash between the two, a re-run completes it.
 *
 * Migration channel (deploy/sync-genre-cache.sh, TRA-488, 2026-10-17): `--apply`, `--manifest` and
 * `--data-dir` are the flags it passes. `--data-dir` is accepted and ignored: this migration reads and writes
 * no redirect table. Symptom before: the channel's `--data-dir` made the parser return null (exit 2) and the
 * apply stopped before any write. The manifest also carries the three fields the channel validates
 * (`removed`, `renamed`, `redirects`), always empty: nothing is deleted, renamed or redirected. The manifest
 * holds no timestamp, so two runs on the same cache give the same bytes (the channel compares previews).
 * The pending entries it adds are list entries on an artist or a label for the four safe pairs only, which
 * `isSafePendingEntry` (2026-10-16-scope-release-slugs.ts) and `isEmittedPendingReverse` (src/reverse-edges.ts)
 * both accept; the channel prints a "RAISED the entries of pending-reverses.json" warning for such a run,
 * which is expected here (a refusal it is not).
 *
 * Usage: tsx scripts/migrations/2026-10-17-backfill-reverse-edges.ts <cache-dir> [--apply]
 *        [--manifest out/reverse-edges.json] [--data-dir <dir>]
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { applySingleReverse, atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { EDGE_FIELDS_BY_TYPE, type NodeType, REVERSE_EDGE_PAIRS } from "../../src/node-spec.js";
import { reverseEdgeFor } from "../../src/reverse-edges.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { isReadableSlug, parseSlug } from "../../src/slug.js";
import type { NodePayload } from "../../src/types.js";
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

/** The only pairs this script backfills, "source.field→target.field". See the header for why. */
export const SAFE_BACKFILL_PAIRS: ReadonlySet<string> = new Set([
	"project.artists→artist.discography",
	"track.artists→artist.notable_tracks",
	"project.label→label.notable_releases",
	"artist.labels→label.roster",
]);

interface Direction {
	field: string;
	targetType: NodeType;
	reverseField: string;
	key: string;
}

// The safe pairs resolved against the spec once: forward field, type of the target, reverse field.
const SAFE_DIRECTIONS_SOURCE = new Map<string, NodeType>();
const SAFE_DIRECTIONS: Direction[] = [];
for (const p of REVERSE_EDGE_PAIRS) {
	const targetType = (EDGE_FIELDS_BY_TYPE[p.sourceType] as Record<string, { targets: readonly NodeType[] }>)[
		p.sourceField
	]?.targets[0];
	if (!targetType || p.reverse.cardinality !== "list") continue;
	const key = pairKey(p.sourceType, p.sourceField, targetType, p.reverse.field);
	if (!SAFE_BACKFILL_PAIRS.has(key)) continue;
	SAFE_DIRECTIONS_SOURCE.set(key, p.sourceType);
	SAFE_DIRECTIONS.push({ field: p.sourceField, targetType, reverseField: p.reverse.field, key });
}

type Obj = Record<string, unknown>;
type PendingFile = Record<string, PendingReverse[]>;

export interface ReverseConflict {
	/** The node holding the forward edge, and its field. */
	source: string;
	field: string;
	/** The node that should receive the reverse edge, and its field. */
	target: string;
	targetField: string;
	/** A reference of the wrong type for the field, or a malformed value in the target field. */
	kind: "target-field";
}

export interface SkippedPair {
	pair: string;
	reason: string;
}

export interface Manifest {
	migration: string;
	mode: "dry-run" | "apply";
	/** Errors refused the run: nothing was written, whatever the mode. */
	blocked: boolean;
	/** Node files written (planned, in a dry-run). */
	written: number;
	/** Reverse edges added per pair, keyed "source.field→target.field". */
	added: Record<string, number>;
	/** New pending-reverses.json entries (the target is not in the cache). */
	pendingAdded: number;
	/** Reverse edges already in place, plus pending entries already queued. */
	unchanged: number;
	conflicts: ReverseConflict[];
	/** The channel's contract (TRA-488): this migration deletes, renames and redirects nothing. */
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	/** Pairs of REVERSE_EDGE_PAIRS this script does not backfill, with the reason. */
	skippedPairs: SkippedPair[];
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

function pairKey(sourceType: NodeType, field: string, targetType: NodeType, targetField: string): string {
	return `${sourceType}.${field}→${targetType}.${targetField}`;
}

function refsOf(value: unknown): Obj[] {
	if (Array.isArray(value)) return value.filter(isRecord);
	return isRecord(value) ? [value] : [];
}

/** Why a pair is not backfilled; see the header. Only called for pairs outside SAFE_BACKFILL_PAIRS. */
function skipReason(
	sourceType: NodeType,
	field: string,
	reverse: { field: string; cardinality: "list" | "single" },
): string {
	const targetTypes = (EDGE_FIELDS_BY_TYPE[sourceType] as Record<string, { targets: readonly NodeType[] }>)[
		field
	]?.targets;
	const targetType = targetTypes?.[0];
	if (targetType === sourceType) return "relation between nodes of the same kind, symmetric by construction";
	if (reverse.field === "artists") return "would write a credit on a work from an artist's list of works";
	if (reverse.cardinality === "single" || reverse.field === "tracklist")
		return "would write a work's project, label or tracklist from the other side's list (homonym links)";
	if (reverse.field === "genres") return "would write a genre on a node from a genre's list (homonym links)";
	return "would write a label or an artist link on a node from the other side's list (no identity guard)";
}

export function skippedPairs(): SkippedPair[] {
	return REVERSE_EDGE_PAIRS.map((p) => ({
		pair: pairKey(
			p.sourceType,
			p.sourceField,
			nodeTypeOfTarget(p.sourceType, p.sourceField),
			p.reverse.field,
		),
		reason: skipReason(p.sourceType, p.sourceField, p.reverse),
	})).filter((p) => !SAFE_BACKFILL_PAIRS.has(p.pair));
}

function nodeTypeOfTarget(sourceType: NodeType, field: string): NodeType {
	const spec = (EDGE_FIELDS_BY_TYPE[sourceType] as Record<string, { targets: readonly NodeType[] }>)[field];
	return spec?.targets[0] ?? sourceType;
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

	for (const source of nodes) {
		for (const { field, targetType, reverseField, key } of SAFE_DIRECTIONS) {
			if (SAFE_DIRECTIONS_SOURCE.get(key) !== source.type) continue;
			// Built by the helper the runtime uses (TRA-624): same edge for the same pair, mbid included.
			const sourceEdge = reverseEdgeFor(
				{ ...source.node, slug: source.slug, type: source.type },
				reverseField,
			);
			const refs = refsOf(source.node[field]);
			if (refs.length > 0 && !sourceEdge) {
				errors.push(`${source.slug}: no name, cannot build a reverse edge from it`);
				continue;
			}
			for (const ref of refs) {
				if (!sourceEdge || typeof ref.slug !== "string" || !isReadableSlug(ref.slug)) continue;
				const base = { source: source.slug, field, target: ref.slug, targetField: reverseField };
				if (parseSlug(ref.slug).type !== targetType) {
					conflicts.push({ ...base, kind: "target-field" });
					continue;
				}
				const target = bySlug.get(ref.slug);
				if (!target) {
					const queue = nextPending[ref.slug] ?? [];
					if (queue.some((p) => p.field === reverseField && p.edge.slug === sourceEdge.slug)) {
						unchanged++;
					} else {
						queue.push({ field: reverseField, cardinality: "list", edge: sourceEdge });
						nextPending[ref.slug] = queue;
						pendingAdded++;
					}
					continue;
				}
				const current = working.get(target.slug) ?? target.node;
				const held = current[reverseField];
				if (held != null && !Array.isArray(held)) {
					// Malformed value in the target: applySingleReverse would replace it, which is not an addition.
					conflicts.push({ ...base, kind: "target-field" });
					continue;
				}
				if (refsOf(held).some((e) => e.slug === sourceEdge.slug)) {
					unchanged++;
					continue;
				}
				working.set(
					target.slug,
					applySingleReverse(current as unknown as NodePayload, {
						field: reverseField,
						cardinality: "list",
						edge: sourceEdge,
					}) as unknown as Obj,
				);
				added[key] = (added[key] ?? 0) + 1;
			}
		}
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
			blocked: false,
			written: writes.size,
			added: Object.fromEntries(Object.entries(added).sort(([a], [b]) => (a < b ? -1 : 1))),
			pendingAdded,
			unchanged,
			conflicts,
			removed: [],
			renamed: {},
			redirects: {},
			skippedPairs: skippedPairs(),
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
	if (apply) manifest.mode = "apply";
	manifest.blocked = blocked;

	if (apply && !blocked) {
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
	lines.push(`  ${"pairs skipped (see manifest)".padEnd(44)} ${manifest.skippedPairs.length}`);
	for (const c of manifest.conflicts.slice(0, 20)) {
		lines.push(`conflict (${c.kind}): ${c.source}.${c.field} -> ${c.target}.${c.targetField}`);
	}
	if (manifest.conflicts.length > 20) lines.push(`... ${manifest.conflicts.length - 20} more conflicts`);
	for (const error of manifest.errors) lines.push(`error: ${error}`);
	if (manifestPath) lines.push(`manifest: ${manifestPath}`);
	if (manifest.blocked) lines.push("blocked: nothing written to the cache");
	else if (manifest.mode === "dry-run")
		lines.push("dry-run: nothing written to the cache (re-run with --apply)");
	return lines.join("\n");
}

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
}

/**
 * `<cache-dir> [--apply] [--manifest p] [--data-dir d]`; null (exit 2) on anything else. `--data-dir` is the
 * migration channel's and is ignored (TRA-488).
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let manifestPath: string | undefined;
	let dataDirSeen = false;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--data-dir" && !dataDirSeen)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else dataDirSeen = true;
		} else return null;
	}
	return { cacheDir, apply, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-17-backfill-reverse-edges.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
