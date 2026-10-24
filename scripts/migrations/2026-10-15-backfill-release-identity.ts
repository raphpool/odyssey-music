/**
 * Release identity backfill (TRA-474, plan docs/plans/graph-integrity.md, part 1): give every
 * project and track the MusicBrainz identity it lacks. For each work without an `mbid`:
 *  1. find the artist to look it up under (hint): its own first credit, else the one cache artist
 *     whose discography / notable_tracks (or, for a track, whose project's tracklist) points at it;
 *     several distinct artists and no credit of its own = `ambiguous`, node untouched; no artist at
 *     all = `unresolved` without asking MusicBrainz (a bare title is not an identity);
 *  2. resolve it to ONE MB release group / recording (exact title, credit confirmed against the
 *     hint: safety over resolution rate, anything else is `unresolved` and the node stays intact);
 *  3. write `mbid`, `artists` (the MB credit, each artist pointing at the cache node that carries
 *     its MBID, so a credit in the original script ("坂本龍一") still lands on the existing Latin
 *     slug), `year` / `release_type` when absent, and from one more MB call the project's
 *     `tracklist` and `label`, the track's `project` and `label`.
 * Nothing is renamed, merged or re-slugged here (1.12 does that from the credit written here), no
 * reverse edge is emitted, no LLM is involved.
 *
 * Dry-run by default: the manifest is written, node files are not (and the second MB call is not
 * made). `--apply` writes the nodes. The manifest is a checkpoint too: `--resume` reuses its
 * resolved entries, so an interrupted run or an `--apply` after a dry-run does not repeat the
 * searches. Idempotent: a work that carries an `mbid` is never selected again, and the manifest
 * keeps the entries of works already written, since 1.12 reads the credit from it.
 *
 * MusicBrainz outage: the resolvers and the metadata lookups say it themselves, with `unavailable`
 * (TRA-505), true when MB gave no usable answer: HTTP error, network error, a 200 whose body is not
 * JSON, or a 200 whose JSON is off schema. Any of the four during a node's lookups makes it
 * `failed` (exit 1, node untouched, retried by --resume), never `unresolved`. "No candidate" and
 * "ambiguous" are answers, not outages. So is a 404 on the mbid just found (TRA-532, 2026-10-24): the
 * entity was deleted, or was never there; it is `unresolved` as "mbid-not-found" (exit 0, node untouched,
 * entry dropped from `resolved`) and the work is searched again next run, instead of failing every resume.
 *
 * Writes go through atomicWriteJson after nodePayloadSchema validation, never NodeCache.write, which
 * would also emit pending reverse edges this migration has no business creating.
 *
 * Pace: one MusicBrainz request per second (mbFetch enforces it); a work costs one search and, with
 * --apply, up to two more requests: 537 works take about twenty minutes.
 *
 * Usage: tsx scripts/migrations/2026-10-15-backfill-release-identity.ts <cache-dir> [--apply]
 *        [--manifest out/release-identity.json] [--artist-manifest out/artist-identity.json]
 *        [--resume] [--limit N] [--data-dir <dir>]
 *
 * Migration channel (deploy/sync-genre-cache.sh, TRA-568): `--data-dir` is accepted and unused (nothing
 * is renamed here), and the manifest carries the channel's constant fields: `migration`, `removed: []`,
 * `renamed: {}`, `redirects: {}`.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../../src/cache.js";
import { musicBrainzConfig } from "../../src/config.js";
import {
	fetchProjectMetaDetailedMb,
	fetchTrackMetaDetailedMb,
	type MbCredit,
	type MbProjectMeta,
	type MbReleaseIdentity,
	type MbTrackMeta,
	resolveRecordingDetailed,
	resolveReleaseGroupDetailed,
	sameCreditName,
} from "../../src/musicbrainz.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { makeScopedSlug, makeSlug, normalizeSlugBody, pickScopeArtistName } from "../../src/slug.js";
import {
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-15-backfill-release-identity";
export const DEFAULT_MANIFEST_PATH = "out/release-identity.json";
export const DEFAULT_ARTIST_MANIFEST_PATH = "out/artist-identity.json";

/** A work costs a search, then (with --apply) up to two more requests. */
const CALLS_PER_WORK = 3;
/** The manifest is rewritten this often during a run, so a crash loses little. */
const CHECKPOINT_EVERY = 25;
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** MusicBrainz's special-purpose label "[no label]". */
const NO_LABEL_MBID = "157afde4-4bf5-4039-8ad2-5a15acc85176";
const RELEASE_TYPES = ["album", "ep", "single"] as const;
type ReleaseType = (typeof RELEASE_TYPES)[number];

type Edge = Record<string, unknown>;

export interface ResolvedWork {
	mbid: string;
	/** The MB artist credit, MB order, MBIDs included: what 1.12 scopes the slug with. */
	credit: MbCredit[];
	/** What MB calls the work and the artist it was looked up under, kept for the TRA-483 audit. */
	title: string;
	hint: string;
	year: string | null;
	release_type: ReleaseType | null;
	/** Optional parts that could not be filled (no Latin artist name for a slug, label homonym...). */
	notes?: string[];
}

export type UnresolvedReason =
	| "no-hint"
	| "no-match"
	| "credit-mismatch"
	| "ambiguous-candidates"
	| "year-mismatch"
	| "unmappable-credit"
	| "mbid-not-found";

