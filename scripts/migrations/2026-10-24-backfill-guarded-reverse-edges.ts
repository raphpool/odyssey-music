/**
 * Backfill the missing reverse edges of the pairs that 2026-10-17-backfill-reverse-edges skipped, one pair at a
 * time, each behind an IDENTITY GUARD (TRA-564, plan docs/plans/graph-integrity.md, part 2). Offline and
 * deterministic: no network, no LLM.
 *
 * Why a successor and not a bigger SAFE_BACKFILL_PAIRS (src/reverse-edges.ts): that set also decides which
 * directions `NodeCache.write` emits at runtime and which `reciprocity-missing` pairs the audit caps (TRA-567).
 * Adding a cross-type pair to it would turn the unguarded runtime emission back on (TRA-563, 2026-10-16: writing
 * "Rohff" re-added Rohff to the credits of Akuma's "Fitna"). A guard here applies to this backfill only, so the
 * runtime stays as TRA-563 left it. The 2026-10-17 script is untouched: it was applied by the channel, and what it
 * did must stay reproducible.
 *
 * A reverse edge is written only when the guard of its pair PROVES the identity of the node it lands on. The slug
 * alone proves nothing: slugs collide between namesakes (the deep review of PR #484 grafted Moderat's "II" two
 * Unlimited credits, gave Deep Space a credit for two artists who list other "Deep Space", promoted a producer).
 * An edge the guard cannot prove is listed in the manifest (`doubtful`, with the reason), never written.
 *
 * Pairs and their guard (add a pair = add a line to GUARDS, a guard if none fits, and a test; only a pair the
 * runtime emits is accepted, the others are not caught up: decision on TRA-564):
 * - genre.related_genres→genre.related_genres, genre.parent_genres→genre.subgenres and
 *   genre.subgenres→genre.parent_genres (`sameQid`): the edge's Wikidata id (`qid`, set by the registry when the
 *   genre was resolved, TRA-18) equals the qid of the genre it points at. A genre qid is unique in the cache and
 *   the registry mints one slug per qid, so a match is the same genre; a missing or different qid is not a proof.
 * - NOT backfilled: artist.collaborators→artist.collaborators. No collaborator edge carries an mbid (0 of 873 on
 *   2026-10-24) and the slug comes from the name, so nothing on the edge says which namesake the author meant: a
 *   "Chris Thomas" edge meant for the bluesman would be grafted on the English producer (deep review of PR #636).
 *   Left at its ceiling (3), by decision of the dispatcher, until edges carry an artist mbid.
 *
 * Rules:
 * - Dry-run by default; `--apply` writes. Idempotent: a second run plans nothing (written === 0).
 * - The edge it adds is built by `reverseEdgeFor` (src/reverse-edges.ts), the builder NodeCache uses at runtime.
 * - Only additions: an existing edge is never removed, modified or reordered.
 * - No pending entry, ever: a target that is not in the cache cannot be proven, and a pending entry is applied
 *   later without any check of the node it lands on (TRA-565). `pending-reverses.json` is not read or written.
 * - A reference of the wrong type, or a target whose field holds a malformed value, is never written: it is
 *   listed in `conflicts`.
 * - Nodes are read as raw JSON and the reverse is applied to copies of the TARGETS, from the unmodified
 *   SOURCES, not through NodeCache.write (it would emit the reverses of the reverses).
 * - Every node to write is validated (nodePayloadSchema) before the first write, and the validation must not
 *   drop a field the node carries. One refusal blocks the whole run (exit 1 in a dry-run, 2 with --apply).
 *
 * Migration channel (deploy/sync-genre-cache.sh): `--apply`, `--manifest` and `--data-dir` are the flags it
 * passes; `--data-dir` is accepted and ignored. The manifest carries the three fields the channel validates
 * (`removed`, `renamed`, `redirects`), always empty, and no timestamp (the channel compares previews).
 * Extending the pair list later re-runs the same name: the migration only adds what is still missing.
 *
 * Usage: tsx scripts/migrations/2026-10-24-backfill-guarded-reverse-edges.ts <cache-dir> [--apply]
 *        [--manifest out/guarded-reverse-edges.json] [--data-dir <dir>]
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { applySingleReverse, atomicWriteJson } from "../../src/cache.js";
import { EDGE_FIELDS_BY_TYPE, type NodeType, REVERSE_EDGE_PAIRS } from "../../src/node-spec.js";
import { isEmittedReversePair, reverseEdgeFor } from "../../src/reverse-edges.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { isReadableSlug, parseSlug } from "../../src/slug.js";
import type { NodePayload } from "../../src/types.js";
import {
	type CacheNodeFile,
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";
import { type CliArgs, parseCliArgs as parseSharedCliArgs } from "./2026-10-17-backfill-reverse-edges.js";

export const MIGRATION_NAME = "2026-10-24-backfill-guarded-reverse-edges";
export const DEFAULT_MANIFEST_PATH = "out/guarded-reverse-edges.json";

type Obj = Record<string, unknown>;

export type Verdict = { proven: true } | { proven: false; reason: string };

/** What a guard looks at: the source node, the edge it holds, and the node that edge points at. */
export interface GuardInput {
	source: Obj;
	ref: Obj;
	target: Obj;
}

