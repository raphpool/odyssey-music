/**
 * Artist identity backfill (TRA-463, plan docs/plans/graph-integrity.md, part 1): give every artist
 * node the MusicBrainz identity it lacks. For each artist, resolve it to one MB artist (exact
 * canonical name, homonyms separated by the node's own `disambiguator` / `origin` hints, a candidate
 * whose MB context contradicts those hints refused, anything else left unresolved: safety over
 * resolution rate, an unresolved artist keeps its slug and gets no MBID), then write `mbid` and `artist_kind` on the node and record the bands the
 * artist belongs to in a manifest. Nothing is renamed, merged or re-slugged here (that is 1.12), no
 * LLM is involved, and a node's slug never derives from an MB name (MB names can be in their
 * original script).
 *
 * Dry-run by default: the manifest is written, node files are not. `--apply` writes the nodes. The
 * manifest is a checkpoint too: `--resume` reuses its resolved entries, so an interrupted run (or an
 * `--apply` after a dry-run) does not repeat the MusicBrainz calls. Idempotent: a node that already
 * carries the right `mbid` / `artist_kind` is not rewritten.
 *
 * Writes go through atomicWriteJson after nodePayloadSchema validation, never NodeCache.write, which
 * would also emit pending reverse edges this migration has no business creating.
 *
 * Pace: MusicBrainz allows one request per second (mbFetch enforces it), and an artist costs up to
 * three requests (search, alias search when no canonical name matched, profile with bands): 581
 * artists take about half an hour.
 *
 * Usage: tsx scripts/migrations/2026-10-15-backfill-artist-identity.ts <cache-dir> [--apply]
 *        [--manifest out/artist-identity.json] [--limit N] [--resume]
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJson } from "../../src/cache.js";
import { musicBrainzConfig } from "../../src/config.js";
import {
	fetchArtistProfileMb,
	type MbArtistKind,
	type MbCredit,
	resolveArtistDetailed,
} from "../../src/musicbrainz.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import {
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";

export const DEFAULT_MANIFEST_PATH = "out/artist-identity.json";

/** Upper bound of requests per artist: search, alias search, profile. */
const CALLS_PER_ARTIST = 3;
/** The manifest is rewritten this often during a run, so a crash loses little. */
const CHECKPOINT_EVERY = 25;
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How an artist was matched: `name` (canonical name), `alias` (no canonical name matched), or
 * `stored-mbid` (the node already carried an MBID, so nothing was searched).
 */
export type ResolutionPath = "name" | "alias" | "stored-mbid";

export interface ResolvedArtist {
	mbid: string;
	kind: MbArtistKind | null;
	groups: MbCredit[];
	/**
	 * What MB calls the artist, and the context it was matched on, so that TRA-483 can audit the
	 * identities without repeating 581 lookups.
	 */
	mb_name: string;
	disambiguation: string | null;
	area: string | null;
	path: ResolutionPath;
	/** Other artists with exactly this name that were passed over (0 for a sole candidate). */
	homonyms_discarded: number;
}

export interface IdentityManifest {
	generated_at: string;
	resolved: Record<string, ResolvedArtist>;
	unresolved: { slug: string; name: string; candidates: number }[];
	/** Two or more slugs resolved on the same MBID: left for the merge step (1.12) to decide. */
	collisions: { mbid: string; slugs: string[] }[];
}

export interface BackfillOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	/** Maximum number of artists sent to MusicBrainz in this run; entries reused by --resume are free. */
	limit?: number;
	resume?: boolean;
	log?: (line: string) => void;
}

export interface BackfillResult {
	manifest: IdentityManifest;
	/** Node files written (always empty without --apply). */
	written: string[];
	/** Left untouched and not reported as unresolved: unusable stored mbid, MB lookup failure, refused write. */
	failed: { slug: string; reason: string }[];
	exitCode: 0 | 1;
}

function isResolvedArtist(value: unknown): value is ResolvedArtist {
	return (
		isRecord(value) &&
		typeof value.mbid === "string" &&
		MBID_RE.test(value.mbid) &&
		(value.kind === null || value.kind === "person" || value.kind === "group") &&
		Array.isArray(value.groups) &&
		typeof value.mb_name === "string" &&
		(value.disambiguation === null || typeof value.disambiguation === "string") &&
		(value.area === null || typeof value.area === "string") &&
		(value.path === "name" || value.path === "alias" || value.path === "stored-mbid") &&
		typeof value.homonyms_discarded === "number"
	);
}

/** Reads a previous manifest. Null when absent; throws when present but unusable (never overwrite it blind). */
async function readManifest(path: string): Promise<IdentityManifest | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.resolved) || !Array.isArray(parsed.unresolved)) {
		throw new Error(`${path} is not an artist-identity manifest`);
	}
	const resolved: Record<string, ResolvedArtist> = {};
	for (const [slug, entry] of Object.entries(parsed.resolved)) {
		if (isResolvedArtist(entry)) resolved[slug] = entry;
	}
	return {
		generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : "",
		resolved,
		unresolved: parsed.unresolved.flatMap((u: unknown) =>
			isRecord(u) &&
			typeof u.slug === "string" &&
			typeof u.name === "string" &&
			typeof u.candidates === "number"
				? [{ slug: u.slug, name: u.name, candidates: u.candidates }]
				: [],
		),
		collisions: [],
	};
}

