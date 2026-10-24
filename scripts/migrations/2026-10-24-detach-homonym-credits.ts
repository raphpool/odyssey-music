/**
 * Detach the credits that belong to a namesake (TRA-570, plan docs/plans/graph-integrity.md). A work that credits
 * the wrong "Inside" (a 1993 UK electronic EP, `project:the-ep--inside`) was mirrored on the page of the right one
 * (a Long Island emo band, 1995-1999) by the reverse backfill (TRA-486): the link became two-way and left the
 * `homonym-release-links` audit measure. This removes BOTH sides of each proven case, and nothing else.
 *
 * Closed list. The identity of a case is NOT guessed here: it is read from the proof table next to this file
 * (2026-10-24-detach-homonym-credits.identities.json: MusicBrainz identity of the artist, year of the work,
 * looked up by hand on 2026-10-24). Offline and deterministic: no network, no clock. A case is detached only
 * when its entry is `proven` AND the cache agrees with the proof (a drifted node is refused, never detached):
 * - the work is a project / track with NO mbid of its own (an MB identity would be the proof, not this table),
 *   its `year` is the proven one, and it still credits the artist;
 * - the artist is named like the proof, carries no mbid or the proven one, and the proven `begin` year is AFTER
 *   the work's year (the work predates the artist, so cannot be its);
 * - every `anchors` string is in the article it belongs to (what the node says about itself, so that a node
 *   re-materialized as something else on the server is not touched).
 * Anything else (no entry, `refused`, one failed check) is left as it is and listed in `refused`.
 *
 * Detach: the artist is removed from the work's `artists`; the work is removed from the artist's `discography`
 * and `notable_tracks`, and from its `landmark_project` / `reference_track` when it is the pick (a pick must be a
 * member of its list). The work keeps everything else, `artists: []` included (TRA-485 decides what to do with
 * uncredited works). pending-reverses.json entries that would put either side back are dropped. Idempotent: a
 * second run finds the pair already detached.
 *
 * Every node to write is validated (nodePayloadSchema) before the first write; one error blocks the run (exit 1,
 * 2 with --apply). Dry-run by default. Manifest: deterministic (no timestamp), with the channel's constants
 * (`migration`, `removed: []`, `renamed: {}`, `redirects: {}`).
 *
 * Migration channel (deploy/sync-genre-cache.sh): `<cache-dir> --apply --manifest <p> --data-dir <d>`; the
 * data dir is accepted and unused (no redirect is read or written).
 *
 * Usage: tsx scripts/migrations/2026-10-24-detach-homonym-credits.ts <cache-dir> [--apply]
 *        [--manifest out/detach-homonym-credits.json] [--data-dir <dir>]
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { isValidSlug } from "../../src/slug.js";
import {
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	readTextOrDefault,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-24-detach-homonym-credits";
export const DEFAULT_MANIFEST_PATH = "out/detach-homonym-credits.json";
export const IDENTITIES_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	`${MIGRATION_NAME}.identities.json`,
);

type Obj = Record<string, unknown>;

const slugOf = (prefix: string) =>
	z.string().refine((s) => s.startsWith(`${prefix}:`) && isValidSlug(s), `not a canonical ${prefix} slug`);
const workSlug = z.string().refine((s) => /^(project|track):/.test(s) && isValidSlug(s), "not a work slug");
const identitiesSchema = z.object({
	source: z.string(),
	cases: z.array(
		z.discriminatedUnion("status", [
			z.object({
				key: z.string().min(1),
				status: z.literal("proven"),
				work: workSlug,
				artist: slugOf("artist"),
				artist_identity: z.object({
					mbid: z.string().uuid(),
					name: z.string().min(1),
					disambiguation: z.string(),
					begin: z.string().regex(/^\d{4}/),
					end: z.string().nullable(),
					release_groups: z.array(z.object({ mbid: z.string().uuid(), title: z.string(), year: z.string() })),
				}),
				work_identity: z.object({ year: z.string().regex(/^\d{4}$/) }),
				anchors: z.object({ artist: z.array(z.string().min(1)), work: z.array(z.string().min(1)) }),
				evidence: z.array(z.string()),
			}),
			z.object({
				key: z.string().min(1),
				status: z.literal("refused"),
				work: workSlug,
				artist: slugOf("artist"),
				reason: z.string().min(1),
			}),
		]),
	),
});
export type Identities = z.infer<typeof identitiesSchema>;

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
type PendingFile = Record<string, PendingReverse[]>;

const LIST_FIELDS = ["discography", "notable_tracks"] as const;
const PICK_FIELDS = ["landmark_project", "reference_track"] as const;

export interface Manifest {
	migration: string;
	mode: "dry-run" | "apply";
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	detached: { key: string; work: string; artist: string; removed: string[] }[];
	alreadyDetached: string[];
	refused: { key: string; reason: string }[];
	written: number;
	pendingDropped: number;
	errors: string[];
	blocked: boolean;
}

const sameSlug = (value: unknown, slug: string): boolean => isRecord(value) && value.slug === slug;
const yearOf = (value: unknown): number =>
	typeof value === "string" ? Number.parseInt(value.slice(0, 4), 10) : Number.NaN;

/** The list without the entries naming `slug`, or null when it has none. */
function withoutSlug(list: unknown, slug: string): unknown[] | null {
	if (!Array.isArray(list)) return null;
	const kept = list.filter((e) => !sameSlug(e, slug));
	return kept.length === list.length ? null : kept;
}