export interface UnresolvedWork {
	slug: string;
	name: string;
	hint: string;
	reason: UnresolvedReason;
}

export interface AmbiguousWork {
	slug: string;
	candidates: string[];
	reason: "several-artists-point-here" | "several-artist-nodes-share-the-credit-mbid";
}

export interface ReleaseManifest {
	/** The channel's manifest contract (TRA-568): this migration deletes and renames nothing. */
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	generated_at: string;
	resolved: Record<string, ResolvedWork>;
	unresolved: UnresolvedWork[];
	ambiguous: AmbiguousWork[];
	/** Two or more works on the same MBID (written or resolved): left for the merge step (1.12). */
	collisions: { mbid: string; slugs: string[] }[];
}

export interface BackfillOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	/** Where the artist backfill (TRA-463) left its manifest; absent file = rely on the cache's own mbids. */
	artistManifestPath?: string;
	/** True when the path above was given by the operator: a missing file is then an error. */
	artistManifestRequired?: boolean;
	/** Maximum number of works searched on MusicBrainz in this run; entries reused by --resume are free. */
	limit?: number;
	resume?: boolean;
	log?: (line: string) => void;
	/**
	 * TRA-485 (2026-10-24): restrict the run to these works instead of every work without an mbid, so that the
	 * 89 works left with `artists: []` can be looked up without paying for the other 189.
	 */
	only?: ReadonlySet<string>;
	/**
	 * TRA-485: artist to look a work up under when neither its own credit nor the artists pointing at it give
	 * one (a judged hint, checked by MusicBrainz exactly like any other: exact title, credit confirms the hint,
	 * year agrees). Wins over the pointers.
	 */
	hints?: ReadonlyMap<string, { name: string; mbid?: string }>;
	/**
	 * TRA-485: more artists pointing at a work than the artists' own lists (a credited track naming this project
	 * as its own, the credit of a track's project). Merged into the cache's pointers before any hint is read.
	 */
	extraPointers?: ReadonlyMap<string, ReadonlyMap<string, { name: string; mbid?: string }>>;
	/**
	 * TRA-485: with --apply, write the credit (`artists`) and the work's `mbid`, nothing else: no tracklist, label,
	 * year or release type, so no second MusicBrainz call per work. The mbid is written because the reverse edge of
	 * the new credit (artist.discography) carries it, and an edge without one is a hole of its own
	 * (`artist-discography-without-mbid`).
	 */
	creditOnly?: boolean;
}

export interface BackfillResult {
	manifest: ReleaseManifest;
	/** Node files written (always empty without --apply). */
	written: string[];
	/** Left untouched and not reported as unresolved: MB did not answer, or the write was refused. */
	failed: { slug: string; reason: string }[];
	exitCode: 0 | 1;
}

// --- Manifest I/O ---

function isCreditList(value: unknown): value is MbCredit[] {
	return (
		Array.isArray(value) &&
		value.every(
			(c) => isRecord(c) && typeof c.mbid === "string" && MBID_RE.test(c.mbid) && typeof c.name === "string",
		)
	);
}

function isResolvedWork(value: unknown): value is ResolvedWork {
	return (
		isRecord(value) &&
		typeof value.mbid === "string" &&
		MBID_RE.test(value.mbid) &&
		isCreditList(value.credit) &&
		typeof value.title === "string" &&
		typeof value.hint === "string" &&
		(value.year === null || typeof value.year === "string") &&
		(value.release_type === null || (RELEASE_TYPES as readonly unknown[]).includes(value.release_type))
	);
}

/** Reads a previous manifest. Null when absent; throws when present but unusable (never overwrite it blind). */
async function readManifest(path: string): Promise<ReleaseManifest | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.resolved) || !Array.isArray(parsed.unresolved)) {
		throw new Error(`${path} is not a release-identity manifest`);
	}
	const resolved: Record<string, ResolvedWork> = {};
	for (const [slug, entry] of Object.entries(parsed.resolved)) {
		if (isResolvedWork(entry)) resolved[slug] = entry;
	}
	const reasons: readonly unknown[] = [
		"no-hint",
		"no-match",
		"credit-mismatch",
		"ambiguous-candidates",
		"year-mismatch",
		"unmappable-credit",
		"mbid-not-found",
	];
	const ambiguousReasons: readonly unknown[] = [
		"several-artists-point-here",
		"several-artist-nodes-share-the-credit-mbid",
	];
	return {
		...CHANNEL_FIELDS(),
		generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : "",
		resolved,
		unresolved: parsed.unresolved.flatMap((u: unknown) =>
			isRecord(u) &&
			typeof u.slug === "string" &&
			typeof u.name === "string" &&
			typeof u.hint === "string" &&
			reasons.includes(u.reason)
				? [{ slug: u.slug, name: u.name, hint: u.hint, reason: u.reason as UnresolvedReason }]
				: [],
		),
		ambiguous: (Array.isArray(parsed.ambiguous) ? parsed.ambiguous : []).flatMap((a: unknown) =>
			isRecord(a) &&
			typeof a.slug === "string" &&
			Array.isArray(a.candidates) &&
			a.candidates.every((c: unknown) => typeof c === "string") &&
			ambiguousReasons.includes(a.reason)
				? [
						{
							slug: a.slug,
							candidates: a.candidates as string[],
							reason: a.reason as AmbiguousWork["reason"],
						},
					]
				: [],
		),
		collisions: [],
	};
}

