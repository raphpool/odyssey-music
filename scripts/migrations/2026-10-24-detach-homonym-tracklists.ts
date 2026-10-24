/**
 * Tracklists that list a namesake's track (TRA-561, plan docs/plans/graph-integrity.md). The project
 * `project:fitna--rohff` listed `track:fitna--akuma`, a 2023 track by Akuma and AXMO: "I click a track and land
 * on another track of the same name", from an album page. The audit metric `homonym-tracklist-links`
 * (scripts/audit-cache.ts) counts these entries; this migration repairs the ones it counted on 2026-10-24.
 * Offline and deterministic: no network, no LLM, no clock. To run after the identity migrations (TRA-483/484).
 *
 * A CLOSED list (`DETACHMENTS`), not a rule: the code never decides on its own that an entry is wrong. Each item
 * names the project and the track, carries the credits both had when the list was written, and says why they are
 * different artists (`proof`). At run time an item is applied only if
 *   - the project still lists the track and the track is in the cache,
 *   - both credits are still the ones the item names (a node that moved on since is not the proof's node), and
 *   - the audit's own predicate (`isHomonymTracklistTarget`) still counts the entry: same code as the metric, so
 *     the migration and the ceiling cannot disagree on what a homonym link is.
 * Anything else is left as it is and reported (`skipped`, `absent`, `alreadyDone`).
 *
 * Two actions, and the choice is the proof's, never a default:
 *   - `retarget`: the right track is a node of the cache, credited to the project's artist (or a related act):
 *     the entry points at it. Only when that node exists and is not itself a homonym of the project.
 *   - `detach`: no right track in the cache. The entry is rewritten to the scoped slug of the project's artist
 *     (`track:<title>--<artist>`, a dangling target materialized on demand, the model of TRA-478's detachments),
 *     with its `artist` hint, so the page keeps its tracklist and the click no longer resolves to the namesake.
 *     `scope: null` removes the entry instead, when the project credits several artists and none is proved to be
 *     the performer (a compilation): scoping it on the first credit would mint the wrong credit later.
 *     An existing node at the scoped slug must be credited to that artist (facetsDisagreement of TRA-478).
 *
 * The namesake's track is not touched, with ONE exception: when its `project` edge points at the project it was
 * wrongly listed on, that edge is the reverse of the bad link (the backfill of TRA-486 wrote it) and is removed,
 * or the track would keep a project that does not list it (`reciprocity-missing`, a ceilinged metric). Its other
 * fields are not read for repair here (its cover, copied from the album, is TRA-591).
 *
 * `KEPT`: entries the metric counts and this migration deliberately leaves, with the reason. Listed in the
 * manifest, and they are what the ceiling holds after the run.
 *
 * Writes go through atomicWriteJson after nodePayloadSchema validation, never NodeCache.write (which would emit
 * reverse edges). Before the first write the plan must pass a guard: the only differences with the cache are the
 * `tracklist` of a listed project and the `project` of a listed track, and no rewritten entry resolves to a
 * homonym. One invalid node or one violation = nothing written (exit 1 in a dry-run, 2 with --apply).
 * Idempotent: a repaired entry is no longer on the project. Entries the metric counts and that are on neither
 * list are reported (`unlisted`), never touched.
 *
 * Migration channel (deploy/sync-genre-cache.sh): `--apply`, `--manifest` and `--data-dir` are what it passes
 * (`--data-dir` is accepted and ignored: no redirect table is read or written); `removed`, `renamed` and
 * `redirects` are always empty, no file is deleted or renamed. The manifest holds no timestamp: two runs on the
 * same cache give the same bytes. ODYSSEY_SCOPED_RELEASE_SLUGS must be on (the scoped slug depends on it): the
 * channel sets it.
 *
 * Usage: ODYSSEY_SCOPED_RELEASE_SLUGS=1 tsx scripts/migrations/2026-10-24-detach-homonym-tracklists.ts <cache-dir>
 *        [--apply] [--manifest out/detach-homonym-tracklists.json] [--data-dir <dir>]
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJson } from "../../src/cache.js";
import { scopedReleaseSlugsEnabled } from "../../src/flags.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { makeScopedSlug, pickScopeArtistName } from "../../src/slug.js";
import { isHomonymTracklistTarget, type RawNode } from "../audit-cache.js";
import {
	type CacheNodeFile,
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";
import { facetsDisagreement } from "./2026-10-16-scope-release-slugs.js";

export const MIGRATION_NAME = "2026-10-24-detach-homonym-tracklists";
export const DEFAULT_MANIFEST_PATH = "out/detach-homonym-tracklists.json";

type Obj = Record<string, unknown>;

interface ListedBase {
	project: string;
	track: string;
	/** Credit slugs of the project and of the track when the list was written: the nodes the proof is about. */
	projectCredit: readonly string[];
	trackCredit: readonly string[];
	/** Why they are different artists, from what the cache says. */
	proof: string;
}
export type Listed =
	| (ListedBase & { action: "detach"; scope: string | null })
	| (ListedBase & { action: "retarget"; to: string });

