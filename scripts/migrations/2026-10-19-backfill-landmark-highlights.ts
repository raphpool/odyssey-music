/**
 * Flagship album and reference track backfill (TRA-491, plan docs/plans/graph-integrity.md, part 5): give
 * every artist that has none a `landmark_project` and a `reference_track`, chosen WITHOUT an LLM and
 * offline among the edges the artist already carries (decision 7: re-calling Gemini for 581 nodes was
 * rejected). The rule is readable in the manifest, entry by entry.
 *
 * For each artist WITHOUT `landmark_project` and with a non-empty `discography`, every entry of the
 * discography is scored:
 *   +100 per genre of the cache whose `landmark_projects` lists the entry's slug  (reason `genreLandmark`)
 *   +10  when the target is in the cache and has an `image_url`                    (reason `imaged`)
 *   +1   when the target is in the cache                                           (reason `cached`)
 * The highest score wins, a tie goes to the first in the list. The reason is the strongest signal the
 * winner has, `first` when it has none. Same rule for `reference_track` over `notable_tracks`, with the
 * genres' `landmark_tracks`. The chosen edge is copied as is (slug, name, mbid, artist, ...) from the
 * artist's OWN list: nothing is invented and no other node is read for its edges.
 *
 * Identity, safety before rate (2026-10-17, same family of defect as the homonyms of TRA-570 / TRA-561): an
 * artist's `discography` / `notable_tracks` can list a work that belongs to somebody else with the same
 * name. A flagship that points at another artist's album is worse than none, so:
 *   - an entry whose target is in the cache and does NOT credit the artist (`artists` holds neither the
 *     artist's slug nor an artist edge with the same non-empty mbid, the rule of `reciprocates`,
 *     src/images/reciprocity.ts) is EXCLUDED from the choice, whatever its score, and listed in
 *     `excluded`; so is a target whose file cannot be read (it cannot be shown to credit anyone);
 *   - the "referenced by a genre" and "imaged" signals only count for a target that credits the artist;
 *   - a target that is not in the cache and is not redirected cannot be checked: it stays eligible, with a
 *     score of 0.
 * REDIRECTS (2026-10-17, deep review of PR #520): every candidate is resolved the way the reads resolve it
 * (`resolveReadSlug`: a live cache node wins, otherwise one hop of data/genre-redirects.json +
 * data/slug-redirects.json). A redirected target that is absent from the cache is NOT "unknown": the front
 * and GET /node open the work it redirects to, which may belong to a homonym (artist:the-byrds ->
 * track:mr-tambourine-man -> track:mr-tambourine-man--bob-dylan). So: when the resolved node is in the
 * cache, the credit rule applies to THAT node (and the genre / image signals are read on it); when it is
 * not, the entry is excluded (`redirected`), unless the redirect lands on a slug scoped on the artist
 * itself (`--<artist slug body or name>`), which stays eligible with a score of 0. The tables are read
 * from `--data-dir` (the channel's scratch copy) or else the repo's data/; an unreadable or invalid
 * table, or a missing slug table when `--data-dir` is given, refuses the run before any write (fail
 * closed). The edge copied keeps the slug of the artist's own list, NOT the resolved one: the pipeline
 * requires the pick to be a member of its list compared by slug (enforceArtistChoices, TRA-470: a pick
 * that is not becomes the list's first entry), and the scope migration moves a list entry and the pick
 * together (CREDITED_FIELDS, 2026-10-16-scope-release-slugs.ts) so that they stay equal. Rewriting only
 * the pick would break both.
 * When every entry is excluded the artist goes to `skipped` for that field, like an empty list.
 * ORDER (precondition): the credit is read on the target's `artists`, which the identity migrations
 * (artist and release identity, scope) and the reverse-edge backfill (2026-10-17) fill in. Run on a cache
 * where those are not applied, a work that really belongs to the artist can look "not credited" and be
 * excluded; that costs rate, never safety. But a pick, once written, is final (idempotence: an artist that
 * has the field is never revisited), so run this AFTER those migrations, not before.
 *
 * An artist that already has the field is never touched; the node's other fields are not either (only
 * `landmark_project` and `reference_track` are added, plus the schema's own default `similar_artists: []`
 * on a node that did not carry it, which validation adds to every artist it writes: onlyAddsSchemaDefaults
 * lets that one through and nothing else), so a second run changes nothing. Writes go through
 * atomicWriteJson after nodePayloadSchema validation, never NodeCache.write (which would emit reverse
 * edges); a write that validation would alter is refused and the artist listed in `failed` (exit 1).
 * Pure and offline: no network call, no clock.
 *
 * Manifest: deterministic (sorted, no timestamp), the same in a dry-run, an apply and a re-run on a copy.
 * It carries the migration channel's constants (`migration`, `removed: []`, `renamed: {}`,
 * `redirects: {}`). Counters are per field because the two choices are independent (an artist can get a
 * flagship but no reference track). A re-run on an already filled cache has an empty `picks`: the manifest
 * is the same only for the same input. Migration channel (deploy/sync-genre-cache.sh): `--apply`,
 * `--manifest` and `--data-dir` are the flags it passes; `--data-dir` is where the redirect tables are read.
 *
 * Usage: tsx scripts/migrations/2026-10-19-backfill-landmark-highlights.ts <cache-dir> [--apply]
 *        [--manifest out/landmark.json] [--data-dir <dir>]
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, NodeCache } from "../../src/cache.js";
import { loadRedirects, resolveReadSlug } from "../../src/genre-registry.js";
import { reciprocity, type Work } from "../../src/images/reciprocity.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { parseSlug, scopeMatchesArtist, scopeOf } from "../../src/slug.js";
import type { NodePayload, Slug } from "../../src/types.js";
import {
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-19-backfill-landmark-highlights";
export const DEFAULT_MANIFEST_PATH = "out/landmark.json";

/** The two fields this migration may add, the artist list each is chosen in, and the genre list that signals it. */
export const HIGHLIGHT_FIELDS = [
	{ field: "landmark_project", list: "discography", genreList: "landmark_projects" },
	{ field: "reference_track", list: "notable_tracks", genreList: "landmark_tracks" },
] as const;
export type HighlightField = (typeof HIGHLIGHT_FIELDS)[number]["field"];

