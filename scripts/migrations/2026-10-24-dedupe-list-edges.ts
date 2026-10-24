/**
 * One edge per slug in the list edge fields of the cache (TRA-557, plan docs/plans/graph-integrity.md). The deep
 * review of TRA-478 (#477) found 175 entries that repeat the slug of an earlier entry of their list; measured
 * on 2026-10-24 on origin/main: 173 in 83 nodes (166 `artist.discography`, 6 `project.tracklist`, 1
 * `project.personnel`), every one with an mbid different from its neighbour's (a single, its remixes and the
 * album of one title share a scoped slug). Decision of the dispatcher (2026-10-23, comment on TRA-557): one page
 * per title, no suffixed slug per release group, so the lists are deduplicated and the pages stay as they are.
 *
 * The rule is `dedupeEdgeList` (src/edge-dedupe.ts, which documents it), the one the pipeline applies at
 * generation; this migration alone also gives it the mbid of the target nodes (first criterion of the dispatcher):
 *  - same mbid, or an mbid missing on one side: the first occurrence stays and takes the fields it lacks;
 *  - different mbids: the entry carrying the mbid of the node the slug points at, then the title that is not a
 *    variant (a remix never replaces its original, as `classifyRelease` keeps it out of a generated
 *    discography), then the title without a trailing parenthesis, then album before EP before single, then the
 *    earliest year; no field is merged across two mbids;
 *  - a tie: doubt, the first occurrence stays and the case is listed in `doubts`. MusicBrainz votes would break
 *    it; they are not in the cache, and this migration never calls a network.
 * The target nodes matter on the channel's union (repository + server snapshot): there, a click on a duplicated
 * puce materializes the page from ONE release group and `repointSourceEdge` (src/services/materialize-service.ts)
 * rewrites EVERY entry of the slug onto it, so the page carries one of the mbids of the list. In the repository
 * alone it almost never applies (measured 2026-10-24: 147 of the 148 repeated slugs have no node, the slug is
 * bare while the nodes are scoped; the 148th has no mbid). The table is built from the nodes read, whichever
 * list or node type holds the edge.
 *
 * Rules:
 * - Every list edge field of every node (`LIST_EDGES_BY_TYPE`) is read; a list without a repeated slug is not
 *   touched, byte for byte. In a list with one, the surviving entries keep their relative order (a discography
 *   stays sorted newest first) and the other fields of the node, and the order of its keys, do not change.
 * - The singular picks (`landmark_project`, `reference_track`) are not edited: they are members of their list
 *   by slug, and the slug survives. A pick whose mbid is not the kept entry's is listed in `pickDrift`.
 * - Every removed entry, its reason and the entry that replaces it are in the manifest (`removals`): nothing is
 *   lost silently.
 * - Dry-run by default; the manifest of a dry-run and of the apply that follows are identical but for
 *   `generated_at` and `mode`. Idempotent: a second run writes nothing (`written === 0`).
 * - Every node to write is validated (`nodePayloadSchema`) before the first write, and the validation must not
 *   drop a field the node carries. What is written is the node as read with its lists changed (the validated
 *   copy only gates the write). One refusal blocks the whole run: it is listed in `errors` and nothing is
 *   written (exit 1 in a dry-run, 2 with --apply).
 *
 * Offline and deterministic: no network, no LLM.
 *
 * Channel contract (deploy/sync-genre-cache.sh --migration): `<cache-dir> --apply --manifest <path>
 * --data-dir <dir>`. `--data-dir` is accepted and ignored (this migration reads no table). The manifest holds
 * `migration`, `removed: []`, `renamed: {}` and `redirects: {}`: it never deletes or renames a node.
 *
 * Usage: tsx scripts/migrations/2026-10-24-dedupe-list-edges.ts <cache-dir> [--apply]
 *        [--manifest out/dedupe-list-edges.json] [--data-dir <dir>]
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../../src/cache.js";
import {
	type DedupeReason,
	dedupeNodeListEdges,
	type EdgeRemoval,
	type TargetMbids,
} from "../../src/edge-dedupe.js";
import { SINGULAR_EDGES_BY_TYPE } from "../../src/node-spec.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import {
	type CacheNodeFile,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";
import type { ChangedNode } from "./2026-10-15-unescape-newlines.js";

export const MIGRATION_NAME = "2026-10-24-dedupe-list-edges";
export const DEFAULT_MANIFEST_PATH = "out/dedupe-list-edges.json";

type Obj = Record<string, unknown>;

/** What identifies an entry in the manifest: enough to find the release group again, nothing more. */
export interface EdgeSummary {
	name: string | null;
	mbid: string | null;
	year: string | null;
	releaseType: string | null;
}