export interface KeptEntry {
	project: string;
	track: string;
	why: string;
}

/** One project of the list, with the credit it had and the entries to repair. */
interface ProjectProof {
	project: string;
	credit: readonly string[];
	/** The credited artist the entries are scoped on, or null: the entries are removed. */
	scope: string | null;
	tracks: readonly { track: string; credit: readonly string[]; proof: string }[];
}

const KOSMISCHER =
	"an album by Jan Jelinek (2005); the target is a track of another artist, dated and attached to another project in the cache";

/** Measured on the repo cache on 2026-10-24 (19 entries counted by the metric): 17 detached, 2 kept. */
const PROJECTS: readonly ProjectProof[] = [
	{
		project: "project:aksel--123",
		credit: ["artist:123"],
		scope: "artist:123",
		tracks: [
			{
				track: "track:the-owl--benjamin-britten",
				credit: ["artist:benjamin-britten"],
				proof: "credited to Benjamin Britten, dated 1929, no project: unrelated to the 2009 album by 123",
			},
			{
				track: "track:the-ending--ellie-goulding",
				credit: ["artist:ellie-goulding"],
				proof: "credited to Ellie Goulding, 2012, whose own project edge is project:halcyon--ellie-goulding",
			},
		],
	},
	{
		project: "project:ambient-1-music-for-airports--brian-eno",
		credit: ["artist:brian-eno"],
		scope: "artist:brian-eno",
		tracks: [
			{
				track: "track:1-2--aphex-twin",
				credit: ["artist:aphex-twin"],
				proof:
					"credited to Aphex Twin, whose project edge is project:selected-ambient-works-volume-ii--aphex-twin",
			},
		],
	},
	{
		project: "project:ambient-4-on-land--brian-eno",
		credit: ["artist:brian-eno"],
		scope: "artist:brian-eno",
		tracks: [
			{
				track: "track:shadow--chromatics",
				credit: ["artist:chromatics"],
				proof:
					"credited to Chromatics, 2015, project:2015-adult-swim-singles-program; the album is from 1982",
			},
		],
	},
	{
		// Seven credited artists, none of them Moodswings: which one performs the piece is not proved, and a scope
		// on the first credit would mint the wrong credit when the track is materialized.
		project: "project:artificial-intelligence",
		credit: [
			"artist:aphex-twin",
			"artist:autechre",
			"artist:the-black-dog",
			"artist:speedy-j",
			"artist:richie-hawtin",
			"artist:b12",
			"artist:alex-paterson",
		],
		scope: null,
		tracks: [
			{
				track: "track:spiritual-high--moodswings",
				credit: ["artist:moodswings", "artist:chrissie-hynde"],
				proof:
					"credited to Moodswings and Chrissie Hynde, 1991, no project; none of the compilation's artists",
			},
		],
	},
	{
		project: "project:electronic-meditation--tangerine-dream",
		credit: ["artist:tangerine-dream"],
		scope: "artist:tangerine-dream",
		tracks: [
			{
				track: "track:ashes-to-ashes--david-bowie",
				credit: ["artist:david-bowie"],
				proof: "credited to David Bowie, 1980, project:scary-monsters; the album is from 1970",
			},
		],
	},
	{
		project: "project:fitna--rohff",
		credit: ["artist:rohff"],
		scope: "artist:rohff",
		tracks: [
			{
				track: "track:fitna--akuma",
				credit: ["artist:akuma", "artist:axmo"],
				proof:
					"credited to Akuma and AXMO, 2023, no mbid; the album is Rohff's 2024 one. Its project edge is the reverse of this bad link",
			},
		],
	},
	{
		project: "project:grand-monsieur--madame-monsieur",
		credit: ["artist:madame-monsieur"],
		scope: "artist:madame-monsieur",
		tracks: [
			{
				track: "track:mercy--steve-jones",
				credit: ["artist:steve-jones"],
				proof: "credited to Steve Jones, 1987, project:mercy; the album is from 2018",
			},
			{
				track: "track:comme-une-reine--issa-el-saieh-and-his-orchestra",
				credit: ["artist:issa-el-saieh-and-his-orchestra"],
				proof:
					"credited to Issa El Saieh and His Orchestra, 1947, project:la-belle-creole; the album is from 2018",
			},
		],
	},
	{
		project: "project:kosmischer-pitch--jan-jelinek",
		credit: ["artist:jan-jelinek"],
		scope: "artist:jan-jelinek",
		tracks: [
			{
				track: "track:universal-band-silhouette--silhouette",
				credit: ["artist:silhouette"],
				proof: `Kosmischer Pitch is ${KOSMISCHER} (2024, project:silhouette)`,
			},
			{
				track: "track:lemminge-und-lurchen-inc--lemming",
				credit: ["artist:lemming"],
				proof: `Kosmischer Pitch is ${KOSMISCHER} (1970, project:lemming)`,
			},
			{
				track: "track:vibraphonspulen--vibraphonic",
				credit: ["artist:vibraphonic"],
				proof: `Kosmischer Pitch is ${KOSMISCHER} (1993, project:vibraphonic)`,
			},
			{
				track: "track:western-mimikry--blixa-bargeld",
				credit: ["artist:blixa-bargeld", "artist:alva-noto"],
				proof: `Kosmischer Pitch is ${KOSMISCHER} (Blixa Bargeld and Alva Noto, 2010, project:mimikry)`,
			},
			{
				track: "track:morphing-leadgitarre-ruckwarts--the-beatles",
				credit: ["artist:the-beatles"],
				proof: `Kosmischer Pitch is ${KOSMISCHER} (The Beatles, 1966, project:revolver)`,
			},
		],
	},
	{
		project: "project:loop-finding-jazz-records--jan-jelinek",
		credit: ["artist:jan-jelinek"],
		scope: "artist:jan-jelinek",
		tracks: [
			{
				track: "track:drift--underworld",
				credit: ["artist:underworld"],
				proof: "credited to Underworld, whose project edge is project:drift-series-1--underworld",
			},
		],
	},
	{
		project: "project:polyester--lisa-carbon",
		credit: ["artist:lisa-carbon", "artist:the-lisa-carbon-trio"],
		scope: "artist:lisa-carbon",
		tracks: [
			{
				track: "track:stereo-cocktail--malibu-mode7",
				credit: ["artist:malibu-mode7"],
				proof: "credited to Malibu Mode7, project:blue-crush; the album credits Lisa Carbon and her trio",
			},
		],
	},
	{
		project: "project:selected-ambient-works-volume-ii--aphex-twin",
		credit: ["artist:aphex-twin"],
		scope: "artist:aphex-twin",
		tracks: [
			{
				track: "track:tassels--elle-mcandrews",
				credit: ["artist:elle-mcandrews"],
				proof: "credited to Elle McAndrews, dated 2024, no project: the album is from 1994",
			},
		],
	},
];