export const REASONS = ["genreLandmark", "imaged", "cached", "first"] as const;
export type Reason = (typeof REASONS)[number];

export const EXCLUSION_REASONS = ["not-credited", "redirected", "unreadable"] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface HighlightPick {
	artist: string;
	field: HighlightField;
	target: string;
	reason: Reason;
	score: number;
}

export interface Exclusion {
	artist: string;
	field: HighlightField;
	target: string;
	reason: ExclusionReason;
}

export interface LandmarkManifest {
	/** The channel's manifest contract (TRA-568): this migration deletes and renames nothing. */
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	/** Edges chosen (and written by an apply), per field. */
	written: Record<HighlightField, number>;
	byReason: Record<HighlightField, Record<Reason, number>>;
	/** Artists left without the field: an empty list, or every entry excluded. */
	skipped: Record<HighlightField, string[]>;
	/** Entries kept out of the choice because their target does not credit the artist. */
	excluded: Exclusion[];
	/** Every choice, with the score that decided it. */
	picks: HighlightPick[];
	/** Artists left untouched because they could not be read, validated or written safely. */
	failed: { slug: string; reason: string }[];
}

// --- Pure choice ---

/** What the cache says about the target of an entry, as far as the artist's identity is concerned. */
export type TargetState =
	| { kind: "absent" }
	| { kind: "unreadable" }
	| { kind: "uncredited" }
	/** Redirected to a node absent from the cache and not scoped on the artist: the reads open somebody's work. */
	| { kind: "redirected" }
	| { kind: "credited"; imaged: boolean };

export interface Candidate {
	/** The artist's own edge, copied as is when chosen. */
	edge: Record<string, unknown>;
	slug: string;
	state: TargetState;
	/** How many genres of the cache list this slug in their landmark list. */
	genres: number;
}

export type Choice =
	| { kind: "empty" }
	| { kind: "all-excluded"; excluded: { slug: string; reason: ExclusionReason }[] }
	| {
			kind: "chosen";
			edge: Record<string, unknown>;
			slug: string;
			reason: Reason;
			score: number;
			excluded: { slug: string; reason: ExclusionReason }[];
	  };