export function planDetach(
	files: readonly { path: string; slug: string; node: Obj }[],
	pending: PendingFile,
	identities: Identities,
): { writes: Map<string, Obj>; pending: PendingFile | null; manifest: Manifest } {
	const manifest: Manifest = {
		migration: MIGRATION_NAME,
		mode: "dry-run",
		removed: [],
		renamed: {},
		redirects: {},
		detached: [],
		alreadyDetached: [],
		refused: [],
		written: 0,
		pendingDropped: 0,
		errors: [],
		blocked: false,
	};
	const bySlug = new Map(files.map((f) => [f.slug, f]));
	const next = new Map<string, Obj>(); // path -> node to write, accumulated across cases
	const current = (slug: string): Obj | undefined => {
		const file = bySlug.get(slug);
		return file === undefined ? undefined : (next.get(file.path) ?? file.node);
	};
	let nextPending: PendingFile = pending;

	for (const c of [...identities.cases].sort((a, b) => (a.key < b.key ? -1 : 1))) {
		const refuse = (reason: string) => manifest.refused.push({ key: c.key, reason });
		if (c.status === "refused") {
			refuse(c.reason);
			continue;
		}
		const workFile = bySlug.get(c.work);
		const artistFile = bySlug.get(c.artist);
		const work = current(c.work);
		const artist = current(c.artist);
		if (!workFile || !artistFile || !work || !artist) {
			refuse("a node of the pair is not in the cache");
			continue;
		}
		const credits = Array.isArray(work.artists) ? work.artists : [];
		const listed = LIST_FIELDS.some(
			(f) => Array.isArray(artist[f]) && (artist[f] as unknown[]).some((e) => sameSlug(e, c.work)),
		);
		const picked = PICK_FIELDS.some((f) => sameSlug(artist[f], c.work));
		if (!credits.some((e) => sameSlug(e, c.artist)) && !listed && !picked) {
			manifest.alreadyDetached.push(c.key);
			continue;
		}
		const id = c.artist_identity;
		const problems: string[] = [];
		if (work.mbid !== undefined) problems.push("the work has an mbid of its own");
		if (work.year !== c.work_identity.year)
			problems.push(`the work's year is ${JSON.stringify(work.year)}, proven ${c.work_identity.year}`);
		if (artist.name !== id.name)
			problems.push(`the artist is named ${JSON.stringify(artist.name)}, proven ${id.name}`);
		if (artist.mbid !== undefined && artist.mbid !== id.mbid)
			problems.push(`the artist's mbid is ${String(artist.mbid)}, proven ${id.mbid}`);
		if (!(yearOf(id.begin) > yearOf(c.work_identity.year)))
			problems.push("the work does not predate the artist");
		for (const a of c.anchors.artist)
			if (!String(artist.editorial_article ?? "").includes(a)) problems.push(`artist article lacks "${a}"`);
		for (const a of c.anchors.work)
			if (!String(work.editorial_article ?? "").includes(a)) problems.push(`work article lacks "${a}"`);
		if (problems.length > 0) {
			refuse(problems.join("; "));
			continue;
		}

		const removed: string[] = [];
		const nextWork: Obj = { ...work };
		const keptCredits = withoutSlug(work.artists, c.artist);
		if (keptCredits) {
			nextWork.artists = keptCredits;
			removed.push(`${c.work}.artists`);
		}
		const nextArtist: Obj = { ...artist };
		for (const f of LIST_FIELDS) {
			const kept = withoutSlug(artist[f], c.work);
			if (kept) {
				nextArtist[f] = kept;
				removed.push(`${c.artist}.${f}`);
			}
		}
		for (const f of PICK_FIELDS) {
			if (sameSlug(artist[f], c.work)) {
				delete nextArtist[f];
				removed.push(`${c.artist}.${f}`);
			}
		}
		next.set(workFile.path, nextWork);
		next.set(artistFile.path, nextArtist);
		manifest.detached.push({ key: c.key, work: c.work, artist: c.artist, removed });

		// A queued reverse that would put either side back.
		const rebuilt: PendingFile = {};
		for (const [key, list] of Object.entries(nextPending)) {
			const kept = list.filter((p) => {
				const back =
					(key === c.artist &&
						(LIST_FIELDS as readonly string[]).includes(p.field) &&
						p.edge.slug === c.work) ||
					(key === c.work && p.field === "artists" && p.edge.slug === c.artist);
				if (back) manifest.pendingDropped += 1;
				return !back;
			});
			if (kept.length > 0) rebuilt[key] = kept;
		}
		nextPending = rebuilt;
	}

	const writes = new Map<string, Obj>();
	for (const [path, node] of [...next].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const parsed = nodePayloadSchema.safeParse(node);
		if (!parsed.success)
			manifest.errors.push(
				`${String(node.slug)}: refusing to write an invalid node: ${parsed.error.message}`,
			);
		else if (!onlyAddsSchemaDefaults(node, parsed.data))
			manifest.errors.push(
				`${String(node.slug)}: refusing to write: validation would alter fields the node carries`,
			);
		else writes.set(path, parsed.data as unknown as Obj);
	}
	manifest.written = writes.size;
	return { writes, pending: manifest.pendingDropped > 0 ? nextPending : null, manifest };
}

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	/** The proof table; the committed one by default. */
	identities?: Identities;
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

	let identities = options.identities;
	if (!identities) {
		try {
			identities = identitiesSchema.parse(JSON.parse(await readFile(IDENTITIES_PATH, "utf8")));
		} catch (e) {
			errors.push(`proof table unreadable: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	const plan = planDetach(nodes, pending, identities ?? { source: "", cases: [] });
	const manifest = plan.manifest;
	manifest.errors.push(...errors);
	manifest.blocked = manifest.errors.length > 0;
	if (apply) manifest.mode = "apply";
	if (apply && !manifest.blocked) {
		for (const [path, node] of plan.writes) await atomicWriteJson(path, node);
		if (plan.pending) await atomicWriteJson(pendingPath, plan.pending);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: manifest.blocked ? (apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	for (const d of manifest.detached)
		lines.push(`  detached ${d.artist} <-> ${d.work}: ${d.removed.join(", ")}`);
	for (const key of manifest.alreadyDetached) lines.push(`  already detached ${key}`);
	for (const r of manifest.refused) lines.push(`  refused ${r.key}: ${r.reason}`);
	lines.push(`  node files written ${manifest.written}, pending entries dropped ${manifest.pendingDropped}`);
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
	dataDir?: string;
}

/** `<cache-dir> [--apply] [--manifest p] [--data-dir d]`; null (exit 2) on anything else. */
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
	return {
		cacheDir,
		apply,
		manifestPath: values["--manifest"] ?? DEFAULT_MANIFEST_PATH,
		...(values["--data-dir"] ? { dataDir: values["--data-dir"] } : {}),
	};
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