export const DETACHMENTS: readonly Listed[] = PROJECTS.flatMap((p) =>
	p.tracks.map(
		(t): Listed => ({
			action: "detach",
			project: p.project,
			projectCredit: p.credit,
			track: t.track,
			trackCredit: t.credit,
			scope: p.scope,
			proof: t.proof,
		}),
	),
);

/** Counted by the metric, left on purpose: the ceiling after the run is the length of this list. */
export const KEPT: readonly KeptEntry[] = [
	{
		project: "project:bytes--the-black-dog",
		track: "track:focus-mel--atypic",
		why: "Atypic is not linked to The Black Dog in the cache, but the track carries a MusicBrainz recording (mbid and credit mbid), the album's year (1993), and its project edge is this album, which lists it: the credit is a release-level act name, not a namesake",
	},
	{
		project: "project:bytes--the-black-dog",
		track: "track:fight-the-hits--discordian-popes",
		why: "same evidence as focus-mel--atypic: MusicBrainz recording, year 1993 = the album's, reciprocal project edge",
	},
];

// --- Manifest ---

export interface EdgeChange {
	project: string;
	track: string;
	action: "detach" | "retarget";
	/** The slug the entry now has, or null when it was removed. */
	to: string | null;
	/** The track's `project` edge (the reverse of the bad link) was removed. */
	mirrorRemoved: boolean;
	/** The entry was removed because the project already listed the slug it would have taken. */
	folded: boolean;
}
export interface Reported {
	project: string;
	track: string;
	reason: string;
}
export interface Manifest {
	migration: string;
	mode: "dry-run" | "apply";
	blocked: boolean;
	/** The channel's contract: nothing is deleted, renamed or redirected. */
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	written: number;
	changes: EdgeChange[];
	/** Entries the list names that were not on the project any more. */
	alreadyDone: string[];
	/** The project or the track is not in this cache: nothing to judge. */
	absent: Reported[];
	/** On the list but not applied: the nodes no longer match the proof, or the entry is no longer counted. */
	skipped: Reported[];
	kept: KeptEntry[];
	/** Counted by the metric after the plan, on neither list: reported, never touched. */
	unlisted: string[];
	errors: string[];
}