/** The score of an eligible candidate; the signals count only for a target that credits the artist. */
export function scoreOf(c: Candidate): number {
	if (c.state.kind === "absent") return 0;
	if (c.state.kind !== "credited") return Number.NEGATIVE_INFINITY;
	return c.genres * 100 + (c.state.imaged ? 10 : 0) + 1;
}

export function reasonOf(score: number): Reason {
	return score >= 100 ? "genreLandmark" : score >= 10 ? "imaged" : score >= 1 ? "cached" : "first";
}

/** The best eligible candidate (highest score, first on a tie), or why there is none. */
export function choose(candidates: readonly Candidate[]): Choice {
	if (candidates.length === 0) return { kind: "empty" };
	const excluded: { slug: string; reason: ExclusionReason }[] = [];
	let best: { candidate: Candidate; score: number } | null = null;
	for (const candidate of candidates) {
		const kind = candidate.state.kind;
		if (kind === "uncredited" || kind === "unreadable" || kind === "redirected") {
			excluded.push({
				slug: candidate.slug,
				reason: kind === "uncredited" ? "not-credited" : kind === "redirected" ? "redirected" : "unreadable",
			});
			continue;
		}
		const score = scoreOf(candidate);
		if (best === null || score > best.score) best = { candidate, score };
	}
	if (best === null) return { kind: "all-excluded", excluded };
	return {
		kind: "chosen",
		edge: best.candidate.edge,
		slug: best.candidate.slug,
		reason: reasonOf(best.score),
		score: best.score,
		excluded,
	};
}

// --- Run ---

export interface BackfillOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	/** Where the redirect tables are read (the channel's scratch copy); the repo's data/ when absent. */
	dataDir?: string | undefined;
	log?: (line: string) => void;
}

/**
 * The redirect table the reads use (genre + slug files). Throws on an unreadable or invalid table, and on
 * a missing slug table when a directory was given explicitly: the run is refused, never run on a guess.
 */
export async function loadRunRedirects(dataDir: string | undefined): Promise<ReadonlyMap<Slug, Slug>> {
	if (dataDir === undefined) return loadRedirects();
	const slugTable = join(dataDir, "slug-redirects.json");
	try {
		await stat(slugTable);
	} catch {
		throw new Error(`redirect table not found: ${slugTable}`);
	}
	return loadRedirects({ genre: join(dataDir, "genre-redirects.json"), slug: slugTable });
}

export interface BackfillResult {
	manifest: LandmarkManifest;
	written: string[];
	exitCode: number;
}

/** Is `work` scoped on the artist itself (`--<artist slug body>` or `--<normalized artist name>`)? */
export function scopedOnArtist(work: string, artistSlug: string, artistName: string): boolean {
	return scopeOf(work) === parseSlug(artistSlug).body || scopeMatchesArtist(work, artistName);
}

const compareLex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const hasField = (node: Record<string, unknown>, field: HighlightField): boolean =>
	node[field] !== undefined && node[field] !== null;

