/**
 * Replace the literal `\n` (backslash + "n") of the generated texts by real line breaks (TRA-492, plan
 * docs/plans/graph-integrity.md, part 6.2). Gemini double-escapes newlines in its JSON, so ~760 articles and 8
 * bios were cached with the escape as text; the web prints it as-is (`white-space: pre-wrap`). TRA-458 fixes
 * the new writes with `normalizeEditorialText`; this migration applies that same function to the cache that
 * already exists. Offline and deterministic: no network, no LLM.
 *
 * Which fields: `editorial_article`, the teaser of the type (TEASER_FIELD_BY_TYPE) and the text facts of
 * OPTIONAL_TEXT_FIELDS[type], minus the `*_url` ones. Never a slug, an edge, a citation or a URL: a URL is not
 * prose (it is an untrusted third-party value that is validated, not rewritten) and the escape is not in it.
 *
 * Rules:
 * - A field is rewritten only if it holds a literal escape that is converted. A field with nothing but
 *   trailing spaces or a triple line break is left alone: that is another normalization (out of scope of
 *   the ticket), and it would turn a ~760 node migration into an ~840 node one for no gain on the
 *   `literal-newlines` audit.
 * - A rewritten field goes through `normalizeEditorialText` whole, so it ends exactly as a new write would.
 * - Not every `\n` is an escape. Two kinds of text are kept verbatim, because they are content and not the
 *   model's double escape: (1) a `\n` whose backslash is itself escaped (`\\n`, an even run of backslashes:
 *   a backslash followed by the letter n, as in a Windows path or a printf format), (2) a `\n` inside a
 *   fenced code block. Inline code spans are NOT shielded: the broken articles hold no real line break, so
 *   two stray backticks (an apostrophe) would pair up across paragraphs and shield every escape between
 *   them. No node of the cache of 2026-10-16 has a kept `\n` or even a backtick (measured), so this is a
 *   net, not a feature: a kept `\n` is counted in `kept` and the audit keeps flagging the node, on purpose,
 *   for a human. (TRA-458's function converts them all; it does not know about code, so the pipeline would.)
 * - Only the fields above are read. A literal `\n` in any other top-level string of a node (the audit looks
 *   at all of them) is not touched and is listed in `uncovered`, so a gap between this migration and the
 *   `literal-newlines` audit is explained by the manifest, not found later.
 * - Dry-run by default; `--apply` writes. Idempotent: a second run writes nothing (`written === 0`).
 * - Every node to write is validated (`nodePayloadSchema`) before the first write, and the validation must
 *   not drop a field the node carries. The validated copy only gates the write: what is written is the node
 *   as read with its text fields changed, so the diff of a node is its text and nothing else. One refusal (a
 *   node that would no longer pass the schema, such as an article that falls under its `minLength` of 80
 *   once trimmed, or an unreadable file) blocks the whole run: it is listed in `errors` and nothing is
 *   written (exit 1 in a dry-run, 2 with --apply).
 *
 * Channel contract (deploy/sync-genre-cache.sh --migration): `<cache-dir> --apply --manifest <path>
 * --data-dir <dir>`. `--data-dir` is accepted and ignored (this migration reads no table). The manifest holds
 * `migration`, `removed: []`, `renamed: {}` and `redirects: {}`: it never deletes or renames a node.
 *
 * Usage: tsx scripts/migrations/2026-10-15-unescape-newlines.ts <cache-dir> [--apply]
 *        [--manifest out/unescape-newlines.json] [--data-dir <dir>]
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../../src/cache.js";
import { normalizeEditorialText } from "../../src/editorial-text.js";
import { type NodeType, OPTIONAL_TEXT_FIELDS, TEASER_FIELD_BY_TYPE } from "../../src/node-spec.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import {
	type CacheNodeFile,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-15-unescape-newlines";
export const DEFAULT_MANIFEST_PATH = "out/unescape-newlines.json";

type Obj = Record<string, unknown>;

/** The generated text fields of a node type: the article, the teaser and the text facts, never a URL. */
export function textFieldsOf(type: NodeType): string[] {
	const fields = ["editorial_article", TEASER_FIELD_BY_TYPE[type], ...OPTIONAL_TEXT_FIELDS[type]];
	return fields.filter((f) => !f.endsWith("_url"));
}

