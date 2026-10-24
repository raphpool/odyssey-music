/**
 * Detach the artists that are listed as aliases of an artist they are only a homonym of (TRA-562, project
 * "Intégrité du graphe"). The alias list of an artist is generated text resolved to a node by name: "The Wizard"
 * is a real nickname of Jeff Mills (his Detroit radio persona), and the resolution picked up `artist:the-wizard`,
 * the San Antonio garage band, which then got the reciprocal alias. The audit measure
 * `alias-to-uncorroborated-identity` (scripts/audit-cache.ts) finds such pairs; this migration fixes the ones
 * that were proven, and only those.
 *
 * A CLOSED LIST, not a rule: DETACHMENTS names each pair, the two MusicBrainz ids it was proven on, and the proof.
 * The audit is a heuristic (it also finds Alec Empire / LX Empire, which MusicBrainz confirms as an alias: both
 * are "is person" of Alexander Wilke), so nothing is derived from it at run time.
 *
 * What it does: removes, on each side of a listed pair, the `aliases` edge that points at the other side. Nothing
 * else changes in either node (the other aliases, the texts and every other edge stay as they are), no node is
 * deleted or renamed, and no redirect is written. The edge is removed, not re-pointed: the nickname stays in the
 * text of the artist it belongs to, where it is true.
 *
 * Safety on a cache that is not the repo's (the channel runs it on the union of the repo and the server):
 * - a pair is touched only if BOTH nodes exist and BOTH carry the mbid the proof was made on; otherwise the proof
 *   does not apply to what is on disk, so the pair is left alone and reported in `skipped`;
 * - a side that does not list the other is a no-op (idempotent: a second run writes nothing);
 * - every node to write is validated (`nodePayloadSchema`) before the first write and must not lose a field; one
 *   refusal blocks the whole run (exit 1 in a dry-run, 2 with --apply).
 *
 * Offline and deterministic: no network, no LLM. Dry-run by default; `--apply` writes.
 *
 * Channel contract (deploy/sync-genre-cache.sh --migration): `<cache-dir> --apply --manifest <path> --data-dir
 * <dir>`. `--data-dir` is accepted and ignored (no table is read). The manifest holds `removed: []`,
 * `renamed: {}` and `redirects: {}`: it never deletes or renames a node.
 *
 * Usage: tsx scripts/migrations/2026-10-24-detach-homonym-aliases.ts <cache-dir> [--apply]
 *        [--manifest out/detach-homonym-aliases.json] [--data-dir <dir>]
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../../src/cache.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import {
	type CacheNodeFile,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-24-detach-homonym-aliases";
export const DEFAULT_MANIFEST_PATH = "out/detach-homonym-aliases.json";

type Obj = Record<string, unknown>;

interface Side {
	slug: string;
	/** The MusicBrainz id the proof was made on: the pair is touched only if the node still carries it. */
	mbid: string;
}

export interface Detachment {
	a: Side;
	b: Side;
	/** Why the two are different identities, from MusicBrainz (looked up 2026-10-24) and the cache. */
	proof: string;
}

export const DETACHMENTS: readonly Detachment[] = [
	{
		a: { slug: "artist:jeff-mills", mbid: "470a4ced-1323-4c91-8fd5-0bb3fb4c932a" },
		b: { slug: "artist:the-wizard", mbid: "3193bfb8-d19f-415d-8791-d00ea71a311c" },
		proof:
			"MusicBrainz 3193bfb8: Group, US, San Antonio, 'US garage rock band from San Antonio, TX', no alias, no artist relation. " +
			"MusicBrainz 470a4ced (Jeff Mills): Person, born 1963 in Detroit; its aliases are legal-name variants and its only " +
			"'is person' relations are Millsart and True Faith, never The Wizard. The cache agrees: the-wizard is a garage-rock " +
			"group from San Antonio sharing no genre, label, release or neighbour with the Detroit techno artist.",
	},
	{
		a: { slug: "artist:basic-channel", mbid: "d145a57e-7afb-4793-8cc4-2fad292374ef" },
		b: { slug: "artist:quadrant", mbid: "7c1cc8a1-a237-40b6-ab4a-dca495a8f470" },
		proof:
			"MusicBrainz 7c1cc8a1: Group, 'drum & bass', 'is person' of Leigh Caplan, member Daniel Pollard, no relation to Basic " +
			"Channel. MusicBrainz d145a57e (Basic Channel): Group whose members are Mark Ernestus and Moritz von Oswald. The cache " +
			"agrees: artist:quadrant is a Seattle drum-and-bass project (Commercial Suicide, Citrus Recordings) while Basic " +
			"Channel is the Berlin dub-techno duo; 'Quadrant' is only the name of one Basic Channel record (Quadrant Dub).",
	},
];

