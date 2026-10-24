/**
 * Fix the weak flagship album / reference track choices that survive the v3 backfill (TRA-605, plan
 * docs/plans/graph-integrity.md, part 5). The backfill (2026-10-19-backfill-landmark-highlights, rule v3)
 * wrote 971 choices; an exhaustive sweep of 2026-10-17 found 6 bad ones (0.6 %), all on artists whose cached
 * discography is poor, and the preview of the production run added two more (lil-wayne, tyla). A choice, once
 * written, is final (the backfill never revisits an artist that has the field), hence this targeted fix.
 *
 * CLOSED LIST (CLOSED_LIST below): eight (artist, field) pairs, each with the pick it is expected to hold. For
 * each, the migration either
 *   - clears the field (`clear`): no PROVEN better choice exists, and an empty field is honest (the audit counts
 *     it, the pipeline fills it on the next regeneration of the card); or
 *   - replaces it (`replace`) with an entry of the artist's OWN list that is proven: cited in the artist's
 *     `editorial_article`, or the most voted album of the artist on MusicBrainz, under the v2/v3 rules of
 *     TRA-601 (album before single, no compilation, no DJ mix, no title named after an artist that cannot be
 *     verified). The edge is copied as is from the list, never invented: the pipeline requires a pick to be a
 *     member of its list compared by slug (enforceArtistChoices, TRA-470).
 * The evidence of every entry is in its `evidence` line; the PR carries the same table.
 *
 * Rules:
 * - A pair is touched only when the artist exists, holds the field, and the slug of the pick is the EXPECTED
 *   one. Anything else is left alone and listed in `skipped` with its reason (`absent`, `already-empty`,
 *   `pick-changed`): a pick the pipeline or a human rewrote since is not ours to undo, and a second run
 *   finds nothing to do (idempotence). `absent` is normal in the repository for lil-wayne and tyla, which
 *   only exist in production: the migration runs on the channel's union (repository + server snapshot).
 * - A `replace` whose replacement is not in the artist's list at run time falls back to `clear`
 *   (`replacementMissing`): never a pick that is in no list, and always a state the schema allows.
 * - Nothing else on the node changes: the other fields, the other pick, the order of the keys. The node
 *   as read is written back with that one key removed or replaced, after `nodePayloadSchema` validated the
 *   result without dropping a field it carries. One refusal (unreadable file, invalid result) blocks the
 *   whole run: nothing is written (exit 1 in a dry-run, 2 with --apply).
 * - Dry-run by default; the manifest of a dry-run and of the apply that follows are identical but for
 *   `generated_at` and `mode`.
 *
 * Offline and deterministic: no network, no LLM. Reads only the eight node files of the list, by path.
 *
 * Channel contract (deploy/sync-genre-cache.sh --migration): `<cache-dir> --apply --manifest <path>
 * --data-dir <dir>`. `--data-dir` is accepted and ignored (this migration reads no table). The manifest holds
 * `migration`, `removed: []`, `renamed: {}` and `redirects: {}`: it never deletes or renames a node.
 *
 * Usage: tsx scripts/migrations/2026-10-24-fix-weak-landmarks.ts <cache-dir> [--apply]
 *        [--manifest out/fix-weak-landmarks.json] [--data-dir <dir>]
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../../src/cache.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { parseSlug } from "../../src/slug.js";
import { isRecord, looksLikeCacheDir } from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-24-fix-weak-landmarks";
export const DEFAULT_MANIFEST_PATH = "out/fix-weak-landmarks.json";

export type Field = "landmark_project" | "reference_track";
type Obj = Record<string, unknown>;

/** The list each pick must come from (enforceArtistChoices, src/pipeline.ts). */
const LIST_OF: Record<Field, "discography" | "notable_tracks"> = {
	landmark_project: "discography",
	reference_track: "notable_tracks",
};

export interface Decision {
	artist: string;
	field: Field;
	/** Slug of the pick the migration is written against; any other pick is left alone. */
	expected: string;
	action: "clear" | "replace";
	/** `replace` only: slug of the entry of the artist's own list that becomes the pick. */
	with?: string;
	/** Why, in one line: the proof of the replacement, or why no choice is proven. */
	evidence: string;
}