export interface RemovalRecord {
	node: string;
	field: string;
	slug: string;
	reason: DedupeReason;
	removed: EdgeSummary;
	kept: EdgeSummary;
}

/** A singular pick on a deduplicated slug whose mbid is not the kept entry's (listed, never edited). */
export interface PickDrift {
	node: string;
	field: string;
	slug: string;
	pickMbid: string | null;
	keptMbid: string | null;
}

export interface Manifest {
	migration: string;
	generated_at: string;
	mode: "dry-run" | "apply";
	/** Errors refused the run: nothing was written, whatever the mode. */
	blocked: boolean;
	/** The channel's contract (deploy/sync-genre-cache.sh): this migration never deletes, renames or redirects. */
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	/** Node files written (planned, in a dry-run). */
	written: number;
	/** Entries removed, in total. */
	removedEdges: number;
	/** Entries removed, by `type.field`. */
	byField: Record<string, number>;
	/** Entries removed, by reason. */
	byReason: Record<string, number>;
	/** The nodes to write and the lists that change, by slug. */
	changed: ChangedNode[];
	/** Every removed entry, with the one that stays. */
	removals: RemovalRecord[];
	/** The removals where nothing told the entries apart: the first occurrence stayed. A subset of `removals`. */
	doubts: RemovalRecord[];
	pickDrift: PickDrift[];
	errors: string[];
}

export interface Plan {
	/** Raw node to write, by file path. */
	writes: Map<string, Obj>;
	manifest: Manifest;
}

const bySlug = (a: ChangedNode, b: ChangedNode): number => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

function text(v: unknown): string | null {
	return typeof v === "string" && v !== "" ? v : null;
}

function summary(edge: Obj): EdgeSummary {
	return {
		name: text(edge.name),
		mbid: text(edge.mbid),
		year: text(edge.year),
		releaseType: text(edge.releaseType),
	};
}

function record(node: string, field: string, r: EdgeRemoval): RemovalRecord {
	return { node, field, slug: r.slug, reason: r.reason, removed: summary(r.removed), kept: summary(r.kept) };
}