export function findCollisions(resolved: Record<string, ResolvedArtist>): IdentityManifest["collisions"] {
	const byMbid = new Map<string, string[]>();
	for (const [slug, entry] of Object.entries(resolved)) {
		byMbid.set(entry.mbid, [...(byMbid.get(entry.mbid) ?? []), slug]);
	}
	return [...byMbid.entries()]
		.filter(([, slugs]) => slugs.length > 1)
		.map(([mbid, slugs]) => ({ mbid, slugs: [...slugs].sort() }))
		.sort((a, b) => (a.mbid < b.mbid ? -1 : a.mbid > b.mbid ? 1 : 0));
}

function buildManifest(
	resolved: Record<string, ResolvedArtist>,
	unresolved: IdentityManifest["unresolved"],
): IdentityManifest {
	const sorted: Record<string, ResolvedArtist> = {};
	for (const slug of Object.keys(resolved).sort()) sorted[slug] = resolved[slug] as ResolvedArtist;
	return {
		generated_at: new Date().toISOString(),
		resolved: sorted,
		unresolved: [...unresolved].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
		collisions: findCollisions(sorted),
	};
}

async function writeManifest(path: string, manifest: IdentityManifest): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await atomicWriteJson(path, manifest);
}

/**
 * True when `parsed` (the node after schema validation) equals `written` except for fields `written`
 * lacks that the schema filled in with an empty list. Since TRA-456 `similar_artists` is required
 * with a default of [], and no stored artist has it: validating adds it to every node, which is the
 * schema's own default, not an alteration. Any other difference (a stripped or rewritten field, an
 * edge losing a key, a non-empty default) still refuses the write.
 */
export function onlyAddsSchemaDefaults(written: Record<string, unknown>, parsed: unknown): boolean {
	if (!isRecord(parsed)) return false;
	const expected: Record<string, unknown> = { ...written };
	for (const [key, value] of Object.entries(parsed)) {
		if (!(key in written) && Array.isArray(value) && value.length === 0) expected[key] = value;
	}
	return isDeepStrictEqual(parsed, expected);
}

/** The node with `mbid` / `artist_kind` set from `entry`, or null when it already carries them. */
export function withIdentity(
	node: Record<string, unknown>,
	entry: ResolvedArtist,
): Record<string, unknown> | null {
	const next: Record<string, unknown> = { ...node };
	if (node.mbid !== entry.mbid) next.mbid = entry.mbid;
	// A null kind (MB type neither person nor group) never erases a kind already stored.
	if (entry.kind !== null && node.artist_kind !== entry.kind) next.artist_kind = entry.kind;
	return next.mbid === node.mbid && next.artist_kind === node.artist_kind ? null : next;
}