export interface Plan {
	writes: Map<string, Obj>;
	manifest: Manifest;
}

// --- Plan ---

const caseKey = (project: string, track: string): string => `${project} tracklist ${track}`;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const foldName = (name: string): string => name.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

function listOf(value: unknown): Obj[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}
function creditSlugs(node: Obj): string[] {
	return listOf(node.artists).flatMap((e) => str(e.slug) ?? []);
}
function firstCreditFacet(node: Obj): { slug: string; mbid: string | undefined; credit: string } {
	const first = listOf(node.artists)[0];
	return { slug: "node", mbid: str(first?.mbid), credit: foldName(str(first?.name) ?? "") };
}

/** Every entry the metric counts on these nodes, in cache order, as `caseKey`s. */
function homonymEntries(nodes: ReadonlyMap<string, RawNode>): string[] {
	const out: string[] = [];
	for (const [slug, node] of nodes) {
		if (!slug.startsWith("project:")) continue;
		for (const entry of listOf(node.tracklist)) {
			const target = str(entry.slug);
			const track = target?.startsWith("track:") ? nodes.get(target) : undefined;
			if (target && track && isHomonymTracklistTarget(nodes, node, track)) out.push(caseKey(slug, target));
		}
	}
	return out;
}

export function planDetachments(
	files: readonly CacheNodeFile[],
	cases: readonly Listed[] = DETACHMENTS,
	kept: readonly KeptEntry[] = KEPT,
): Plan {
	const original = new Map<string, Obj>(files.map((f) => [f.slug, f.node]));
	const pathOf = new Map(files.map((f) => [f.slug, f.path]));
	const manifest: Manifest = {
		migration: MIGRATION_NAME,
		mode: "dry-run",
		blocked: false,
		removed: [],
		renamed: {},
		redirects: {},
		written: 0,
		changes: [],
		alreadyDone: [],
		absent: [],
		skipped: [],
		kept: [],
		unlisted: [],
		errors: [],
	};
	// Working copies, only for the nodes this plan changes. Every judgement reads `original`, so the order of the
	// list does not matter.
	const work = new Map<string, Obj>();
	const edit = (slug: string): Obj => {
		const existing = work.get(slug);
		if (existing) return existing;
		const copy = { ...(original.get(slug) as Obj) };
		work.set(slug, copy);
		return copy;
	};

	for (const item of cases) {
		const project = original.get(item.project);
		const track = original.get(item.track);
		const skip = (reason: string): void =>
			void manifest.skipped.push({ project: item.project, track: item.track, reason });
		if (!project || !track) {
			if (project && !listOf(project.tracklist).some((e) => e.slug === item.track)) {
				manifest.alreadyDone.push(caseKey(item.project, item.track));
			} else {
				manifest.absent.push({ project: item.project, track: item.track, reason: "not in this cache" });
			}
			continue;
		}
		if (!listOf(project.tracklist).some((e) => e.slug === item.track)) {
			manifest.alreadyDone.push(caseKey(item.project, item.track));
			continue;
		}
		if (
			!isDeepStrictEqual(creditSlugs(project), item.projectCredit) ||
			!isDeepStrictEqual(creditSlugs(track), item.trackCredit)
		) {
			skip(
				`credits are ${creditSlugs(project).join("+")} / ${creditSlugs(track).join("+")}, not the ones of the proof`,
			);
			continue;
		}
		if (!isHomonymTracklistTarget(original, project, track)) {
			skip("the audit no longer counts this entry");
			continue;
		}

		let to: string | null;
		let nextName: string | undefined;
		if (item.action === "retarget") {
			const right = original.get(item.to);
			if (!right || !item.to.startsWith("track:") || isHomonymTracklistTarget(original, project, right)) {
				manifest.errors.push(
					`${caseKey(item.project, item.track)}: retarget ${item.to} is not a track credited to the project's artist`,
				);
				continue;
			}
			to = item.to;
			nextName = str(listOf(right.artists)[0]?.name);
		} else if (item.scope === null) {
			to = null;
		} else {
			const credit = listOf(project.artists).find((e) => e.slug === item.scope);
			const scopeName = pickScopeArtistName([str(credit?.name)]);
			const edgeName = str(listOf(project.tracklist).find((e) => e.slug === item.track)?.name);
			const scoped = scopeName && edgeName ? makeScopedSlug("track", edgeName, scopeName) : null;
			if (!credit || !scopeName || !scoped?.ok) {
				manifest.errors.push(`${caseKey(item.project, item.track)}: no scoped slug (scope ${item.scope})`);
				continue;
			}
			// A node already at the scoped slug must be credited to this artist, else the click would land on
			// another namesake (TRA-478, path 4).
			const clash = original.get(scoped.slug);
			const why = clash
				? facetsDisagreement([
						{ slug: "scope", mbid: str(credit.mbid), credit: foldName(scopeName) },
						firstCreditFacet(clash),
					])
				: null;
			if (why !== null) {
				manifest.errors.push(`${caseKey(item.project, item.track)}: ${scoped.slug} exists and ${why}`);
				continue;
			}
			to = scoped.slug;
			nextName = scopeName;
		}

		const copy = edit(item.project);
		const entries = listOf(copy.tracklist);
		const folded = to !== null && entries.some((e) => e.slug === to);
		copy.tracklist = entries.flatMap((e): Obj[] => {
			if (e.slug !== item.track) return [e];
			if (to === null || folded) return [];
			const { mbid: _dropped, ...rest } = e;
			return [{ ...rest, slug: to, ...(nextName === undefined ? {} : { artist: nextName }) }];
		});
		const mirror = isRecord(track.project) && track.project.slug === item.project;
		if (mirror) {
			const { project: _mirror, ...withoutProject } = edit(item.track);
			work.set(item.track, withoutProject);
		}
		manifest.changes.push({
			project: item.project,
			track: item.track,
			action: item.action,
			to,
			mirrorRemoved: mirror,
			folded,
		});
	}

	const writes = new Map<string, Obj>();
	const changedProjects = new Set(manifest.changes.map((c) => c.project));
	const changedTracks = new Set(manifest.changes.filter((c) => c.mirrorRemoved).map((c) => c.track));
	for (const [slug, next] of work) {
		const before = original.get(slug) as Obj;
		// The guard: only the field this migration owns on this kind of node may differ.
		const field = slug.startsWith("project:") ? "tracklist" : "project";
		const allowed = slug.startsWith("project:") ? changedProjects.has(slug) : changedTracks.has(slug);
		const { [field]: _a, ...restBefore } = before;
		const { [field]: _b, ...restNext } = next;
		if (!allowed || !isDeepStrictEqual(restBefore, restNext)) {
			manifest.errors.push(`${slug}: the plan changes more than ${field}`);
			continue;
		}
		const parsed = nodePayloadSchema.safeParse(next);
		if (!parsed.success) {
			manifest.errors.push(`${slug}: would not validate: ${parsed.error.message}`);
		} else if (!onlyAddsSchemaDefaults(next, parsed.data)) {
			manifest.errors.push(`${slug}: validation would alter fields (the schema strips undeclared ones)`);
		} else {
			const path = pathOf.get(slug);
			if (path) writes.set(path, parsed.data as unknown as Obj);
		}
	}

	// The invariant, on the plan as a whole: no rewritten entry resolves to a homonym, and what the metric still
	// counts is exactly the lists' leftovers.
	const after = new Map<string, RawNode>(original);
	for (const [slug, next] of work) after.set(slug, next);
	for (const change of manifest.changes) {
		const target = change.to ? after.get(change.to) : undefined;
		const project = after.get(change.project);
		if (target && project && isHomonymTracklistTarget(after, project, target)) {
			manifest.errors.push(
				`${caseKey(change.project, change.track)}: ${change.to} is a homonym of the project`,
			);
		}
	}
	const keptKeys = new Set(kept.map((k) => caseKey(k.project, k.track)));
	const listedKeys = new Set(cases.map((c) => caseKey(c.project, c.track)));
	const remaining = homonymEntries(after);
	manifest.kept = kept.filter((k) => remaining.includes(caseKey(k.project, k.track)));
	manifest.unlisted = remaining.filter((k) => !keptKeys.has(k) && !listedKeys.has(k));
	manifest.written = writes.size;
	manifest.blocked = manifest.errors.length > 0;
	if (manifest.blocked) writes.clear();
	return { writes, manifest };
}

