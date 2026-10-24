/**
 * Detach one misdirected artist edge and rewrite eleven others from a redirect key to the canonical slug
 * (TRA-672, follow-up of the TRA-598 audit measure `artist-edge-to-redirect-key`). Offline and deterministic:
 * no network, no LLM, a closed list.
 *
 * Why: an edge whose slug is a key of data/slug-redirects.json is read through the redirect. Two cases:
 * 1. `artist:gerry-mulligan` discography -> `project:birth-of-the-cool`: the redirect leads to
 *    `project:birth-of-the-cool--miles-davis`, credited to Miles Davis (producer Pete Rugolo), not to Mulligan.
 *    The edge is wrong, not just old: it is DETACHED (the rest of his discography is his own scoped releases).
 * 2. Eleven edges (7 artists) whose redirect leads to a work scoped on the same artist (or on his alias
 *    Plastikman), present on prod only (TRA-484), absent from the repo cache. The read is right today; the
 *    rewrite makes the informative `artist-edge-to-redirect-key-unresolved` measure fall from 11 to 0 and
 *    stops depending on the table. On 2026-10-24 a read-only GET of prod's /data.json showed each canonical
 *    target present and credited to that artist (or Plastikman). The repo cache still holds legacy nodes for
 *    some of the same works under long slugs (heresy--1990-ambient-album-by-lustmord...): not touched here.
 *
 * Rules:
 * - An entry is written only if the edge still holds EXACTLY the expected key (`slug ===`). Anything else
 *   writes nothing and is reported in `flagged`: a key that is gone and whose canonical slug is not there
 *   either, an artist file that is missing, a key present twice, a key that is a live node of the cache (a
 *   live node wins over the redirect, so the edge is not misrouted: resolveReadSlug), a redirect table that no
 *   longer maps the key to the expected target. The manifest says why, so a human looks at it; nothing is guessed.
 * - A rewrite changes the `slug` of the edge and nothing else (name, mbid, year, releaseType stay). If the
 *   field already holds the canonical slug, the stale edge is dropped instead (`merged`): no duplicate.
 * - Idempotent, and meant to run on the union repo + prod (deploy/sync-genre-cache.sh --migration): an edge
 *   already detached or already canonical is `already-done` and writes nothing, so a second run has
 *   `written === 0`. Only the artist nodes of the list are read for writing; no other node is touched.
 * - Every node to write is validated (`nodePayloadSchema`) first and the validation must not drop a field it
 *   carries. What is written is the node as read with its edges changed, so the diff of a node is its edges and
 *   nothing else. One refusal blocks the whole run: nothing is written (exit 1 in a dry-run, 2 with --apply).
 * - Dry-run by default; `--apply` writes.
 *
 * Channel contract (deploy/sync-genre-cache.sh --migration): `<cache-dir> --apply --manifest <path>
 * --data-dir <dir>`. The redirect table is read from `--data-dir` (the channel's scratch copy), else from the
 * repo's data/. It is only read, never written: the manifest holds `removed: []`, `renamed: {}` and
 * `redirects: {}` because no node is deleted, renamed or redirected here.
 *
 * Usage: tsx scripts/migrations/2026-10-24-rewrite-artist-redirect-key-edges.ts <cache-dir> [--apply]
 *        [--manifest out/rewrite-artist-redirect-key-edges.json] [--data-dir <dir>]
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../../src/cache.js";
import { parseSlugRedirects } from "../../src/genre-registry.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import {
	type CacheNodeFile,
	defaultDataDir,
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-24-rewrite-artist-redirect-key-edges";
export const DEFAULT_MANIFEST_PATH = "out/rewrite-artist-redirect-key-edges.json";

type Obj = Record<string, unknown>;

export interface EdgeEntry {
	artist: string;
	/** The artist node field holding the edge: a list (`discography`, `notable_tracks`) or a single edge. */
	field: string;
	/** The slug the edge must still hold for the entry to apply. */
	from: string;
}

export interface RewriteEntry extends EdgeEntry {
	/** The canonical slug, which must be what data/slug-redirects.json maps `from` to. */
	to: string;
}

/** TRA-672: the edge that is wrong, not just old. */
export const DETACH: readonly EdgeEntry[] = [
	{ artist: "artist:gerry-mulligan", field: "discography", from: "project:birth-of-the-cool" },
];