export type Guard = (input: GuardInput) => Verdict;

const PROVEN: Verdict = { proven: true };

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const QID = /^Q[1-9][0-9]*$/;

/**
 * Both ends are proven. The edge and the node it points at carry the same Wikidata id (the target is the genre
 * the author meant), AND the source carries a valid qid of its own: the reverse edge is the source, and
 * `reverseEdgeFor` gives it a qid only if the source has one. Without it the target would receive a genre it
 * cannot tell from a duplicate of that genre (review of PR #634, 2026-10-24: `genre:hi-nrg-hi-nrg`, a
 * qid-less duplicate of `genre:hi-nrg`, was listed a second time in house and techno).
 */
export const sameQid: Guard = ({ source, ref, target }) => {
	const own = nonEmptyString(source.qid);
	if (!own || !QID.test(own)) return { proven: false, reason: "source-without-qid" };
	const claimed = nonEmptyString(ref.qid);
	if (!claimed) return { proven: false, reason: "edge-without-qid" };
	const held = nonEmptyString(target.qid);
	if (!held) return { proven: false, reason: "target-without-qid" };
	return claimed === held ? PROVEN : { proven: false, reason: "qid-mismatch" };
};

/** "source.field→target.field" -> its guard. A pair that is not here is not backfilled by this script. */
const GUARDS: Readonly<Record<string, Guard>> = {
	"genre.related_genres→genre.related_genres": sameQid,
	"genre.parent_genres→genre.subgenres": sameQid,
	"genre.subgenres→genre.parent_genres": sameQid,
};

export const GUARDED_PAIRS: readonly string[] = Object.keys(GUARDS);

export interface Direction {
	key: string;
	sourceType: NodeType;
	field: string;
	targetType: NodeType;
	reverseField: string;
	guard: Guard;
}

function pairKey(sourceType: NodeType, field: string, targetType: NodeType, targetField: string): string {
	return `${sourceType}.${field}→${targetType}.${targetField}`;
}

/**
 * The guarded pairs resolved against the spec. Refuses (throws) a key that is not a declared list pair of
 * REVERSE_EDGE_PAIRS (a typo would silently backfill nothing), and a pair the runtime does not emit
 * (`isEmittedReversePair`, TRA-567): the dispatcher's decision of 2026-10-24 on TRA-564 is that those are not
 * caught up, because the runtime refuses to emit them for lack of a reliable guard (TRA-563). The table stays
 * inside the set of pairs the audit caps.
 */
