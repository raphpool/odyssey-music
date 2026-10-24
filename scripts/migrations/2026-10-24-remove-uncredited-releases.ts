/**
 * Remove the projects and tracks that no credit can be proven for (TRA-485, plan docs/plans/graph-integrity.md,
 * part 1, decision 2). The schema lock of the second PR (`artists` non-empty) cannot be deployed while a work
 * with `artists: []` is on disk, in the repo or in production. 2026-10-24-credit-uncredited-releases.ts credits the
 * ones MusicBrainz proves; this removes the ones it does not, from a closed list
 * (2026-10-24-remove-uncredited-releases.slugs.json, each entry with the reason it is on it).
 *
 * A work is removed only when the cache agrees with the list: it is a project / track and it STILL has
 * `artists: []`. A work credited in the meantime (re-materialized on the server, credited by the other migration)
 * is refused and kept, which is what makes the channel run on the union safe. A work already gone is reported as
 * such. Every edge that points at a removed work is dropped from every other node (singular fields cleared), and
 * so is every pending-reverses.json entry that would write one back; the node file is deleted last. Nothing is
 * redirected: there is no replacement work.
 *
 * Every node to write is validated (nodePayloadSchema) before the first write; one error blocks the run (exit 1,
 * 2 with --apply). Dry-run by default. The manifest has no timestamp (the channel compares previews) and carries
 * the channel's fields: `removed` lists `nodes/<type>/<slug>.json`, which production deletes with an individual
 * `rm -f`, `renamed` and `redirects` are empty.
 *
 * Migration channel (deploy/sync-genre-cache.sh): `<cache-dir> --apply --manifest <p> --data-dir <d>`; the data dir
 * is accepted and unused (no redirect is read or written).
 *
 * Usage: tsx scripts/migrations/2026-10-24-remove-uncredited-releases.ts <cache-dir> [--apply]
 *        [--manifest out/remove-uncredited-releases.json] [--data-dir <dir>]
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { isValidSlug, parseSlug } from "../../src/slug.js";
import {
	looksLikeCacheDir,
	readCacheNodes,
	readTextOrDefault,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { dropEdgesToSlug, dropPendingReversesForSlug } from "./2026-09-18-remove-track-incubus.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-24-remove-uncredited-releases";
export const DEFAULT_MANIFEST_PATH = "out/remove-uncredited-releases.json";
export const SLUGS_PATH = join(dirname(fileURLToPath(import.meta.url)), `${MIGRATION_NAME}.slugs.json`);

type Obj = Record<string, unknown>;
type CacheNode = Awaited<ReturnType<typeof readCacheNodes>>["nodes"][number];
type PendingFile = Record<string, PendingReverse[]>;

const slugsSchema = z.object({
	source: z.string(),
	slugs: z.array(
		z.object({
			slug: z.string().refine((s) => /^(project|track):/.test(s) && isValidSlug(s), "not a work slug"),
			reason: z.string().min(1),
		}),
	),
});
export type RemovalList = z.infer<typeof slugsSchema>;

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

export interface Manifest {
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	mode: "dry-run" | "apply";
	/** Slugs removed, with the reason of the list. */
	works: { slug: string; reason: string; edgesDropped: number }[];
	alreadyRemoved: string[];
	refused: { slug: string; reason: string }[];
	written: number;
	pendingDropped: number;
	errors: string[];
	blocked: boolean;
}

const pathOf = (slug: string) => {
	const { type, body } = parseSlug(slug);
	return `nodes/${type}/${body}.json`;
};