export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
	const { cacheDir, apply, manifestPath } = options;
	const log = options.log ?? (() => undefined);
	const cache = new NodeCache(cacheDir);
	// First of all: a table that cannot be read refuses the run before anything is decided or written.
	const redirects = await loadRunRedirects(options.dataDir);

	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	// Relative to nodes/, and without the cache dir in the message: the channel's preview and apply use
	// different scratch directories, and the manifest must not depend on where the cache sits.
	// Only an unreadable ARTIST file fails the run: it is the one thing that cannot be filled. An unreadable
	// genre / label / work file is warned about above, and a work consulted as a target is excluded as
	// `unreadable`; an unrelated corrupt file must not turn a correct apply into a refused one.
	const failed: LandmarkManifest["failed"] = invalid
		.map((entry) => ({ rel: relative(join(cacheDir, "nodes"), entry.path), error: entry.error }))
		.filter(({ rel }) => rel.startsWith("artist:"))
		.map(({ rel, error }) => ({
			slug: rel,
			reason: `unreadable node file: ${error.split(cacheDir).join("<cache>")}`,
		}));

	// Every file on disk, a corrupt one included: a target that exists but cannot be read is `unreadable`,
	// never `absent` (which would keep it eligible).
	const inCache = new Set<string>(await cache.listSlugs());

	// How many genres list each slug as a landmark, per genre list, keyed by the slug the reads resolve to.
	const genreCount: Record<(typeof HIGHLIGHT_FIELDS)[number]["genreList"], Map<string, number>> = {
		landmark_projects: new Map(),
		landmark_tracks: new Map(),
	};
	const hasImage = new Set<string>();
	for (const { slug, type, node } of nodes) {
		if (typeof node.image_url === "string" && node.image_url !== "") hasImage.add(slug);
		if (type !== "genre") continue;
		for (const { genreList } of HIGHLIGHT_FIELDS) {
			const entries = node[genreList];
			if (!Array.isArray(entries)) continue;
			// One genre counts once per target, even when it lists it twice (or under two names).
			const seen = new Set<string>();
			for (const e of entries) {
				if (!isRecord(e) || typeof e.slug !== "string") continue;
				const target = await resolveReadSlug(e.slug as Slug, redirects, cache);
				if (seen.has(target)) continue;
				seen.add(target);
				genreCount[genreList].set(target, (genreCount[genreList].get(target) ?? 0) + 1);
			}
		}
	}

	const workCache = new Map<string, Promise<NodePayload | null>>();
	const readWork = (slug: string): Promise<NodePayload | null> => {
		let hit = workCache.get(slug);
		if (!hit) {
			hit = cache.get(slug as Slug).then(
				(n) => n,
				() => null,
			);
			workCache.set(slug, hit);
		}
		return hit;
	};

	const written = { landmark_project: 0, reference_track: 0 };
	const byReason = {
		landmark_project: { genreLandmark: 0, imaged: 0, cached: 0, first: 0 },
		reference_track: { genreLandmark: 0, imaged: 0, cached: 0, first: 0 },
	};
	const skipped: Record<HighlightField, string[]> = { landmark_project: [], reference_track: [] };
	const excluded: Exclusion[] = [];
	const picks: HighlightPick[] = [];
	const writtenPaths: string[] = [];

	const artists = nodes.filter((n) => n.type === "artist");
	log(`${artists.length} artist(s), ${nodes.length - artists.length} other node(s) read`);

	for (const { slug, path, node: raw } of artists) {
		const pending = HIGHLIGHT_FIELDS.filter(({ field }) => !hasField(raw, field));
		if (pending.length === 0) continue;
		const parsed = nodePayloadSchema.safeParse(raw);
		if (!parsed.success || parsed.data.type !== "artist") {
			failed.push({
				slug,
				reason: `refusing to fill an invalid node: ${parsed.success ? "not an artist" : parsed.error.message}`,
			});
			continue;
		}
		// Same cast as the image backfill: the schema's output type differs from NodePayload only by `undefined`
		// on optional fields (exactOptionalPropertyTypes).
		const artist = parsed.data as Extract<NodePayload, { type: "artist" }>;

		const next: Record<string, unknown> = { ...raw };
		const mine: { picks: HighlightPick[]; excluded: Exclusion[]; skipped: HighlightField[] } = {
			picks: [],
			excluded: [],
			skipped: [],
		};
		for (const { field, list, genreList } of pending) {
			const entries = Array.isArray(raw[list]) ? (raw[list] as unknown[]) : [];
			const candidates: Candidate[] = [];
			const seenTargets = new Set<string>();
			for (const edge of entries) {
				// A slug listed twice is one candidate: the first occurrence wins, as the tie rule says.
				if (!isRecord(edge) || typeof edge.slug !== "string" || seenTargets.has(edge.slug)) continue;
				seenTargets.add(edge.slug);
				// What a read of this slug opens: the node itself when it is live, else one redirect hop.
				const target = await resolveReadSlug(edge.slug as Slug, redirects, cache);
				let state: TargetState = { kind: "absent" };
				if (inCache.has(target)) {
					const work = await readWork(target);
					if (work === null || (work.type !== "project" && work.type !== "track")) {
						state = { kind: "unreadable" };
					} else if ((await reciprocity(artist, work as Work, cache, redirects)) === null) {
						state = { kind: "uncredited" };
					} else {
						state = { kind: "credited", imaged: hasImage.has(target) };
					}
				} else if (target !== edge.slug && !scopedOnArtist(target, slug, artist.name)) {
					state = { kind: "redirected" };
				}
				candidates.push({
					edge,
					slug: edge.slug,
					state,
					genres: state.kind === "credited" ? (genreCount[genreList].get(target) ?? 0) : 0,
				});
			}
			const choice = choose(candidates);
			const dropped = choice.kind === "empty" ? [] : choice.excluded;
			for (const d of dropped) mine.excluded.push({ artist: slug, field, target: d.slug, reason: d.reason });
			if (choice.kind !== "chosen") {
				mine.skipped.push(field);
				continue;
			}
			next[field] = choice.edge;
			mine.picks.push({
				artist: slug,
				field,
				target: choice.slug,
				reason: choice.reason,
				score: choice.score,
			});
		}

		// Exclusions and skips are reported even when the artist gets nothing; picks only once the write is safe.
		excluded.push(...mine.excluded);
		for (const field of mine.skipped) skipped[field].push(slug);
		if (mine.picks.length === 0) continue;

		const valid = nodePayloadSchema.safeParse(next);
		if (!valid.success) {
			failed.push({ slug, reason: `refusing to write an invalid node: ${valid.error.message}` });
			continue;
		}
		if (!onlyAddsSchemaDefaults(next, valid.data)) {
			// The schema strips undeclared fields, edges' included: only the two fields may change.
			failed.push({ slug, reason: "refusing to write: validation would alter fields the node carries" });
			continue;
		}
		if (apply) {
			await atomicWriteJson(path, valid.data);
			writtenPaths.push(path);
		}
		for (const p of mine.picks) {
			picks.push(p);
			written[p.field]++;
			byReason[p.field][p.reason]++;
		}
	}

	const manifest: LandmarkManifest = {
		migration: MIGRATION_NAME,
		removed: [],
		renamed: {},
		redirects: {},
		written,
		byReason,
		skipped: {
			landmark_project: skipped.landmark_project.sort(compareLex),
			reference_track: skipped.reference_track.sort(compareLex),
		},
		excluded: excluded.sort(
			(a, b) =>
				compareLex(a.artist, b.artist) || compareLex(a.field, b.field) || compareLex(a.target, b.target),
		),
		picks: picks.sort((a, b) => compareLex(a.artist, b.artist) || compareLex(a.field, b.field)),
		failed: failed.sort((a, b) => compareLex(a.slug, b.slug)),
	};
	await mkdir(dirname(manifestPath), { recursive: true });
	await atomicWriteJson(manifestPath, manifest);
	return { manifest, written: writtenPaths, exitCode: failed.length > 0 ? 1 : 0 };
}