export function resolveDirections(guards: Readonly<Record<string, Guard>>): Direction[] {
	const directions: Direction[] = [];
	for (const p of REVERSE_EDGE_PAIRS) {
		const targetType = (
			EDGE_FIELDS_BY_TYPE[p.sourceType] as Record<string, { targets: readonly NodeType[] }>
		)[p.sourceField]?.targets[0];
		if (!targetType || p.reverse.cardinality !== "list") continue;
		const key = pairKey(p.sourceType, p.sourceField, targetType, p.reverse.field);
		const guard = guards[key];
		if (!guard) continue;
		if (!isEmittedReversePair(p.sourceType, p.sourceField, p.reverse.field)) {
			throw new Error(`${key} is not a direction the runtime emits: it is not backfilled (TRA-564, TRA-567)`);
		}
		directions.push({
			key,
			sourceType: p.sourceType,
			field: p.sourceField,
			targetType,
			reverseField: p.reverse.field,
			guard,
		});
	}
	const unknown = Object.keys(guards).filter((k) => !directions.some((d) => d.key === k));
	if (unknown.length > 0) {
		throw new Error(`guards for a pair that REVERSE_EDGE_PAIRS does not declare as a list: ${unknown}`);
	}
	return directions;
}

const DIRECTIONS = resolveDirections(GUARDS);

export interface DoubtfulEdge {
	pair: string;
	/** The node holding the forward edge, and the node it points at. */
	source: string;
	target: string;
	reason: string;
}

export interface ReverseConflict {
	source: string;
	field: string;
	target: string;
	targetField: string;
	/**
	 * "wrong-type-ref": the reference points at a node of another type than the field allows.
	 * "malformed-target-field": the field of the node that would receive the edge does not hold a list.
	 */
	kind: "wrong-type-ref" | "malformed-target-field";
}

export interface Manifest {
	migration: string;
	mode: "dry-run" | "apply";
	/** Errors refused the run: nothing was written, whatever the mode. */
	blocked: boolean;
	/** Node files written (planned, in a dry-run). */
	written: number;
	/** The pairs this run backfills. */
	guardedPairs: string[];
	/** Reverse edges added per pair. */
	added: Record<string, number>;
	/** Reverse edges already in place. */
	unchanged: number;
	/** Forward edges to a node that is not in the cache: nothing to prove, nothing written, no pending entry. */
	targetNotCached: number;
	/** Count of the doubtful edges per pair, then per reason. */
	doubtfulByReason: Record<string, Record<string, number>>;
	/** Every edge a guard refused, never written. */
	doubtful: DoubtfulEdge[];
	conflicts: ReverseConflict[];
	/** The channel's contract (TRA-488): this migration deletes, renames and redirects nothing. */
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	errors: string[];
}

export interface Plan {
	/** Raw node to write, by file path. */
	writes: Map<string, Obj>;
	manifest: Manifest;
}

function refsOf(value: unknown): Obj[] {
	if (Array.isArray(value)) return value.filter(isRecord);
	return isRecord(value) ? [value] : [];
}