/** The closed list. Exported so that the test pins it: adding a pair is a reviewed change. */
export const CLOSED_LIST: readonly Decision[] = [
	{
		artist: "artist:headhunterz",
		field: "landmark_project",
		expected: "project:live-forever",
		action: "clear",
		evidence:
			"Live Forever is a 2024 single. The article cites no album of the cached discography (it quotes Project One, absent from it), and no album of the artist has a vote on MusicBrainz.",
	},
	{
		artist: "artist:caspa",
		field: "landmark_project",
		expected: "project:fabriclive-37--caspa",
		action: "replace",
		with: "project:everybody-s-talking-nobody-s-listening",
		evidence:
			"Fabriclive.37 is a DJ mix (MusicBrainz: Album+Compilation+DJ-mix). The article names the 2009 debut album 'Everybody's Talking, Nobody's Listening' as a major milestone; the edge carries the MusicBrainz id of that studio album.",
	},
	{
		artist: "artist:rusko",
		field: "landmark_project",
		expected: "project:fabriclive-37--caspa",
		action: "clear",
		evidence:
			"Caspa's DJ mix, shared with Rusko. The article cites only that mix, the one MusicBrainz vote on the artist is on it (DJ mix, excluded), and no studio album of the list is cited.",
	},
	{
		artist: "artist:dougal",
		field: "reference_track",
		expected: "track:dj-dougal-takes-control",
		action: "clear",
		evidence:
			"The pick is the 1996 album 'DJ Dougal Takes Control' filed as a track; it is the only entry of notable_tracks and the article cites no track.",
	},
	{
		artist: "artist:stuart-sutcliffe",
		field: "landmark_project",
		expected: "project:live-at-the-star-club-in-hamburg-germany-1962",
		action: "clear",
		evidence:
			"A Beatles live recording of December 1962, after his death in April 1962; the other entry is the non-canonical 'Anthology 1'. The article cites no work of his.",
	},
	{
		artist: "artist:beppe-loda",
		field: "landmark_project",
		expected: "project:obscure-italian-disco-ii-beppe-loda-cuts",
		action: "clear",
		evidence:
			"A compilation of his selection. The article cites only DJ-mix compilations absent from the list, and the remaining entries are a remix album and a compilation.",
	},
	{
		artist: "artist:lil-wayne",
		field: "reference_track",
		expected: "track:tha-carter-iii",
		action: "clear",
		evidence:
			"Tha Carter III is an album filed as a track. Every entry of notable_tracks is an album (Tha Carter III to V, Funeral): there is no track to choose.",
	},
	{
		artist: "artist:tyla",
		field: "landmark_project",
		expected: "project:jackboys-2",
		action: "clear",
		evidence:
			"JackBoys 2 is Travis Scott's compilation, where she is a guest. The article's self-titled debut album (project:tyla) is a title named after the artist whose target is not in the cache: rule v3 of TRA-601 cannot verify it, so it is not proven.",
	},
];

export type SkipReason = "absent" | "already-empty" | "pick-changed";

export interface Change {
	slug: string;
	field: Field;
	action: "cleared" | "replaced";
	from: string;
	/** Slug of the new pick; null when the field was cleared. */
	to: string | null;
	/** `replace` that fell back to `clear` because the replacement is not in the artist's list. */
	replacementMissing: boolean;
}

export interface Skipped {
	slug: string;
	field: Field;
	reason: SkipReason;
	/** `pick-changed`: the pick the node holds instead of the expected one. */
	found?: string;
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
	changed: Change[];
	skipped: Skipped[];
	errors: string[];
}