export interface ArtistManifestEntry {
	mbid: string;
	/** MBIDs of the bands the artist belongs to (a credit to the band stands for the member). */
	groups: string[];
}

/** slug -> identity of the artist manifest's resolved entries. Throws on a manifest it cannot read. */
async function readArtistManifest(
	path: string,
	required: boolean,
): Promise<Map<string, ArtistManifestEntry> | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT" && !required) return null;
		throw new Error(`cannot read the artist manifest ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.resolved)) {
		throw new Error(`${path} is not an artist-identity manifest`);
	}
	const out = new Map<string, ArtistManifestEntry>();
	for (const [slug, entry] of Object.entries(parsed.resolved)) {
		if (!isRecord(entry) || typeof entry.mbid !== "string" || !MBID_RE.test(entry.mbid)) continue;
		const groups = (Array.isArray(entry.groups) ? entry.groups : []).flatMap((g: unknown) =>
			isRecord(g) && typeof g.mbid === "string" && MBID_RE.test(g.mbid) ? [g.mbid] : [],
		);
		out.set(slug, { mbid: entry.mbid, groups });
	}
	return out;
}

function bySlug<T extends { slug: string }>(a: T, b: T): number {
	return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** Slugs sharing an mbid, among the works already carrying one and the ones resolved now. */
export function findCollisions(
	resolved: Record<string, ResolvedWork>,
	stored: ReadonlyMap<string, string>,
): ReleaseManifest["collisions"] {
	const byMbid = new Map<string, Set<string>>();
	const add = (mbid: string, slug: string) => byMbid.set(mbid, (byMbid.get(mbid) ?? new Set()).add(slug));
	for (const [slug, mbid] of stored) add(mbid, slug);
	for (const [slug, entry] of Object.entries(resolved)) add(entry.mbid, slug);
	return [...byMbid.entries()]
		.filter(([, slugs]) => slugs.size > 1)
		.map(([mbid, slugs]) => ({ mbid, slugs: [...slugs].sort() }))
		.sort((a, b) => (a.mbid < b.mbid ? -1 : a.mbid > b.mbid ? 1 : 0));
}

const CHANNEL_FIELDS = () => ({ migration: MIGRATION_NAME, removed: [], renamed: {}, redirects: {} });

function buildManifest(
	resolved: Record<string, ResolvedWork>,
	unresolved: UnresolvedWork[],
	ambiguous: AmbiguousWork[],
	stored: ReadonlyMap<string, string>,
): ReleaseManifest {
	const sorted: Record<string, ResolvedWork> = {};
	for (const slug of Object.keys(resolved).sort()) sorted[slug] = resolved[slug] as ResolvedWork;
	return {
		...CHANNEL_FIELDS(),
		generated_at: new Date().toISOString(),
		resolved: sorted,
		unresolved: [...unresolved].sort(bySlug),
		ambiguous: [...ambiguous].sort(bySlug),
		collisions: findCollisions(sorted, stored),
	};
}

async function writeManifest(path: string, manifest: ReleaseManifest): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await atomicWriteJson(path, manifest);
}

// --- Cache context ---

interface ArtistInfo {
	name: string;
	mbid?: string;
}

interface Pointer {
	name: string;
	mbid?: string;
}

export interface Context {
	artists: Map<string, ArtistInfo>;
	artistSlugsByMbid: Map<string, string[]>;
	labels: Map<string, ArtistInfo>;
	labelSlugsByMbid: Map<string, string[]>;
	/** work slug -> artist slug -> the artist pointing at it. */
	pointers: Map<string, Map<string, Pointer>>;
	/** mbid of the project/track nodes that already carry one. */
	storedWorkMbids: Map<string, string>;
	/** artist mbid -> mbids of the bands it belongs to, from the artist manifest. */
	groupsByMbid: Map<string, string[]>;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function validMbid(value: unknown): string | undefined {
	return typeof value === "string" && MBID_RE.test(value) ? value : undefined;
}

function edges(value: unknown): Edge[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	map.set(key, [...(map.get(key) ?? []), value]);
}

function buildContext(
	nodes: { slug: string; type: string; node: Record<string, unknown> }[],
	artistManifest: ReadonlyMap<string, ArtistManifestEntry> | null,
): Context {
	const ctx: Context = {
		artists: new Map(),
		artistSlugsByMbid: new Map(),
		labels: new Map(),
		labelSlugsByMbid: new Map(),
		pointers: new Map(),
		storedWorkMbids: new Map(),
		groupsByMbid: new Map(),
	};
	for (const { slug, type, node } of nodes) {
		const name = text(node.name) ?? slug;
		if (type === "artist") {
			// The node's own mbid wins; the artist manifest covers a cache whose 1.10 dry-run was not applied yet.
			const known = artistManifest?.get(slug);
			const mbid = validMbid(node.mbid) ?? known?.mbid;
			// Bands are only trusted for the MBID they were looked up under.
			if (mbid && known?.mbid === mbid) ctx.groupsByMbid.set(mbid, known.groups);
			ctx.artists.set(slug, mbid ? { name, mbid } : { name });
			if (mbid) push(ctx.artistSlugsByMbid, mbid, slug);
		} else if (type === "label") {
			const mbid = validMbid(node.mbid);
			ctx.labels.set(slug, mbid ? { name, mbid } : { name });
			if (mbid) push(ctx.labelSlugsByMbid, mbid, slug);
		} else if (type === "project" || type === "track") {
			if (text(node.mbid)) ctx.storedWorkMbids.set(slug, String(node.mbid));
		}
	}
	const point = (workSlug: unknown, artist: Edge | undefined, artistSlug: string) => {
		const name = artist ? text(artist.name) : undefined;
		if (typeof workSlug !== "string" || !name) return;
		const mbid = validMbid(artist?.mbid) ?? ctx.artists.get(artistSlug)?.mbid;
		const row = ctx.pointers.get(workSlug) ?? new Map<string, Pointer>();
		row.set(artistSlug, mbid ? { name, mbid } : { name });
		ctx.pointers.set(workSlug, row);
	};
	for (const { slug, type, node } of nodes) {
		if (type === "artist") {
			const self: Edge = { name: ctx.artists.get(slug)?.name };
			for (const field of ["discography", "notable_tracks"]) {
				for (const ref of edges(node[field])) point(ref.slug, self, slug);
			}
		} else if (type === "project") {
			const primary = edges(node.artists)[0];
			if (primary && typeof primary.slug === "string") {
				for (const ref of edges(node.tracklist)) point(ref.slug, primary, primary.slug);
			}
		}
	}
	return ctx;
}

// --- Step 1: the artist to look a work up under ---

export type HintResult =
	| { kind: "hint"; name: string; mbid?: string }
	| { kind: "none" }
	| { kind: "ambiguous"; candidates: string[] };

/**
 * The artist a work is looked up under: its own first credit (that is what the cache says, and it
 * prevails: "Together" credited to the Oak Ridge Boys is looked up under them even though two other
 * artists list it), else the one artist that points at it.
 */
function findHint(slug: string, node: Record<string, unknown>, ctx: Context): HintResult {
	const own = edges(node.artists)[0];
	const ownName = own ? text(own.name) : undefined;
	if (own && ownName) {
		const mbid =
			validMbid(own.mbid) ?? (typeof own.slug === "string" ? ctx.artists.get(own.slug)?.mbid : undefined);
		return mbid ? { kind: "hint", name: ownName, mbid } : { kind: "hint", name: ownName };
	}
	const pointing = [...(ctx.pointers.get(slug) ?? new Map<string, Pointer>()).entries()];
	if (pointing.length === 0) return { kind: "none" };
	if (pointing.length > 1) return { kind: "ambiguous", candidates: pointing.map(([s]) => s).sort() };
	const [, only] = pointing[0] as [string, Pointer];
	return only.mbid ? { kind: "hint", name: only.name, mbid: only.mbid } : { kind: "hint", name: only.name };
}

/**
 * The resolver may settle for an exact-title candidate whatever its credit; here the credit must also
 * be the artist we looked under.
 * - hint with a known MBID: the credit must carry that MBID, or the MBID of a band the artist belongs
 *   to (`groups`, from the artist manifest: Roni Size is credited as "Roni Size / Reprazent"). A name
 *   is not accepted then: "Mala" must not pass on "Mala Rodríguez", nor "Earth" on another Earth;
 * - hint without MBID: a credit has the same name as the artist (sameCreditName, the resolver's own
 *   rule: "Prince" is not "Prince Buster", "The" is ignored). A credit in another script is recognised
 *   by MBID only, so without one the work stays unresolved.
 * This is a narrower check than the resolver's, on purpose (TRA-552, for the TRA-483 audit): it reads the
 * returned `MbCredit`s, which hold the CANONICAL artist name only. The resolver also accepts the name the
 * credit is PRINTED under, the artist's aliases, and the joined credit ("Prince & The Revolution" over
 * two entries); none of these reach this function. A work the resolver accepted through one of them, for
 * a hint without MBID, can therefore end as `credit-mismatch`: refused here, never wrongly accepted.
 */
export function creditConfirmsHint(
	credit: readonly MbCredit[],
	hint: { name: string; mbid?: string },
	groups: readonly string[] = [],
): boolean {
	if (hint.mbid !== undefined) {
		return credit.some((c) => c.mbid === hint.mbid || groups.includes(c.mbid));
	}
	return credit.some((c) => sameCreditName(c.name, hint.name));
}

// --- Step 3: what is written ---

type Mapped =
	| { ok: true; edges: Edge[] }
	| { ok: false; reason: "ambiguous" | "unmappable"; candidates: string[] };

/**
 * The edge for each MB credit: the cache artist carrying that MBID (slug and name as stored),
 * otherwise a slug derived from the credited name. Refuses what could graft a stranger's identity
 * on the node: several cache artists on one MBID, a credit with no Latin letter and no cache
 * artist, a derived slug already held by an artist with another MBID.
 */
export function mapCredit(credit: readonly MbCredit[], ctx: Context): Mapped {
	const out: Edge[] = [];
	for (const c of credit) {
		const owners = ctx.artistSlugsByMbid.get(c.mbid) ?? [];
		if (owners.length > 1) return { ok: false, reason: "ambiguous", candidates: [...owners].sort() };
		const owner = owners[0];
		if (owner !== undefined) {
			out.push({ slug: owner, type: "artist", name: ctx.artists.get(owner)?.name ?? c.name, mbid: c.mbid });
			continue;
		}
		if (!normalizeSlugBody(c.name)) return { ok: false, reason: "unmappable", candidates: [] };
		const slug = makeSlug("artist", c.name);
		const taken = ctx.artists.get(slug);
		if (taken?.mbid !== undefined && taken.mbid !== c.mbid) {
			return { ok: false, reason: "unmappable", candidates: [slug] };
		}
		out.push({ slug, type: "artist", name: c.name, mbid: c.mbid });
	}
	return { ok: true, edges: out };
}

/**
 * Existing credits stay where they are (the first one is what the work was looked up under) and get
 * the MBID of the MB artist they stand for; MB artists not yet credited are appended (never under a
 * slug an edge already uses: that edge is another artist's, kept as is). An empty credit is replaced
 * by MB's.
 */
export function mergeArtists(existing: Edge[], credited: Edge[], ctx: Context): Edge[] {
	if (existing.length === 0) return credited;
	const out = existing.map((e) => ({ ...e }));
	for (const c of credited) {
		const index = out.findIndex((e) => {
			const known =
				validMbid(e.mbid) ?? (typeof e.slug === "string" ? ctx.artists.get(e.slug)?.mbid : undefined);
			if (known !== undefined) return known === c.mbid;
			const body = typeof e.name === "string" ? normalizeSlugBody(e.name) : "";
			return e.slug === c.slug || (body !== "" && body === normalizeSlugBody(String(c.name)));
		});
		const hit = out[index];
		if (hit) {
			if (hit.mbid === undefined) hit.mbid = c.mbid;
		} else if (!out.some((e) => e.slug === c.slug)) out.push(c);
	}
	return out;
}

function yearOf(date: string | null): string | null {
	return date !== null && /^\d{4}/.test(date) ? date.slice(0, 4) : null;
}

/**
 * A node that states a year must not contradict MusicBrainz's first release by more than one year.
 * Same title and same artist is not always the same work: the cache's "Fading" (DFRNT, 2012), listed
 * by mistake in Pole's discography, matched Pole's 2020 album of the same name. A candidate with no
 * date cannot confirm a stated year either. A node with no year, or a year that is not four digits,
 * has nothing to contradict.
 */
export function yearsAgree(nodeYear: string | undefined, mbYear: string | null): boolean {
	if (nodeYear === undefined || !/^\d{4}$/.test(nodeYear.trim())) return true;
	if (mbYear === null) return false;
	return Math.abs(Number(nodeYear.trim()) - Number(mbYear)) <= 1;
}

function releaseTypeOf(primary: string | null): ReleaseType | null {
	const lower = primary?.toLowerCase() ?? "";
	return (RELEASE_TYPES as readonly string[]).includes(lower) ? (lower as ReleaseType) : null;
}

function labelEdge(label: { mbid: string; name: string }, ctx: Context, notes: string[]): Edge | null {
	const mbid = validMbid(label.mbid);
	const name = text(label.name);
	if (!mbid || !name) return null;
	// MB's special-purpose label "[no label]" is a placeholder, not a label. Matched by MBID: a name in
	// brackets is not proof ("[adult swim]" is a real label).
	if (mbid.toLowerCase() === NO_LABEL_MBID) {
		notes.push(`label: ${name} is a MusicBrainz placeholder`);
		return null;
	}
	const owners = ctx.labelSlugsByMbid.get(mbid) ?? [];
	if (owners.length > 1) {
		notes.push(`label: several cache labels share the MBID ${mbid}`);
		return null;
	}
	const owner = owners[0];
	if (owner !== undefined)
		return { slug: owner, type: "label", name: ctx.labels.get(owner)?.name ?? name, mbid };
	// normalizeSlugBody drops a trailing "[...]" as a disambiguator: a name that is nothing but brackets
	// ("[adult swim]") slugs from what is inside them.
	const slugName = normalizeSlugBody(name) ? name : name.replace(/^\s*\[(.*)\]\s*$/u, "$1");
	if (!normalizeSlugBody(slugName)) {
		notes.push(`label: no Latin letter in "${name}" and no cache label with its MBID`);
		return null;
	}
	const slug = makeSlug("label", slugName);
	const taken = ctx.labels.get(slug);
	if (taken?.mbid !== undefined && taken.mbid !== mbid) {
		notes.push(`label: ${slug} is held by a label with another MBID`);
		return null;
	}
	return { slug, type: "label", name, mbid };
}

export interface Plan {
	next: Record<string, unknown>;
	notes: string[];
}

/** Whether the optional parts need the second MusicBrainz call. */
export function needsMeta(type: "project" | "track", node: Record<string, unknown>): boolean {
	return type === "project"
		? edges(node.tracklist).length === 0 || node.label === undefined
		: node.project === undefined || node.label === undefined;
}

/**
 * The node with the identity written. `meta` is the second MB answer (null in a dry-run, or when the
 * node needs none). Every field absent from the list below is carried over untouched.
 */
export function planWrite(
	type: "project" | "track",
	node: Record<string, unknown>,
	work: ResolvedWork,
	credited: Edge[],
	ctx: Context,
	meta: MbProjectMeta | MbTrackMeta | null,
): Plan {
	const notes: string[] = [];
	const next: Record<string, unknown> = { ...node, mbid: work.mbid };
	next.artists = mergeArtists(edges(node.artists), credited, ctx);
	if (text(node.year) === undefined && work.year !== null) next.year = work.year;
	if (type === "project" && node.release_type === undefined && work.release_type !== null) {
		next.release_type = work.release_type;
	}
	// The scope of a new slug is the first credit as written on the node; a credit with no Latin letter
	// falls back on the next candidates (pickScopeArtistName never transliterates).
	const firstCredit = edges(next.artists)[0];
	const scope = pickScopeArtistName([
		firstCredit ? text(firstCredit.name) : undefined,
		...work.credit.map((c) => c.name),
	]);

	if (meta !== null && node.label === undefined && meta.label) {
		const label = labelEdge(meta.label, ctx, notes);
		if (label) next.label = label;
	}
	if (type === "project" && meta !== null && "tracks" in meta && edges(node.tracklist).length === 0) {
		if (scope === null) {
			if (meta.tracks.length > 0) notes.push("tracklist: no Latin artist name to scope the track slugs with");
		} else {
			const tracklist: Edge[] = [];
			const seen = new Set<string>();
			for (const t of meta.tracks) {
				const title = text(t.title);
				const scoped = title ? makeScopedSlug("track", title, scope) : null;
				if (!title || !scoped?.ok || seen.has(scoped.slug)) continue;
				seen.add(scoped.slug);
				const mbid = validMbid(t.mbid);
				tracklist.push({
					slug: scoped.slug,
					type: "track",
					name: title,
					...(mbid ? { mbid } : {}),
					artist: scope,
				});
			}
			if (tracklist.length > 0) next.tracklist = tracklist;
		}
	}
	if (type === "track" && meta !== null && "project" in meta && node.project === undefined && meta.project) {
		const title = text(meta.project.name);
		const scoped = title && scope !== null ? makeScopedSlug("project", title, scope) : null;
		if (!title || !scoped?.ok) {
			notes.push("project: no Latin artist name to scope the project slug with");
		} else {
			const mbid = validMbid(meta.project.mbid);
			next.project = {
				slug: scoped.slug,
				type: "project",
				name: title,
				...(mbid ? { mbid } : {}),
				artist: scope,
			};
		}
	}
	return { next, notes };
}

// --- Step 2: the MusicBrainz search ---

/**
 * The resolver's answer for `name` under `hint`. MB's `artist:` search field only indexes the credited
 * names, so a work credited in its original script ("坂本龍一") is invisible to a search under the
 * Latin name the cache uses: when that search finds nothing and the hint's MBID is known, search the
 * title alone. The credit is checked against the hint afterwards (by MBID, which a name cannot fake),
 * so this widens what is looked at, not what is accepted.
 */
async function lookUp(
	type: "project" | "track",
	name: string,
	hint: { name: string; mbid?: string },
	groups: readonly string[] = [],
	releaseType?: string,
): Promise<{ found: MbReleaseIdentity | null; ambiguous: boolean; unavailable: boolean }> {
	const resolve = type === "project" ? resolveReleaseGroupDetailed : resolveRecordingDetailed;
	// An outage is not a verdict: the resolvers say so themselves (`unavailable`), whether MB refused,
	// was unreachable or answered with something unreadable.
	// The artist's own MBID lets the resolver count a work printed under another name as direct (TRA-552).
	// The node's own release type tells a single from the album of the same name (TRA-560); a track has none.
	const typed = type === "project" && releaseType !== undefined ? { releaseType } : {};
	const first = await resolve(name, hint.name, {
		acceptCreditMbids: groups,
		...(hint.mbid === undefined ? {} : { requestedArtistMbid: hint.mbid }),
		...typed,
	});
	if (first.unavailable) return { found: null, ambiguous: false, unavailable: true };
	// Look-alikes are a verdict, not a reason to look elsewhere.
	if (first.identity !== null || first.ambiguous || hint.mbid === undefined) {
		return { found: first.identity, ambiguous: first.ambiguous, unavailable: false };
	}
	const second = await resolve(name, undefined, typed);
	if (second.unavailable) return { found: null, ambiguous: false, unavailable: true };
	return { found: second.identity, ambiguous: second.ambiguous, unavailable: false };
}

// --- Run ---

export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
	const { cacheDir, apply, limit } = options;
	const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
	const log = options.log ?? (() => {});

	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	const artistManifest = await readArtistManifest(
		options.artistManifestPath ?? DEFAULT_ARTIST_MANIFEST_PATH,
		options.artistManifestRequired ?? false,
	);
	if (artistManifest === null) log("no artist manifest: credits map onto the cache's own artist MBIDs only");
	const ctx = buildContext(nodes, artistManifest);
	for (const [work, extra] of options.extraPointers ?? []) {
		const row = ctx.pointers.get(work) ?? new Map<string, Pointer>();
		for (const [artistSlug, pointer] of extra) if (!row.has(artistSlug)) row.set(artistSlug, pointer);
		ctx.pointers.set(work, row);
	}
	const works = nodes.filter(
		(n): n is typeof n & { type: "project" | "track" } => n.type === "project" || n.type === "track",
	);
	const pending = works.filter((w) => !text(w.node.mbid) && (options.only?.has(w.slug) ?? true));

	let prior: ReleaseManifest | null = null;
	try {
		prior = await readManifest(manifestPath);
	} catch (e) {
		// Without --resume the previous manifest is about to be replaced; only a resume depends on it.
		if (options.resume) throw e;
	}
	// Entries of works already written (the node carries the entry's mbid) are kept whatever the flags:
	// 1.12 reads their credit here. Entries of works not written yet are kept for --resume only.
	const resolved: Record<string, ResolvedWork> = {};
	const unresolved: UnresolvedWork[] = [];
	const ambiguous: AmbiguousWork[] = [];
	const failed: BackfillResult["failed"] = [];
	const written: string[] = [];
	const bySlugNode = new Map(works.map((w) => [w.slug, w]));
	for (const [slug, entry] of Object.entries(prior?.resolved ?? {})) {
		const w = bySlugNode.get(slug);
		if (!w) continue;
		const stored = text(w.node.mbid);
		if (stored === entry.mbid || (options.resume && stored === undefined)) resolved[slug] = entry;
	}

	const reusable = (slug: string) => resolved[slug] !== undefined && options.resume === true;
	const toQuery = pending.filter((w) => !reusable(w.slug));
	const budget = limit === undefined ? toQuery.length : Math.min(limit, toQuery.length);
	const seconds = Math.ceil((budget * CALLS_PER_WORK * Math.max(musicBrainzConfig.minIntervalMs, 0)) / 1000);
	log(
		`${pending.length} works without mbid, ${pending.length - toQuery.length} reused from the manifest, ${budget} to ` +
			`search: up to ${budget * (apply ? CALLS_PER_WORK : 1)} MusicBrainz requests, about ` +
			`${Math.ceil((apply ? seconds : seconds / CALLS_PER_WORK) / 60)} min at one request per ` +
			`${musicBrainzConfig.minIntervalMs} ms${apply ? "" : " (dry-run)"}`,
	);

	const storedMbids = ctx.storedWorkMbids;
	let attempted = 0;
	let checkpointed = 0;
	for (const { slug, path, type, node } of pending) {
		if (attempted - checkpointed >= CHECKPOINT_EVERY) {
			checkpointed = attempted;
			await writeManifest(manifestPath, buildManifest(resolved, unresolved, ambiguous, storedMbids));
		}
		const name = text(node.name) ?? slug;
		let work: ResolvedWork | undefined = reusable(slug) ? resolved[slug] : undefined;
		delete resolved[slug];

		if (!work) {
			if (limit !== undefined && attempted >= limit) {
				// Not reached this run: keep what the previous manifest said about it.
				const u = prior?.unresolved.find((x) => x.slug === slug);
				const a = prior?.ambiguous.find((x) => x.slug === slug);
				if (u) unresolved.push(u);
				if (a) ambiguous.push(a);
				continue;
			}
			const judged = options.hints?.get(slug);
			const hint: HintResult = judged ? { kind: "hint", ...judged } : findHint(slug, node, ctx);
			if (hint.kind === "ambiguous") {
				ambiguous.push({ slug, candidates: hint.candidates, reason: "several-artists-point-here" });
				continue;
			}
			if (hint.kind === "none") {
				unresolved.push({ slug, name, hint: "", reason: "no-hint" });
				continue;
			}
			attempted++;
			const groups = hint.mbid === undefined ? [] : (ctx.groupsByMbid.get(hint.mbid) ?? []);
			const lookedUp = await lookUp(type, name, hint, groups, text(node.release_type));
			if (lookedUp.unavailable) {
				failed.push({ slug, reason: "MusicBrainz search unavailable" });
				continue;
			}
			const found = lookedUp.found;
			if (!found) {
				unresolved.push({
					slug,
					name,
					hint: hint.name,
					reason: lookedUp.ambiguous ? "ambiguous-candidates" : "no-match",
				});
				continue;
			}
			if (!creditConfirmsHint(found.credit, hint, groups)) {
				unresolved.push({ slug, name, hint: hint.name, reason: "credit-mismatch" });
				continue;
			}
			const year = yearOf(found.firstReleaseDate);
			if (!yearsAgree(text(node.year), year)) {
				unresolved.push({ slug, name, hint: hint.name, reason: "year-mismatch" });
				continue;
			}
			work = {
				mbid: found.mbid,
				credit: found.credit,
				title: found.title,
				hint: hint.name,
				year,
				release_type: releaseTypeOf(found.primaryType),
			};
		}

		const mapped = mapCredit(work.credit, ctx);
		if (!mapped.ok) {
			if (mapped.reason === "ambiguous") {
				ambiguous.push({
					slug,
					candidates: mapped.candidates,
					reason: "several-artist-nodes-share-the-credit-mbid",
				});
			} else {
				unresolved.push({ slug, name, hint: work.hint, reason: "unmappable-credit" });
			}
			continue;
		}
		resolved[slug] = work;

		if (apply) {
			let meta: MbProjectMeta | MbTrackMeta | null = null;
			if (!options.creditOnly && needsMeta(type, node)) {
				const fetched =
					type === "project"
						? await fetchProjectMetaDetailedMb(work.mbid)
						: await fetchTrackMetaDetailedMb(work.mbid);
				if (fetched.notFound) {
					// MB answered that the mbid does not exist: a verdict, so neither `failed` (which --resume
					// would retry for ever) nor `resolved` (the entry would hand 1.12 a credit for an mbid
					// that leads nowhere). The work is selected again next run and searched afresh.
					delete resolved[slug];
					unresolved.push({ slug, name, hint: work.hint, reason: "mbid-not-found" });
					continue;
				}
				if (fetched.unavailable) {
					// Writing the mbid without the tracklist / project would hide the hole: the work would no
					// longer be selected. All or nothing; --resume repeats only this lookup.
					failed.push({ slug, reason: `MusicBrainz lookup failed for ${work.mbid}` });
					continue;
				}
				meta = fetched.meta;
			}
			const plan: Plan = options.creditOnly
				? {
						next: { ...node, mbid: work.mbid, artists: mergeArtists(edges(node.artists), mapped.edges, ctx) },
						notes: [],
					}
				: planWrite(type, node, work, mapped.edges, ctx, meta);
			const parsed = nodePayloadSchema.safeParse(plan.next);
			if (!parsed.success) {
				failed.push({ slug, reason: `refusing to write an invalid node: ${parsed.error.message}` });
			} else if (!onlyAddsSchemaDefaults(plan.next, parsed.data)) {
				// The schema strips undeclared fields, edges' included; beyond the fields above, only the
				// addition of a missing list at its default (empty) is tolerated.
				failed.push({ slug, reason: "refusing to write: validation would alter fields the node carries" });
			} else {
				await atomicWriteJson(path, parsed.data);
				written.push(path);
				if (plan.notes.length > 0) resolved[slug] = { ...work, notes: plan.notes };
			}
		}
	}

	const manifest = buildManifest(resolved, unresolved, ambiguous, storedMbids);
	await writeManifest(manifestPath, manifest);
	// A failure is a hole in the manifest, not a verdict: exit 1 so the operator re-runs with --resume.
	return { manifest, written, failed, exitCode: failed.length > 0 ? 1 : 0 };
}

export function formatSummary(result: BackfillResult, apply: boolean, manifestPath: string): string {
	const { manifest, written, failed } = result;
	const lines = [
		`resolved ${Object.keys(manifest.resolved).length}, unresolved ${manifest.unresolved.length}, ` +
			`ambiguous ${manifest.ambiguous.length}, collisions ${manifest.collisions.length}, failed ${failed.length}`,
		apply ? `${written.length} node file(s) written` : "dry-run: no node file written",
		`manifest: ${manifestPath}`,
	];
	for (const c of manifest.collisions) lines.push(`collision ${c.mbid}: ${c.slugs.join(", ")}`);
	for (const a of manifest.ambiguous)
		lines.push(`ambiguous ${a.slug} (${a.reason}): ${a.candidates.join(", ")}`);
	for (const u of manifest.unresolved) lines.push(`unresolved ${u.slug} (${u.reason}, hint "${u.hint}")`);
	for (const f of failed) lines.push(`failed ${f.slug}: ${f.reason}`);
	return lines.join("\n");
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	artistManifestPath: string;
	/** True when --artist-manifest was given: a missing file is then an error. */
	artistManifestRequired: boolean;
	limit?: number;
	resume: boolean;
}

/**
 * Parses `<cache-dir> [--apply] [--manifest <path>] [--artist-manifest <path>] [--limit N] [--resume]
 * [--data-dir <dir>]`.
 * Null (CLI exits 2) on a missing cache-dir, a repeated flag, a flag without its value (or with
 * another flag as value), a `--limit` that is not a positive integer, or any token no flag consumes:
 * an ambiguous argument never falls through to a guess.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	let resume = false;
	let manifestPath: string | undefined;
	let artistManifestPath: string | undefined;
	let limit: number | undefined;
	let dataDirSeen = false;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (token === "--resume" && !resume) resume = true;
		else if (
			(token === "--manifest" && manifestPath === undefined) ||
			(token === "--artist-manifest" && artistManifestPath === undefined) ||
			(token === "--limit" && limit === undefined) ||
			(token === "--data-dir" && !dataDirSeen)
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			if (token === "--manifest") manifestPath = value;
			else if (token === "--artist-manifest") artistManifestPath = value;
			else if (token === "--data-dir") dataDirSeen = true;
			else if (/^[1-9]\d*$/.test(value)) limit = Number(value);
			else return null;
		} else return null;
	}
	return {
		cacheDir,
		apply,
		resume,
		manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH,
		artistManifestPath: artistManifestPath ?? DEFAULT_ARTIST_MANIFEST_PATH,
		artistManifestRequired: artistManifestPath !== undefined,
		...(limit !== undefined ? { limit } : {}),
	};
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-15-backfill-release-identity.ts <cache-dir> [--apply] [--manifest <path>] " +
				"[--artist-manifest <path>] [--limit N] [--resume] [--data-dir <dir>]\n",
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
		artistManifestPath: args.artistManifestPath,
		artistManifestRequired: args.artistManifestRequired,
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