function sorted(counts: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Singular picks of `node` that sit on a slug whose kept entry has another mbid than the pick. */
function driftOf(
	slug: string,
	type: CacheNodeFile["type"],
	original: Obj,
	removals: EdgeRemoval[],
): PickDrift[] {
	const out: PickDrift[] = [];
	for (const field of SINGULAR_EDGES_BY_TYPE[type]) {
		const pick = original[field];
		if (pick === null || typeof pick !== "object" || Array.isArray(pick)) continue;
		const pickSlug = (pick as Obj).slug;
		const hit = removals.find((r) => r.slug === pickSlug);
		if (hit === undefined) continue;
		const pickMbid = text((pick as Obj).mbid);
		const keptMbid = text(hit.kept.mbid);
		if (pickMbid?.toLowerCase() !== keptMbid?.toLowerCase()) {
			out.push({ node: slug, field, slug: String(pickSlug), pickMbid, keptMbid });
		}
	}
	return out;
}

/** slug -> lower-cased mbid of the nodes read that carry one: what an edge's mbid is compared with. */
function targetMbidsOf(nodes: readonly CacheNodeFile[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const { slug, node } of nodes) {
		const mbid = text(node.mbid)?.trim().toLowerCase();
		if (mbid) out.set(slug, mbid);
	}
	return out;
}

/** Pure plan: what to write and what to report. Does not touch the disk. */
export function planDedupeListEdges(nodes: readonly CacheNodeFile[]): Plan {
	const writes = new Map<string, Obj>();
	const byField: Record<string, number> = {};
	const byReason: Record<string, number> = {};
	const changed: ChangedNode[] = [];
	const removals: RemovalRecord[] = [];
	const pickDrift: PickDrift[] = [];
	const errors: string[] = [];

	const targetMbids: TargetMbids = targetMbidsOf(nodes);
	for (const { path, slug, type, node } of nodes) {
		const next: Obj = { ...node };
		const perField = dedupeNodeListEdges(next, targetMbids);
		if (perField.length === 0) continue;

		const parsed = nodePayloadSchema.safeParse(next);
		const fields = perField.map((f) => f.field);
		if (!parsed.success) {
			errors.push(
				`${slug}: refusing to write an invalid node (${fields.join(", ")}): ${parsed.error.message}`,
			);
			continue;
		}
		if (!onlyAddsSchemaDefaults(next, parsed.data)) {
			errors.push(`${slug}: refusing to write: validation would alter fields the node carries`);
			continue;
		}

		// The node as read, lists apart: the parsed copy would also add the empty lists a node lacks (members,
		// similar_artists...), a change nobody asked this migration for.
		writes.set(path, next);
		changed.push({ slug, fields });
		pickDrift.push(
			...driftOf(
				slug,
				type,
				node,
				perField.flatMap((f) => f.removals),
			),
		);
		for (const { field, removals: list } of perField) {
			for (const r of list) {
				removals.push(record(slug, field, r));
				byField[`${type}.${field}`] = (byField[`${type}.${field}`] ?? 0) + 1;
				byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
			}
		}
	}

	return {
		writes,
		manifest: {
			migration: MIGRATION_NAME,
			generated_at: new Date().toISOString(),
			mode: "dry-run",
			blocked: false,
			removed: [],
			renamed: {},
			redirects: {},
			written: writes.size,
			removedEdges: removals.length,
			byField: sorted(byField),
			byReason: sorted(byReason),
			changed: changed.sort(bySlug),
			removals,
			doubts: removals.filter((r) => r.reason === "doubt-first-kept"),
			pickDrift,
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
	const { nodes, invalid } = await readCacheNodes(options.cacheDir);
	warnSkippedNodeFiles(invalid);
	const plan = planDedupeListEdges(nodes);
	const manifest = plan.manifest;
	for (const entry of invalid) manifest.errors.push(`unreadable node file ${entry.path}: ${entry.error}`);
	const blocked = manifest.errors.length > 0;
	if (options.apply) manifest.mode = "apply";
	manifest.blocked = blocked;

	if (options.apply && !blocked) {
		for (const [path, node] of plan.writes) await atomicWriteJson(path, node);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: blocked ? (options.apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	lines.push(`  ${"node files written".padEnd(32)} ${manifest.written}`);
	lines.push(`  ${"entries removed".padEnd(32)} ${manifest.removedEdges}`);
	for (const [field, count] of Object.entries(manifest.byField)) {
		lines.push(`    ${field.padEnd(30)} ${count}`);
	}
	for (const [reason, count] of Object.entries(manifest.byReason)) {
		lines.push(`  ${reason.padEnd(32)} ${count}`);
	}
	lines.push(`  ${"picks on another mbid".padEnd(32)} ${manifest.pickDrift.length}`);
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
	/** Part of the channel's contract; this migration reads no table, so it is parsed and ignored. */
	dataDir: string | undefined;
}

/** `<cache-dir> [--apply] [--manifest p] [--data-dir d]`; null (exit 2) on anything else. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let manifestPath: string | undefined;
	let dataDir: string | undefined;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--manifest" && manifestPath === undefined) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			manifestPath = value;
		} else if (token === "--data-dir" && dataDir === undefined) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			dataDir = value;
		} else return null;
	}
	return { cacheDir, apply, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH, dataDir };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-24-dedupe-list-edges.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