export function planRemoval(
	nodes: readonly CacheNode[],
	pending: PendingFile,
	list: RemovalList,
): { writes: Map<string, Obj>; deletes: string[]; pending: PendingFile | null; manifest: Manifest } {
	const manifest: Manifest = {
		migration: MIGRATION_NAME,
		removed: [],
		renamed: {},
		redirects: {},
		mode: "dry-run",
		works: [],
		alreadyRemoved: [],
		refused: [],
		written: 0,
		pendingDropped: 0,
		errors: [],
		blocked: false,
	};
	const bySlug = new Map(nodes.map((n) => [n.slug, n]));
	const doomed = new Map<string, string>();
	for (const { slug, reason } of list.slugs) {
		const file = bySlug.get(slug);
		if (!file) manifest.alreadyRemoved.push(slug);
		else if (file.node.slug !== slug || file.node.type !== parseSlug(slug).type)
			manifest.refused.push({ slug, reason: "its own slug / type fields disagree with its path" });
		else if (!Array.isArray(file.node.artists) || file.node.artists.length > 0)
			manifest.refused.push({ slug, reason: "it has a credit now" });
		else doomed.set(slug, reason);
	}

	const edgeCounts = new Map<string, number>([...doomed.keys()].map((s) => [s, 0]));
	const writes = new Map<string, Obj>();
	for (const file of nodes) {
		if (doomed.has(file.slug)) continue;
		let node: Obj = file.node;
		let changed = false;
		for (const slug of doomed.keys()) {
			const { node: next, hits } = dropEdgesToSlug(node, file.type, slug);
			if (hits === 0) continue;
			node = next;
			changed = true;
			edgeCounts.set(slug, (edgeCounts.get(slug) ?? 0) + hits);
		}
		if (!changed) continue;
		const parsed = nodePayloadSchema.safeParse(node);
		if (!parsed.success)
			manifest.errors.push(`${file.slug}: invalid after the removal: ${parsed.error.message}`);
		else if (!onlyAddsSchemaDefaults(node, parsed.data))
			manifest.errors.push(`${file.slug}: validation would alter fields the node carries`);
		else writes.set(file.path, parsed.data as unknown as Obj);
	}

	let nextPending = pending;
	for (const slug of doomed.keys()) {
		const { result, changed } = dropPendingReversesForSlug(nextPending, slug);
		if (changed) manifest.pendingDropped += 1;
		nextPending = result;
	}
	for (const [slug, reason] of [...doomed].sort(([a], [b]) => (a < b ? -1 : 1))) {
		manifest.works.push({ slug, reason, edgesDropped: edgeCounts.get(slug) ?? 0 });
		manifest.removed.push(pathOf(slug));
	}
	manifest.written = writes.size;
	manifest.blocked = manifest.errors.length > 0;
	const deletes = [...doomed.keys()].map((s) => (bySlug.get(s) as CacheNode).path);
	return { writes, deletes, pending: manifest.pendingDropped > 0 ? nextPending : null, manifest };
}

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	/** The closed list; the committed one by default. */
	list?: RemovalList;
}

export async function runMigration(options: RunOptions): Promise<{ manifest: Manifest; exitCode: number }> {
	const { cacheDir, apply } = options;
	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	const errors = invalid.map((i) => `unreadable node file ${i.path}: ${i.error}`);
	const pendingPath = join(cacheDir, "pending-reverses.json");
	let pending: PendingFile = {};
	try {
		const parsed = pendingFileSchema.safeParse(JSON.parse(await readTextOrDefault(pendingPath, "{}")));
		if (parsed.success) pending = parsed.data as PendingFile;
		else errors.push(`pending-reverses.json is invalid: ${parsed.error.message}`);
	} catch (e) {
		errors.push(`pending-reverses.json is unreadable: ${e instanceof Error ? e.message : String(e)}`);
	}
	let list = options.list;
	if (!list) {
		try {
			list = slugsSchema.parse(JSON.parse(await readFile(SLUGS_PATH, "utf8")));
		} catch (e) {
			errors.push(`removal list unreadable: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	const plan = planRemoval(nodes, pending, list ?? { source: "", slugs: [] });
	const manifest = plan.manifest;
	manifest.errors.push(...errors);
	manifest.blocked = manifest.errors.length > 0;
	if (apply) manifest.mode = "apply";
	if (apply && !manifest.blocked) {
		// Crash-safe order: every edge to a work is gone before the work is.
		for (const [path, node] of plan.writes) await atomicWriteJson(path, node);
		if (plan.pending) await atomicWriteJson(pendingPath, plan.pending);
		for (const path of plan.deletes) await rm(path);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: manifest.blocked ? (apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	for (const w of manifest.works)
		lines.push(`  remove ${w.slug} (${w.edgesDropped} edge(s) dropped): ${w.reason}`);
	for (const slug of manifest.alreadyRemoved) lines.push(`  already removed ${slug}`);
	for (const r of manifest.refused) lines.push(`  refused ${r.slug}: ${r.reason}`);
	lines.push(
		`  node files rewritten ${manifest.written}, pending entries dropped ${manifest.pendingDropped}`,
	);
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

/** `<cache-dir> [--apply] [--manifest p] [--data-dir d]` (the data dir is the channel's, ignored); null (exit 2) otherwise. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	const values: Record<string, string> = {};
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i] as string;
		if (token === "--apply" && !apply) apply = true;
		else if ((token === "--manifest" || token === "--data-dir") && !(token in values)) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			values[token] = value;
		} else return null;
	}
	return { cacheDir, apply, manifestPath: values["--manifest"] ?? DEFAULT_MANIFEST_PATH };
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