/** TRA-672: the eleven edges of TRA-598's `artist-edge-to-redirect-key-unresolved`, in the audit's order. */
export const REWRITE: readonly RewriteEntry[] = [
	{
		artist: "artist:basic-channel",
		field: "discography",
		from: "project:bcd-2",
		to: "project:bcd-2--basic-channel",
	},
	{
		artist: "artist:jan-jelinek",
		field: "discography",
		from: "project:tierbeobachtungen",
		to: "project:tierbeobachtungen--jan-jelinek",
	},
	{
		artist: "artist:la-monte-young",
		field: "notable_tracks",
		from: "track:trio-for-strings",
		to: "track:trio-for-strings--la-monte-young",
	},
	{
		artist: "artist:la-monte-young",
		field: "reference_track",
		from: "track:trio-for-strings",
		to: "track:trio-for-strings--la-monte-young",
	},
	{
		artist: "artist:lustmord",
		field: "discography",
		from: "project:heresy",
		to: "project:heresy--lustmord",
	},
	{
		artist: "artist:lustmord",
		field: "landmark_project",
		from: "project:heresy",
		to: "project:heresy--lustmord",
	},
	{
		artist: "artist:manuel-gottsching",
		field: "notable_tracks",
		from: "track:e2-e4",
		to: "track:e2-e4--manuel-gottsching",
	},
	{
		artist: "artist:manuel-gottsching",
		field: "reference_track",
		from: "track:e2-e4",
		to: "track:e2-e4--manuel-gottsching",
	},
	{
		artist: "artist:richie-hawtin",
		field: "notable_tracks",
		from: "track:spastik",
		to: "track:spastik--plastikman",
	},
	{
		artist: "artist:ub40",
		field: "discography",
		from: "project:promises-and-lies",
		to: "project:promises-and-lies--ub40",
	},
	{
		artist: "artist:ub40",
		field: "discography",
		from: "project:labour-of-love",
		to: "project:labour-of-love--ub40",
	},
];

export type ActionKind = "detach" | "rewrite";
export type ActionStatus = "done" | "merged" | "already-done" | "flagged";

export interface Action {
	kind: ActionKind;
	artist: string;
	field: string;
	from: string;
	/** Rewrites only. */
	to?: string;
	status: ActionStatus;
	/** Why the entry did not apply (`flagged`) or what happened to it (`merged`). */
	reason?: string;
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
	/** Count of actions by status. */
	counts: Record<ActionStatus, number>;
	actions: Action[];
	/** The actions that did not apply and need a look (also in `actions`). */
	flagged: Action[];
	errors: string[];
}

export interface Plan {
	/** Raw node to write, by file path. */
	writes: Map<string, Obj>;
	manifest: Manifest;
}

const isEdgeObject = (value: unknown): value is Obj => isRecord(value) && typeof value.slug === "string";

/** What one entry does to one node field. `next` is only set when the field changes. */
function applyToField(
	node: Obj,
	entry: EdgeEntry,
	to: string | undefined,
): { status: ActionStatus; reason?: string; next?: unknown } {
	const value = node[entry.field];
	if (Array.isArray(value)) {
		const hits = value.filter((e) => isEdgeObject(e) && e.slug === entry.from).length;
		if (hits > 1) return { status: "flagged", reason: `${entry.from} is in ${entry.field} ${hits} times` };
		const hasCanonical = to !== undefined && value.some((e) => isEdgeObject(e) && e.slug === to);
		if (hits === 0) {
			if (to === undefined || hasCanonical) return { status: "already-done" };
			return { status: "flagged", reason: `${entry.from} is not in ${entry.field}, nor is ${to}` };
		}
		if (to === undefined) {
			return { status: "done", next: value.filter((e) => !(isEdgeObject(e) && e.slug === entry.from)) };
		}
		if (hasCanonical) {
			return {
				status: "merged",
				reason: `${to} was already in ${entry.field}`,
				next: value.filter((e) => !(isEdgeObject(e) && e.slug === entry.from)),
			};
		}
		return {
			status: "done",
			next: value.map((e) => (isEdgeObject(e) && e.slug === entry.from ? { ...e, slug: to } : e)),
		};
	}
	if (isEdgeObject(value)) {
		if (to === undefined)
			return { status: "flagged", reason: `${entry.field} is a single edge: it is not detached here` };
		if (value.slug === entry.from) return { status: "done", next: { ...value, slug: to } };
		if (value.slug === to) return { status: "already-done" };
		return {
			status: "flagged",
			reason: `${entry.field} holds ${String(value.slug)}, not ${entry.from} nor ${to}`,
		};
	}
	if (to === undefined) return { status: "already-done" };
	return { status: "flagged", reason: `${entry.field} holds no edge (${entry.from} expected)` };
}