function optionalText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
	const { cacheDir, apply, limit } = options;
	const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
	const log = options.log ?? (() => {});

	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	const artists = nodes.filter((n) => n.type === "artist");

	const prior = options.resume ? await readManifest(manifestPath) : null;
	// Seeded with every prior entry so a checkpoint never forgets artists not reached yet; an entry
	// is replaced or dropped when its artist is processed below.
	const resolved: Record<string, ResolvedArtist> = {};
	const unresolved: IdentityManifest["unresolved"] = [];
	const failed: BackfillResult["failed"] = [];
	const written: string[] = [];
	const slugs = new Set(artists.map((a) => a.slug));
	for (const [slug, entry] of Object.entries(prior?.resolved ?? {}))
		if (slugs.has(slug)) resolved[slug] = entry;

	const reusable = (slug: string, stored: unknown): boolean => {
		const entry = resolved[slug];
		return entry !== undefined && (stored === undefined || stored === entry.mbid);
	};
	const pending = artists.filter((a) => !reusable(a.slug, a.node.mbid));
	const toQuery = limit === undefined ? pending.length : Math.min(limit, pending.length);
	const seconds = Math.ceil(
		(toQuery * CALLS_PER_ARTIST * Math.max(musicBrainzConfig.minIntervalMs, 0)) / 1000,
	);
	log(
		`${artists.length} artists, ${artists.length - pending.length} reused from the manifest, ${toQuery} to ` +
			`query: up to ${toQuery * CALLS_PER_ARTIST} MusicBrainz requests, about ${Math.ceil(seconds / 60)} min ` +
			`at one request per ${musicBrainzConfig.minIntervalMs} ms${apply ? "" : " (dry-run)"}`,
	);

	let attempted = 0;
	let checkpointed = 0;
	for (const { slug, path, node } of artists) {
		const stored = node.mbid;
		let entry: ResolvedArtist | undefined;
		if (reusable(slug, stored)) {
			entry = resolved[slug];
		} else {
			delete resolved[slug];
			if (limit !== undefined && attempted >= limit) {
				// Not reached this run: keep what the previous manifest said about it.
				const before = prior?.unresolved.find((u) => u.slug === slug);
				if (before) unresolved.push(before);
				continue;
			}
			attempted++;
			const name = optionalText(node.name) ?? slug;
			let requested: string;
			let path: ResolutionPath = "stored-mbid";
			let homonymsDiscarded = 0;
			if (stored !== undefined) {
				if (typeof stored !== "string" || !MBID_RE.test(stored)) {
					failed.push({ slug, reason: `stored mbid is not a UUID: ${String(stored)}` });
					continue;
				}
				requested = stored;
			} else {
				const hints: { disambiguator?: string; origin?: string } = {};
				const disambiguator = optionalText(node.disambiguator);
				const origin = optionalText(node.origin);
				if (disambiguator) hints.disambiguator = disambiguator;
				if (origin) hints.origin = origin;
				const found = await resolveArtistDetailed(name, hints);
				if (found.unavailable) {
					failed.push({ slug, reason: "MusicBrainz search unavailable" });
					continue;
				}
				if (!found.artist || found.path === null) {
					unresolved.push({ slug, name, candidates: found.candidates });
					continue;
				}
				requested = found.artist.mbid;
				path = found.path;
				homonymsDiscarded = found.candidates - 1;
			}
			// One request for kind and bands: a failed answer is a failure, never "no bands" (a 502 on the
			// relations once stored groups: [] for good, because --resume trusts what the manifest says).
			const profile = await fetchArtistProfileMb(requested);
			if (!profile) {
				failed.push({ slug, reason: `MusicBrainz artist lookup failed for ${requested}` });
				continue;
			}
			// profile.mbid is the live MBID: it differs from `requested` when MB merged that MBID away.
			entry = {
				mbid: profile.mbid,
				kind: profile.kind,
				groups: profile.groups,
				mb_name: profile.name,
				disambiguation: profile.disambiguation,
				area: profile.area,
				path,
				homonyms_discarded: homonymsDiscarded,
			};
			resolved[slug] = entry;
		}

		if (apply && entry) {
			const next = withIdentity(node, entry);
			if (next) {
				const parsed = nodePayloadSchema.safeParse(next);
				if (!parsed.success) {
					failed.push({ slug, reason: `refusing to write an invalid node: ${parsed.error.message}` });
				} else if (!onlyAddsSchemaDefaults(next, parsed.data)) {
					// The schema strips undeclared fields, edges' included; beyond mbid / artist_kind, only the
					// addition of a missing list at its default (empty) is tolerated.
					failed.push({ slug, reason: "refusing to write: validation would alter fields the node carries" });
				} else {
					await atomicWriteJson(path, parsed.data);
					written.push(path);
				}
			}
		}
		if (attempted - checkpointed >= CHECKPOINT_EVERY) {
			checkpointed = attempted;
			await writeManifest(manifestPath, buildManifest(resolved, unresolved));
		}
	}

	const manifest = buildManifest(resolved, unresolved);
	await writeManifest(manifestPath, manifest);
	// A failure is a hole in the manifest, not a verdict: exit 1 so the operator re-runs with --resume.
	return { manifest, written, failed, exitCode: failed.length > 0 ? 1 : 0 };
}

export function formatSummary(result: BackfillResult, apply: boolean, manifestPath: string): string {
	const { manifest, written, failed } = result;
	const lines = [
		`resolved ${Object.keys(manifest.resolved).length}, unresolved ${manifest.unresolved.length}, ` +
			`collisions ${manifest.collisions.length}, failed ${failed.length}`,
		apply ? `${written.length} node file(s) written` : "dry-run: no node file written",
		`manifest: ${manifestPath}`,
	];
	for (const c of manifest.collisions) lines.push(`collision ${c.mbid}: ${c.slugs.join(", ")}`);
	for (const u of manifest.unresolved) lines.push(`unresolved ${u.slug} (${u.candidates} candidate(s))`);
	for (const f of failed) lines.push(`failed ${f.slug}: ${f.reason}`);
	return lines.join("\n");
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	limit?: number;
	resume: boolean;
}

/**
 * Parses `<cache-dir> [--apply] [--manifest <path>] [--limit N] [--resume]`. Null (CLI exits 2) on a
 * missing cache-dir, a repeated flag, a flag without its value (or with another flag as value), a
 * `--limit` that is not a positive integer, or any token no flag consumes: an ambiguous argument
 * never falls through to a guess.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let resume = false;
	let manifestPath: string | undefined;
	let limit: number | undefined;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--resume" && !resume) resume = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--limit" && limit === undefined)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else if (/^[1-9]\d*$/.test(value)) limit = Number(value);
			else return null;
		} else return null;
	}
	return {
		cacheDir,
		apply,
		resume,
		manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH,
		...(limit !== undefined ? { limit } : {}),
	};
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-15-backfill-artist-identity.ts <cache-dir> [--apply] [--manifest <path>] [--limit N] [--resume]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runBackfill({
		cacheDir: args.cacheDir,
		apply: args.apply,
		manifestPath: args.manifestPath,
		resume: args.resume,
		...(args.limit !== undefined ? { limit: args.limit } : {}),
		log: (line) => process.stdout.write(`${line}\n`),
	});
	console.log(formatSummary(result, args.apply, args.manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