// --- Run ---

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	/** The list to apply; the closed list above unless a test brings its own. */
	cases?: readonly Listed[];
}

export async function runMigration(options: RunOptions): Promise<{ manifest: Manifest; exitCode: number }> {
	const { nodes, invalid } = await readCacheNodes(options.cacheDir);
	warnSkippedNodeFiles(invalid);
	const plan = planDetachments(nodes, options.cases);
	const manifest = plan.manifest;
	if (!scopedReleaseSlugsEnabled()) {
		manifest.errors.push(
			"ODYSSEY_SCOPED_RELEASE_SLUGS is off: the scoped slugs depend on it. Refusing to run.",
		);
	}
	for (const entry of invalid) manifest.errors.push(`unreadable node file ${entry.path}: ${entry.error}`);
	manifest.blocked = manifest.errors.length > 0;
	if (options.apply) manifest.mode = "apply";
	if (options.apply && !manifest.blocked) {
		for (const [path, node] of plan.writes) await atomicWriteJson(path, node);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: manifest.blocked ? (options.apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	const count = (label: string, n: number): number => lines.push(`  ${label.padEnd(36)} ${n}`);
	count("entries detached or retargeted", manifest.changes.length);
	count("track mirrors removed", manifest.changes.filter((c) => c.mirrorRemoved).length);
	count("node files written", manifest.written);
	count("already done", manifest.alreadyDone.length);
	count("absent from this cache", manifest.absent.length);
	count("skipped (proof no longer holds)", manifest.skipped.length);
	count("kept on purpose", manifest.kept.length);
	count("counted, on neither list", manifest.unlisted.length);
	for (const s of manifest.skipped) lines.push(`skipped: ${caseKey(s.project, s.track)}: ${s.reason}`);
	for (const u of manifest.unlisted) lines.push(`unlisted: ${u}`);
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

/** `<cache-dir> [--apply] [--manifest p] [--data-dir d]`; null (exit 2) on anything else. `--data-dir` is the channel's, ignored. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let manifestPath: string | undefined;
	let dataDirSeen = false;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--data-dir" && !dataDirSeen)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else dataDirSeen = true;
		} else return null;
	}
	return { cacheDir, apply, manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH };
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