/** Pure plan: what to write and what to report. Does not touch the disk. */
export function planFix(nodes: readonly CacheNodeFile[], redirects: ReadonlyMap<string, string>): Plan {
	const bySlug = new Map(nodes.map((n) => [n.slug, n]));
	const slugByPath = new Map(nodes.map((n) => [n.path, n.slug]));
	const staged = new Map<string, Obj>();
	const changedFields = new Map<string, string[]>();
	const actions: Action[] = [];
	const errors: string[] = [];

	const steps: { kind: ActionKind; entry: EdgeEntry; to: string | undefined }[] = [
		...DETACH.map((entry) => ({ kind: "detach" as const, entry, to: undefined })),
		...REWRITE.map((entry) => ({ kind: "rewrite" as const, entry, to: entry.to })),
	];
	for (const { kind, entry, to } of steps) {
		const base = { kind, artist: entry.artist, field: entry.field, from: entry.from, ...(to ? { to } : {}) };
		const file = bySlug.get(entry.artist);
		if (!file) {
			actions.push({ ...base, status: "flagged", reason: `${entry.artist} is not in the cache` });
			continue;
		}
		if (bySlug.has(entry.from)) {
			actions.push({
				...base,
				status: "flagged",
				reason: `${entry.from} is a live node: the edge is not read through the redirect`,
			});
			continue;
		}
		if (to !== undefined && redirects.get(entry.from) !== to) {
			actions.push({
				...base,
				status: "flagged",
				reason: `slug-redirects.json maps ${entry.from} to ${redirects.get(entry.from) ?? "nothing"}, not ${to}`,
			});
			continue;
		}
		const current = staged.get(file.path) ?? file.node;
		const result = applyToField(current, entry, to);
		actions.push({ ...base, status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
		if (result.next !== undefined) {
			staged.set(file.path, { ...current, [entry.field]: result.next });
			changedFields.set(file.path, [...(changedFields.get(file.path) ?? []), entry.field]);
		}
	}

	const writes = new Map<string, Obj>();
	for (const [path, next] of staged) {
		const slug = slugByPath.get(path) ?? path;
		const fields = (changedFields.get(path) ?? []).join(", ");
		const parsed = nodePayloadSchema.safeParse(next);
		if (!parsed.success) {
			errors.push(`${slug}: refusing to write an invalid node (${fields}): ${parsed.error.message}`);
		} else if (!onlyAddsSchemaDefaults(next, parsed.data)) {
			errors.push(`${slug}: refusing to write: validation would alter fields the node carries`);
		} else {
			// The node as read, edges apart: the parsed copy would also add the empty lists a node lacks.
			writes.set(path, next);
		}
	}

	const counts: Record<ActionStatus, number> = { done: 0, merged: 0, "already-done": 0, flagged: 0 };
	for (const a of actions) counts[a.status]++;
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
			counts,
			actions,
			flagged: actions.filter((a) => a.status === "flagged"),
			errors,
		},
	};
}

/** The slug table the pairs are checked against: the channel's scratch copy, else the repo's. */
async function readRedirects(dataDir: string | undefined): Promise<ReadonlyMap<string, string>> {
	const path = join(dataDir ?? defaultDataDir(), "slug-redirects.json");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`redirect table not found: ${path}`);
		throw e;
	}
	return parseSlugRedirects(JSON.parse(text) as unknown);
}

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	dataDir?: string | undefined;
}

export async function runMigration(options: RunOptions): Promise<{ manifest: Manifest; exitCode: number }> {
	const redirects = await readRedirects(options.dataDir);
	const { nodes, invalid } = await readCacheNodes(options.cacheDir);
	warnSkippedNodeFiles(invalid);
	const plan = planFix(nodes, redirects);
	const manifest = plan.manifest;
	// An unreadable file is only warned about: if it is an artist of the list, planFix flags it as missing.
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
	for (const [status, count] of Object.entries(manifest.counts))
		lines.push(`  ${status.padEnd(32)} ${count}`);
	for (const a of manifest.flagged) {
		lines.push(`flagged: ${a.artist} ${a.field} ${a.from}: ${a.reason ?? ""}`);
	}
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
			"usage: 2026-10-24-rewrite-artist-redirect-key-edges.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