/** Pure plan: what to write and what to report. Does not touch the disk. */
export function planBackfill(nodes: readonly CacheNodeFile[]): Plan {
	const bySlug = new Map(nodes.map((n) => [n.slug, n]));
	// Copies of the targets edited so far; sources are always read from the original nodes.
	const working = new Map<string, Obj>();
	const added: Record<string, number> = {};
	const doubtful: DoubtfulEdge[] = [];
	const doubtfulByReason: Record<string, Record<string, number>> = {};
	const conflicts: ReverseConflict[] = [];
	const errors: string[] = [];
	let unchanged = 0;
	let targetNotCached = 0;

	const refuse = (d: DoubtfulEdge): void => {
		doubtful.push(d);
		const byReason = doubtfulByReason[d.pair] ?? {};
		byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
		doubtfulByReason[d.pair] = byReason;
	};

	for (const source of nodes) {
		for (const { key, sourceType, field, targetType, reverseField, guard } of DIRECTIONS) {
			if (source.type !== sourceType) continue;
			const refs = refsOf(source.node[field]);
			if (refs.length === 0) continue;
			const sourceEdge = reverseEdgeFor(
				{ ...source.node, slug: source.slug, type: source.type },
				reverseField,
			);
			for (const ref of refs) {
				if (typeof ref.slug !== "string" || !isReadableSlug(ref.slug)) {
					refuse({ pair: key, source: source.slug, target: String(ref.slug), reason: "unreadable-slug" });
					continue;
				}
				const base = { pair: key, source: source.slug, target: ref.slug };
				const conflict = { source: source.slug, field, target: ref.slug, targetField: reverseField };
				if (parseSlug(ref.slug).type !== targetType) {
					conflicts.push({ ...conflict, kind: "wrong-type-ref" });
					continue;
				}
				if (!sourceEdge) {
					refuse({ ...base, reason: "source-without-name" });
					continue;
				}
				// A node listing itself: the reverse would be the same edge, and it proves nothing about anyone.
				if (ref.slug === source.slug) {
					refuse({ ...base, reason: "self-edge" });
					continue;
				}
				const target = bySlug.get(ref.slug);
				if (!target) {
					targetNotCached++;
					continue;
				}
				const current = working.get(target.slug) ?? target.node;
				const held = current[reverseField];
				if (held != null && !Array.isArray(held)) {
					// Malformed value in the target: applySingleReverse would replace it, which is not an addition.
					conflicts.push({ ...conflict, kind: "malformed-target-field" });
					continue;
				}
				if (refsOf(held).some((e) => e.slug === sourceEdge.slug)) {
					unchanged++;
					continue;
				}
				const verdict = guard({ source: source.node, ref, target: target.node });
				if (!verdict.proven) {
					refuse({ ...base, reason: verdict.reason });
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
			// `next`, not `parsed.data`: the parse reorders keys (qid moves after editorial_definition), and the
			// file must change by its appended edge only. The check above guarantees the parse adds nothing else.
			writes.set(path, next);
		}
	}

	return {
		writes,
		manifest: {
			migration: MIGRATION_NAME,
			mode: "dry-run",
			blocked: false,
			written: writes.size,
			guardedPairs: [...GUARDED_PAIRS],
			added: Object.fromEntries(Object.entries(added).sort(([a], [b]) => (a < b ? -1 : 1))),
			unchanged,
			targetNotCached,
			doubtfulByReason,
			doubtful,
			conflicts,
			removed: [],
			renamed: {},
			redirects: {},
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

	const plan = planBackfill(nodes);
	const manifest = plan.manifest;
	for (const entry of invalid) manifest.errors.push(`unreadable node file ${entry.path}: ${entry.error}`);
	const blocked = manifest.errors.length > 0;
	if (apply) manifest.mode = "apply";
	manifest.blocked = blocked;
	if (blocked) manifest.written = 0;

	if (apply && !blocked) {
		for (const [path, node] of plan.writes) await atomicWriteJson(path, node);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: blocked ? (apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	for (const pair of manifest.guardedPairs) {
		lines.push(`  ${pair.padEnd(48)} +${manifest.added[pair] ?? 0}`);
		for (const [reason, count] of Object.entries(manifest.doubtfulByReason[pair] ?? {})) {
			lines.push(`    not written, ${reason}: ${count}`);
		}
	}
	lines.push(`  ${"node files written".padEnd(48)} ${manifest.written}`);
	lines.push(`  ${"already in place".padEnd(48)} ${manifest.unchanged}`);
	lines.push(`  ${"target not in the cache".padEnd(48)} ${manifest.targetNotCached}`);
	lines.push(`  ${"conflicts".padEnd(48)} ${manifest.conflicts.length}`);
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

/** Same CLI as the 2026-10-17 backfill (`<cache-dir> [--apply] [--manifest p] [--data-dir d]`), own default manifest. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	return parseSharedCliArgs(argv, DEFAULT_MANIFEST_PATH);
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			`usage: ${MIGRATION_NAME}.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n`,
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
