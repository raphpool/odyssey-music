/**
 * Replace the literal `\"` (backslash + quote) of the generated texts by a plain quote (TRA-577, plan
 * docs/plans/graph-integrity.md, part 6). The double escaping of Gemini that left `\n` in ~760 articles
 * (TRA-492, `2026-10-15-unescape-newlines`) also hit quotation marks: 19 articles print `\"Seaqz\"`. Neither
 * that migration nor the `literal-newlines` audit sees it. The new writes are fixed by
 * `normalizeEditorialText` (`unescapeQuotes` in src/editorial-text.ts); this migration applies the same
 * function to the cache that already exists. Offline and deterministic: no network, no LLM.
 *
 * Which fields: the same as the `\n` migration (`textFieldsOf`): `editorial_article`, the teaser of the type
 * and the text facts, minus the `*_url` ones. Never a slug, an edge, a citation or a URL.
 *
 * Rules:
 * - The transform is `unescapeQuotes` and nothing else: the escaping backslash goes, the rest of the field is
 *   byte for byte the same. In particular a `\n` still in the field stays (it is `2026-10-15-unescape-newlines`'s
 *   business), and no trimming or blank-line collapsing happens. That is what lets a throwaway script prove
 *   that a node changed by `\"` -> `"` and by nothing else.
 * - Content is kept, as for `\n`: a quote after an escaped backslash (an even run) and a quote inside a fenced
 *   code block are not escapes. The audit (`literal-escaped-quotes`) asks the same function, so it does not
 *   flag them either.
 * - Only the fields above are read. A literal `\"` anywhere else in a node (another top-level string, an edge
 *   name, the title of a citation) is not touched and is listed in `uncovered` with its path, so the gap
 *   between this migration and the 21 files that hold a `\"` is explained by the manifest. 2026-10-24: two
 *   citation titles (`project:new-heaven--inter-arma`, `track:jack-your-body--steve-silk-hurley`) are in that
 *   case; a title is a third-party value that is validated, not rewritten, so it is a ticket of its own.
 * - Dry-run by default; `--apply` writes. Idempotent: a second run writes nothing (`written === 0`).
 * - Every node to write is validated (`nodePayloadSchema`) before the first write, and the validation must
 *   not drop a field the node carries. What is written is the node as read with its text fields changed (the
 *   validated copy only gates the write). One refusal blocks the whole run: it is listed in `errors` and
 *   nothing is written (exit 1 in a dry-run, 2 with --apply).
 *
 * Channel contract (deploy/sync-genre-cache.sh --migration): `<cache-dir> --apply --manifest <path>
 * --data-dir <dir>`. `--data-dir` is accepted and ignored (this migration reads no table). The manifest holds
 * `migration`, `removed: []`, `renamed: {}` and `redirects: {}`: it never deletes or renames a node.
 *
 * Usage: tsx scripts/migrations/2026-10-24-unescape-quotes.ts <cache-dir> [--apply]
 *        [--manifest out/unescape-quotes.json] [--data-dir <dir>]
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../../src/cache.js";
import { unescapeQuotes } from "../../src/editorial-text.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import {
	type CacheNodeFile,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";
import { type ChangedNode, textFieldsOf } from "./2026-10-15-unescape-newlines.js";

export const MIGRATION_NAME = "2026-10-24-unescape-quotes";
export const DEFAULT_MANIFEST_PATH = "out/unescape-quotes.json";

type Obj = Record<string, unknown>;

const bySlug = (a: ChangedNode, b: ChangedNode): number => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** The paths (`citations[].title`) of the strings under `value` that `unescapeQuotes` would change. */
function escapedQuotePaths(value: unknown, path: string): string[] {
	if (typeof value === "string") return unescapeQuotes(value) !== value ? [path] : [];
	if (Array.isArray(value)) return [...new Set(value.flatMap((v) => escapedQuotePaths(v, `${path}[]`)))];
	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([k, v]) => escapedQuotePaths(v, `${path}.${k}`));
	}
	return [];
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
	/** Fields rewritten, by field name. */
	byField: Record<string, number>;
	/** The nodes to write and the fields that change, by slug. */
	changed: ChangedNode[];
	/** Nodes with a `\"` in a place this migration does not read, by path (listed, never touched). */
	uncovered: ChangedNode[];
	errors: string[];
}

export interface Plan {
	/** Raw node to write, by file path. */
	writes: Map<string, Obj>;
	manifest: Manifest;
}

/** Pure plan: what to write and what to report. Does not touch the disk. */
export function planUnescapeQuotes(nodes: readonly CacheNodeFile[]): Plan {
	const writes = new Map<string, Obj>();
	const byField: Record<string, number> = {};
	const changed: ChangedNode[] = [];
	const uncovered: ChangedNode[] = [];
	const errors: string[] = [];

	for (const { path, slug, type, node } of nodes) {
		const covered = new Set(textFieldsOf(type));
		const next: Obj = { ...node };
		const fields: string[] = [];
		for (const field of covered) {
			const value = node[field];
			if (typeof value !== "string") continue;
			const fixed = unescapeQuotes(value);
			if (fixed === value) continue;
			next[field] = fixed;
			fields.push(field);
		}
		const gap = Object.entries(node)
			.filter(([k]) => !covered.has(k))
			.flatMap(([k, v]) => escapedQuotePaths(v, k));
		if (gap.length > 0) uncovered.push({ slug, fields: gap });
		if (fields.length === 0) continue;

		const parsed = nodePayloadSchema.safeParse(next);
		if (!parsed.success) {
			errors.push(
				`${slug}: refusing to write an invalid node (${fields.join(", ")}): ${parsed.error.message}`,
			);
		} else if (!onlyAddsSchemaDefaults(next, parsed.data)) {
			errors.push(`${slug}: refusing to write: validation would alter fields the node carries`);
		} else {
			// The node as read, text fields apart: the parsed copy would also add the empty lists a node lacks
			// (members, similar_artists...), a change nobody asked this migration for.
			writes.set(path, next);
			changed.push({ slug, fields });
			for (const f of fields) byField[f] = (byField[f] ?? 0) + 1;
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
			byField: Object.fromEntries(Object.entries(byField).sort(([a], [b]) => (a < b ? -1 : 1))),
			changed: changed.sort(bySlug),
			uncovered: uncovered.sort(bySlug),
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
	const plan = planUnescapeQuotes(nodes);
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
	for (const [field, count] of Object.entries(manifest.byField)) {
		lines.push(`  ${field.padEnd(32)} ${count}`);
	}
	lines.push(`  ${'nodes with a \\" elsewhere'.padEnd(32)} ${manifest.uncovered.length}`);
	for (const entry of manifest.uncovered) lines.push(`    ${entry.slug}: ${entry.fields.join(", ")}`);
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
			"usage: 2026-10-24-unescape-quotes.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