const slugOf = (edge: unknown): string | undefined => (isRecord(edge) ? asString(edge.slug) : undefined);
const asString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The node after the decision, or null when there is nothing to do; `skipped` says why. */
export function applyDecision(
	node: Obj,
	decision: Decision,
): { next: Obj; change: Change } | { next: null; skipped: Skipped } {
	const { artist: slug, field, expected } = decision;
	const found = slugOf(node[field]);
	if (node[field] === undefined) return { next: null, skipped: { slug, field, reason: "already-empty" } };
	if (found !== expected) {
		return {
			next: null,
			skipped: { slug, field, reason: "pick-changed", ...(found === undefined ? {} : { found }) },
		};
	}
	const next: Obj = { ...node };
	const list = node[LIST_OF[field]];
	const replacement =
		decision.action === "replace" && Array.isArray(list)
			? list.find((e) => isRecord(e) && slugOf(e) === decision.with)
			: undefined;
	if (isRecord(replacement)) {
		next[field] = { ...replacement };
		return {
			next,
			change: {
				slug,
				field,
				action: "replaced",
				from: expected,
				to: decision.with ?? null,
				replacementMissing: false,
			},
		};
	}
	delete next[field];
	return {
		next,
		change: {
			slug,
			field,
			action: "cleared",
			from: expected,
			to: null,
			replacementMissing: decision.action === "replace",
		},
	};
}

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
}

async function readNode(
	cacheDir: string,
	slug: string,
): Promise<{ path: string; node: Obj } | { path: string; node: null; error?: string }> {
	const { type, body } = parseSlug(slug);
	const path = join(cacheDir, "nodes", type, `${body}.json`);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { path, node: null };
		return { path, node: null, error: `${slug}: unreadable node file: ${(e as Error).message}` };
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed)) return { path, node: null, error: `${slug}: node file is not a JSON object` };
		return { path, node: parsed };
	} catch (e) {
		return { path, node: null, error: `${slug}: invalid JSON: ${(e as Error).message}` };
	}
}

export async function runMigration(options: RunOptions): Promise<{ manifest: Manifest; exitCode: number }> {
	const writes = new Map<string, Obj>();
	const changed: Change[] = [];
	const skipped: Skipped[] = [];
	const errors: string[] = [];

	// A node can carry two decisions (none today): fold them over one copy, write once.
	const pending = new Map<string, { path: string; node: Obj }>();
	for (const decision of CLOSED_LIST) {
		const slug = decision.artist;
		let state = pending.get(slug);
		if (!state) {
			const read = await readNode(options.cacheDir, slug);
			if (read.node === null) {
				if (read.error) errors.push(read.error);
				else skipped.push({ slug, field: decision.field, reason: "absent" });
				continue;
			}
			state = { path: read.path, node: read.node };
			pending.set(slug, state);
		}
		const result = applyDecision(state.node, decision);
		if (result.next === null) skipped.push(result.skipped);
		else {
			state.node = result.next;
			changed.push(result.change);
		}
	}

	for (const [slug, { path, node }] of pending) {
		if (!changed.some((c) => c.slug === slug)) continue;
		const parsed = nodePayloadSchema.safeParse(node);
		if (!parsed.success) {
			errors.push(`${slug}: refusing to write an invalid node: ${parsed.error.message}`);
		} else if (!onlyAddsSchemaDefaults(node, parsed.data)) {
			errors.push(`${slug}: refusing to write: validation would alter fields the node carries`);
		} else {
			// The node as read, minus the pick: the parsed copy would also add the empty lists a node lacks.
			writes.set(path, node);
		}
	}

	const blocked = errors.length > 0;
	const manifest: Manifest = {
		migration: MIGRATION_NAME,
		generated_at: new Date().toISOString(),
		mode: options.apply ? "apply" : "dry-run",
		blocked,
		removed: [],
		renamed: {},
		redirects: {},
		written: blocked ? 0 : writes.size,
		changed,
		skipped,
		errors,
	};
	if (options.apply && !blocked) {
		for (const [path, node] of writes) await atomicWriteJson(path, node);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: blocked ? (options.apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	lines.push(`  ${"node files written".padEnd(24)} ${manifest.written}`);
	for (const c of manifest.changed) {
		const what =
			c.action === "replaced"
				? `-> ${c.to}`
				: c.replacementMissing
					? "cleared (replacement missing)"
					: "cleared";
		lines.push(`  ${c.slug}.${c.field}: ${c.from} ${what}`);
	}
	for (const s of manifest.skipped) {
		lines.push(`  skipped ${s.slug}.${s.field}: ${s.reason}${s.found ? ` (${s.found})` : ""}`);
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
			"usage: 2026-10-24-fix-weak-landmarks.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