export interface DetachedEdge {
	/** The node that stopped listing... */
	node: string;
	/** ...this alias. */
	alias: string;
}

export interface SkippedPair {
	pair: string;
	reason: string;
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
	detached: DetachedEdge[];
	/** Listed pairs left alone because the proof does not apply to what the cache holds. */
	skipped: SkippedPair[];
	errors: string[];
}

export interface Plan {
	/** Raw node to write, by file path. */
	writes: Map<string, Obj>;
	manifest: Manifest;
}

const pairLabel = (d: Detachment): string => `${d.a.slug} <-> ${d.b.slug}`;

/** The aliases of `node` without the edge to `target`, or null when it does not list `target`. */
function withoutAlias(node: Obj, target: string): Obj | null {
	const aliases = node.aliases;
	if (!Array.isArray(aliases)) return null;
	const kept = aliases.filter((e) => !(typeof e === "object" && e !== null && (e as Obj).slug === target));
	return kept.length === aliases.length ? null : { ...node, aliases: kept };
}

/** Pure plan: what to write and what to report. Does not touch the disk. */
export function planDetach(
	nodes: readonly CacheNodeFile[],
	detachments: readonly Detachment[] = DETACHMENTS,
): Plan {
	const bySlug = new Map(nodes.map((n) => [n.slug, n]));
	const writes = new Map<string, Obj>();
	const detached: DetachedEdge[] = [];
	const skipped: SkippedPair[] = [];
	const errors: string[] = [];

	for (const d of detachments) {
		const sides = [
			{ side: d.a, other: d.b },
			{ side: d.b, other: d.a },
		];
		const files = sides.map(({ side }) => bySlug.get(side.slug));
		const absent = sides.filter((_, i) => files[i] === undefined).map(({ side }) => side.slug);
		if (absent.length > 0) {
			skipped.push({ pair: pairLabel(d), reason: `node absent: ${absent.join(", ")}` });
			continue;
		}
		const drifted = sides
			.filter(({ side }, i) => files[i]?.node.mbid !== side.mbid)
			.map(({ side }) => side.slug);
		if (drifted.length > 0) {
			skipped.push({ pair: pairLabel(d), reason: `mbid differs from the proof: ${drifted.join(", ")}` });
			continue;
		}
		for (const [i, { other }] of sides.entries()) {
			const file = files[i] as CacheNodeFile;
			// A second pair may already have rewritten this node: build on the planned copy.
			const current = writes.get(file.path) ?? file.node;
			const next = withoutAlias(current, other.slug);
			if (next === null) continue;
			const parsed = nodePayloadSchema.safeParse(next);
			if (!parsed.success) {
				errors.push(`${file.slug}: refusing to write an invalid node: ${parsed.error.message}`);
			} else if (!onlyAddsSchemaDefaults(next, parsed.data)) {
				errors.push(`${file.slug}: refusing to write: validation would alter fields the node carries`);
			} else {
				writes.set(file.path, next);
				detached.push({ node: file.slug, alias: other.slug });
			}
		}
	}

	const byNode = (a: DetachedEdge, b: DetachedEdge): number =>
		a.node === b.node ? (a.alias < b.alias ? -1 : 1) : a.node < b.node ? -1 : 1;
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
			detached: detached.sort(byNode),
			skipped,
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
	const plan = planDetach(nodes);
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
	for (const { node, alias } of manifest.detached) lines.push(`  detached ${node} -/-> ${alias}`);
	for (const { pair, reason } of manifest.skipped) lines.push(`  skipped ${pair}: ${reason}`);
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
			"usage: 2026-10-24-detach-homonym-aliases.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