/** A fenced code block. Not the inline span: see the header. */
const CODE_FENCE = /```[\s\S]*?```/g;

/** A private-use character absent from the text, to stand in for the backslashes that must survive. */
function freeSentinel(text: string): string {
	for (let code = 0xe000; code <= 0xf8ff; code++) {
		const c = String.fromCharCode(code);
		if (!text.includes(c)) return c;
	}
	throw new Error("a text holds every private-use character of the BMP: cannot shield its backslashes");
}

/**
 * `text` as a new write would have it, except that a `\n` which is content stays: see the header. `kept`
 * counts the runs of backslashes left before an n; `converted` tells whether at least one escape was read
 * as one. The sentinel replaces the backslash that must not be read as an escape, then goes back.
 */
export function unescapeEditorialText(text: string): { text: string; kept: number; converted: boolean } {
	const sentinel = freeSentinel(text);
	let kept = 0;
	const shield = (block: string): string => {
		kept += (block.match(/\\+(?=n)/g) ?? []).length;
		return block.replace(/\\(?=n|r\\n)/g, sentinel);
	};
	// Code first (its backslashes are all content), then a run of backslashes before n (or r\n): an even run
	// is pairs of escaped backslashes, so the letter is a letter; an odd run ends on a real escape.
	const shielded = text
		.replace(CODE_FENCE, shield)
		.replace(/\\+(?=n|r\\n)/g, (run, offset: number, whole: string) => {
			if (run.length % 2 === 1) return run;
			if (whole[offset + run.length] === "n") kept++;
			return `${run.slice(0, -1)}${sentinel}`;
		});
	return {
		text: normalizeEditorialText(shielded).replaceAll(sentinel, "\\"),
		kept,
		converted: shielded.includes("\\n"),
	};
}

export interface ChangedNode {
	slug: string;
	fields: string[];
}

const bySlug = (a: ChangedNode, b: ChangedNode): number => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

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
	/** Literal `\n` left as they are because they are content (escaped backslash, code); the audit still sees them. */
	kept: number;
	/** The nodes to write and the fields that change, by slug. */
	changed: ChangedNode[];
	/** Nodes with a literal `\\n` in a top-level string this migration does not read (listed, never touched). */
	uncovered: ChangedNode[];
	errors: string[];
}

export interface Plan {
	/** Raw node to write, by file path. */
	writes: Map<string, Obj>;
	manifest: Manifest;
}

/** Pure plan: what to write and what to report. Does not touch the disk. */
export function planUnescape(nodes: readonly CacheNodeFile[]): Plan {
	const writes = new Map<string, Obj>();
	const byField: Record<string, number> = {};
	const changed: ChangedNode[] = [];
	const uncovered: ChangedNode[] = [];
	const errors: string[] = [];
	let kept = 0;

	for (const { path, slug, type, node } of nodes) {
		const next: Obj = { ...node };
		const fields: string[] = [];
		for (const field of textFieldsOf(type)) {
			const value = node[field];
			if (typeof value !== "string" || !value.includes("\\n")) continue;
			const fixed = unescapeEditorialText(value);
			kept += fixed.kept;
			if (!fixed.converted) continue;
			next[field] = fixed.text;
			fields.push(field);
		}
		const covered = new Set(textFieldsOf(type));
		const gap = Object.entries(node)
			.filter(([k, v]) => !covered.has(k) && typeof v === "string" && v.includes("\\n"))
			.map(([k]) => k);
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
			kept,
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
	const plan = planUnescape(nodes);
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
	lines.push(`  ${"literal \\n kept (content)".padEnd(32)} ${manifest.kept}`);
	lines.push(`  ${"nodes with a \\n in another field".padEnd(32)} ${manifest.uncovered.length}`);
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
			"usage: 2026-10-15-unescape-newlines.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