export function formatSummary(result: BackfillResult, apply: boolean, manifestPath: string): string {
	const { manifest, written } = result;
	const lines: string[] = [];
	for (const { field } of HIGHLIGHT_FIELDS) {
		const r = manifest.byReason[field];
		lines.push(
			`${field.padEnd(16)} ${manifest.written[field]} chosen (genreLandmark ${r.genreLandmark}, imaged ${r.imaged}, cached ${r.cached}, first ${r.first}), ${manifest.skipped[field].length} skipped`,
		);
	}
	lines.push(
		`${manifest.excluded.length} entr(ies) excluded (${EXCLUSION_REASONS.map((r) => `${manifest.excluded.filter((e) => e.reason === r).length} ${r}`).join(", ")})`,
		`${manifest.failed.length} failed`,
		apply ? `${written.length} node file(s) written` : "dry-run: no node file written",
		`manifest: ${manifestPath}`,
	);
	for (const f of manifest.failed) lines.push(`failed ${f.slug}: ${f.reason}`);
	return lines.join("\n");
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	dataDir?: string | undefined;
}

/**
 * Parses `<cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]`. `--data-dir` is the migration
 * channel's scratch copy of the redirect tables. Null (the CLI exits 2) on a missing cache-dir, a repeated
 * flag, a flag without its value (or with another flag as value) or any token no flag consumes.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let manifestPath: string | undefined;
	let dataDir: string | undefined;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--data-dir" && dataDir === undefined)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else dataDir = value;
		} else return null;
	}
	return { cacheDir, apply, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH, dataDir };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-19-backfill-landmark-highlights.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
		dataDir: args.dataDir,
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
