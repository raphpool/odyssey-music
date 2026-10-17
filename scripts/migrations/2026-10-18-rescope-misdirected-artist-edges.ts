/**
 * Misdirected artist edges (TRA-602, plan docs/plans/graph-integrity.md): an artist's `discography` /
 * `notable_tracks` entry whose slug is a key of the redirect tables (data/slug-redirects.json, data/genre-
 * redirects.json) opens, on every read, the work the table points at. The table is GLOBAL: it sends a bare
 * and ambiguous slug (`project:wish-you-were-here`) to ONE scoped version, the homonym's
 * (`...--american-hot-wax`), while Pink Floyd keeps the bare slug for its own album. From Pink Floyd's page the
 * click opens somebody else's work (2026-10-17, prod: Daft Punk -> Twin Atlantic, Moderat -> Boyz II Men, ...;
 * same family as the original Rohff -> Akuma bug).
 *
 * Detection. For every artist A and every entry of `discography` / `notable_tracks` whose slug is a project /
 * track that the reads redirect (`resolveReadSlug`: a live cache node wins, otherwise ONE hop of the merged
 * tables), the resolved target is judged against A:
 *   - credited: the target is in the cache and credits A (`reciprocates`, src/images/reciprocity.ts: A's slug,
 *     or an artist edge with the same non-empty mbid). Left alone.
 *   - misdirected, in the cache: the target does not credit A (nor a relative of A, nor is it scoped on one).
 *   - misdirected, absent: the target is not in the cache and its scope (`scopeOf`) is not A's, nor a
 *     relative's.
 *   - skipped (`skippedAliasOrMember`): the target is credited or scoped on a RELATIVE of A -- one of A's
 *     `aliases`, one of A's `members`, or an artist that lists A in its `members` (the group) or in its
 *     `aliases`. Richie Hawtin -> Plastikman's *Spastik*, Sean Booth -> Autechre's *Amber* are not wrong. A
 *     relative is matched by slug, or by mbid when both sides have one.
 *   - unjudged: an absent target with NO scope (or an unreadable one). Nothing says whose work it is, so it
 *     is not rewritten, and it is counted apart.
 *
 * Fix. The edge's slug becomes the version scoped on A: `makeScopedSlug(type, edge.name, A.name)`, then
 * `transliteratedSlug`, i.e. the CANONICAL (transliterated) form whatever ODYSSEY_SCOPED_RELEASE_SLUGS says.
 * The channel runs the migrations with the flag at 0 (TRA-599 is open); without the canonical form a name
 * like "Roeyksopp" with a slashed o would get a scope that the flag-on code never reads. The edge's `name`
 * and `mbid` (every other key) are kept; only `slug` changes.
 *   - `landmark_project` / `reference_track` pointing at the old slug move with the list entry (the rule of
 *     CREDITED_FIELDS in 2026-10-16-scope-release-slugs.ts): the pipeline requires a pick to be a member of its
 *     list compared by slug (enforceArtistChoices, TRA-470).
 *   - the list already holds the scoped slug: the misdirected entry is REMOVED instead of creating a duplicate
 *     (reason `duplicate-of-scoped`), and a pick on the old slug moves to the surviving entry.
 *   - no node is created and no redirect is touched: the scoped work is generated on demand, with the right
 *     identity.
 *   - the scoped slug is a node of the cache that does not credit A: a COLLISION. The run is refused (exit 1)
 *     and nothing is written, whatever the other artists need.
 * ORDER (precondition): the credit is read on the target's `artists`; run this AFTER the identity and scope
 * migrations and the reverse-edge backfill (2026-10-15 .. 2026-10-17), and BEFORE the 2026-10-19 backfills
 * (the landmark backfill excludes an entry that redirects to somebody else's work; once rewritten, the entry
 * is eligible again).
 *
 * Writes go through atomicWriteJson after nodePayloadSchema validation, never NodeCache.write (which would
 * emit reverse edges); a write that validation would alter is refused and the artist listed in `failed`
 * (exit 1), and then NOTHING is written, like for a collision: a half-migrated cache is worse than none.
 * Pure and offline: no network call, no clock. A second run finds nothing to do (idempotent).
 *
 * Manifest: deterministic (sorted, no timestamp), the same in a dry-run, an apply and a re-run on a copy. It
 * carries the migration channel's constants (`migration`, `removed: []`, `renamed: {}`, `redirects: {}`).
 * Migration channel (deploy/sync-genre-cache.sh): `--apply`, `--manifest` and `--data-dir` are the flags it
 * passes; `--data-dir` is where the redirect tables are read (fail closed when they cannot be).
 *
 * Usage: tsx scripts/migrations/2026-10-18-rescope-misdirected-artist-edges.ts <cache-dir> [--apply]
 *        [--manifest out/rescope-misdirected.json] [--data-dir <dir>]
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, NodeCache } from "../../src/cache.js";
import { loadRedirects, resolveReadSlug } from "../../src/genre-registry.js";
import { reciprocates, type Work } from "../../src/images/reciprocity.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import {
	isReadableSlug,
	makeScopedSlug,
	makeSlug,
	normalizeSlugBody,
	parseSlug,
	scopeMatchesArtist,
	scopeOf,
	transliteratedSlug,
} from "../../src/slug.js";
import type { NodePayload, Slug } from "../../src/types.js";
import {
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-18-rescope-misdirected-artist-edges";
export const DEFAULT_MANIFEST_PATH = "out/rescope-misdirected.json";

/** The artist lists this migration reads, and the single-edge choice that is picked among each. */
export const EDGE_LISTS = [
	{ list: "discography", pick: "landmark_project" },
	{ list: "notable_tracks", pick: "reference_track" },
] as const;
export type EdgeList = (typeof EDGE_LISTS)[number]["list"];
export type PickField = (typeof EDGE_LISTS)[number]["pick"];

export const REWRITE_REASONS = ["cached-not-credited", "absent-other-scope", "duplicate-of-scoped"] as const;
export type RewriteReason = (typeof REWRITE_REASONS)[number];

export const UNJUDGED_REASONS = [
	"absent-unscoped-target",
	"unreadable-target",
	"no-scoped-slug",
	"redirect-from-scoped-slug",
] as const;
export type UnjudgedReason = (typeof UNJUDGED_REASONS)[number];

/** How a relative is related to the artist being judged, seen from that artist. */
export type Relation = "alias" | "member" | "group" | "alias-of";

export interface RewrittenEdge {
	artist: string;
	field: EdgeList;
	from: string;
	to: string;
	reason: RewriteReason;
}
export interface SkippedRelative {
	artist: string;
	field: EdgeList;
	from: string;
	/** What the redirect resolves to. */
	target: string;
	/** The relative the target is credited or scoped on. */
	relative: string;
	relation: Relation;
}
export interface Unjudged {
	artist: string;
	field: EdgeList;
	from: string;
	target: string;
	reason: UnjudgedReason;
}
export interface Collision {
	artist: string;
	field: EdgeList;
	from: string;
	/** The scoped slug the edge should take, which is a node of the cache that does not credit the artist. */
	to: string;
	reason: "credits-another-artist" | "unreadable";
}
export interface MovedChoice {
	artist: string;
	field: PickField;
	from: string;
	to: string;
}

export interface RescopeManifest {
	/** The channel's manifest contract (TRA-568): this migration deletes and renames nothing. */
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	summary: {
		artists: number;
		/** Entries of `discography` / `notable_tracks` that a read redirects. */
		redirectedEdges: number;
		/** Redirected entries whose target credits the artist (or is scoped on it): correct, left alone. */
		credited: number;
		rewritten: number;
		duplicatesRemoved: number;
		skippedAliasOrMember: number;
		unjudged: number;
		collisions: number;
		choicesMoved: number;
	};
	rewritten: RewrittenEdge[];
	skippedAliasOrMember: SkippedRelative[];
	unjudged: Unjudged[];
	collisions: Collision[];
	/** `landmark_project` / `reference_track` moved with their list entry. */
	choicesMoved: MovedChoice[];
	/** Artists left untouched because they could not be read, validated or written safely. */
	failed: { slug: string; reason: string }[];
}

// --- Pure helpers ---

/**
 * The slug of the work `title` scoped on the artist `artistName`, in its CANONICAL (transliterated) form
 * whatever ODYSSEY_SCOPED_RELEASE_SLUGS says. Null when no scoped slug can be derived (empty title, a name with
 * no Latin letter or digit, an ambiguous derivation).
 */
export function canonicalScopedSlug(
	type: "project" | "track",
	title: string,
	artistName: string,
): Slug | null {
	const minted = makeScopedSlug(type, title, artistName);
	if (!minted.ok) return null;
	const canonical = transliteratedSlug(minted.slug, title, artistName);
	return canonical.ok ? canonical.slug : null;
}

/** The scope bodies an artist's works can carry: its slug body, its name, and the name in canonical form. */
export function scopeBodiesOf(slug: string, name: string): Set<string> {
	const bodies = new Set<string>();
	if (isReadableSlug(slug)) bodies.add(parseSlug(slug).body);
	const current = normalizeSlugBody(name);
	if (current) bodies.add(current);
	try {
		const canonical = transliteratedSlug(makeSlug("artist", name), name);
		if (canonical.ok) bodies.add(parseSlug(canonical.slug).body);
	} catch {
		// An empty body: this name has no slug, so it cannot be a scope either.
	}
	return bodies;
}

/** Is `work` scoped on the artist `slug` / `name`? */
export function scopedOn(work: string, slug: string, name: string): boolean {
	const scope = scopeOf(work);
	return scope !== null && (scopeMatchesArtist(work, name) || scopeBodiesOf(slug, name).has(scope));
}

type Obj = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

interface ArtistRef {
	slug: string;
	name: string;
	mbid?: string | undefined;
}

/** Same artist: same slug, or the same mbid when both sides have one. */
export const sameArtist = (
	a: { slug?: string | undefined; mbid?: string | undefined },
	b: ArtistRef,
): boolean =>
	(a.slug !== undefined && a.slug === b.slug) ||
	(a.mbid !== undefined && b.mbid !== undefined && a.mbid === b.mbid);

interface Relative extends ArtistRef {
	relation: Relation;
}

const edgesOf = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isRecord) : []);

type Owner = { owner: string; relation: "group" | "alias-of" };
/** Who lists whom in `members` / `aliases`, by slug and by mbid: built once, read once per artist. */
export type RelationIndex = ReadonlyMap<string, Owner[]>;

export function indexRelations(all: ReadonlyMap<string, Obj>): RelationIndex {
	const index = new Map<string, Owner[]>();
	for (const [owner, node] of all) {
		for (const [list, relation] of [
			["members", "group"],
			["aliases", "alias-of"],
		] as const) {
			for (const e of edgesOf(node[list])) {
				const slug = str(e.slug);
				const mbid = str(e.mbid);
				for (const key of [slug && `slug:${slug}`, mbid && `mbid:${mbid}`]) {
					if (key) index.set(key, [...(index.get(key) ?? []), { owner, relation }]);
				}
			}
		}
	}
	return index;
}

/**
 * The relatives of `artist`: the artists of its `aliases` and `members`, and every artist of the cache that
 * lists it in its `members` (its group) or in its `aliases`. Names and mbids missing on an edge are read on
 * the cached artist node of that slug.
 */
export function relativesOf(
	artist: Obj,
	slug: string,
	all: ReadonlyMap<string, Obj>,
	index: RelationIndex,
): Relative[] {
	const mbid = str(artist.mbid);
	const out: Relative[] = [];
	const add = (ref: ArtistRef, relation: Relation) => {
		if (ref.slug !== slug) out.push({ ...ref, relation });
	};
	for (const [list, relation] of [
		["aliases", "alias"],
		["members", "member"],
	] as const) {
		for (const e of edgesOf(artist[list])) {
			const s = str(e.slug);
			if (s === undefined) continue;
			const cached = all.get(s);
			add(
				{
					slug: s,
					name: str(e.name) ?? str(cached?.name) ?? s,
					mbid: str(e.mbid) ?? str(cached?.mbid),
				},
				relation,
			);
		}
	}
	const owners = [...(index.get(`slug:${slug}`) ?? []), ...(mbid ? (index.get(`mbid:${mbid}`) ?? []) : [])];
	const seen = new Set<string>();
	for (const { owner, relation } of owners) {
		const node = all.get(owner);
		if (seen.has(`${owner} ${relation}`) || node === undefined) continue;
		seen.add(`${owner} ${relation}`);
		add({ slug: owner, name: str(node.name) ?? owner, mbid: str(node.mbid) }, relation);
	}
	return out;
}

/** The first relative that `work` credits (artist edge, by slug or by mbid). */
function creditedRelative(work: Work, relatives: readonly Relative[]): Relative | undefined {
	return relatives.find((r) =>
		work.artists.some((a) => a.type === "artist" && sameArtist({ slug: a.slug, mbid: str(a.mbid) }, r)),
	);
}

export type Verdict =
	| { kind: "credited" }
	| { kind: "relative"; relative: Relative }
	| { kind: "misdirected"; reason: Exclude<RewriteReason, "duplicate-of-scoped"> }
	| { kind: "unjudged"; reason: "absent-unscoped-target" | "unreadable-target" };

export interface JudgeInput {
	target: string;
	slug: string;
	name: string;
	relatives: readonly Relative[];
	/** The target as the cache holds it: absent, unreadable, or the work. */
	work: { kind: "absent" } | { kind: "unreadable" } | { kind: "work"; work: Work; creditsArtist: boolean };
}

/** Does the resolved target credit the artist, a relative of the artist, or nobody who is one of them? */
export function judge(input: JudgeInput): Verdict {
	const { target, slug, name, relatives, work } = input;
	if (work.kind === "unreadable") return { kind: "unjudged", reason: "unreadable-target" };
	if (work.kind === "work") {
		if (work.creditsArtist) return { kind: "credited" };
		const credited = creditedRelative(work.work, relatives);
		if (credited) return { kind: "relative", relative: credited };
		// A work that names its artists and does not name ours is somebody else's, whatever its slug scope says:
		// two artists called "Flash" share the scope `--flash`. The scope is only a fallback when the work
		// credits nobody.
		if (work.work.artists.some((a) => a.type === "artist")) {
			return { kind: "misdirected", reason: "cached-not-credited" };
		}
	}
	if (scopedOn(target, slug, name)) return { kind: "credited" };
	const scoped = relatives.find((r) => scopedOn(target, r.slug, r.name));
	if (scoped) return { kind: "relative", relative: scoped };
	if (work.kind === "work") return { kind: "misdirected", reason: "cached-not-credited" };
	if (scopeOf(target) === null) return { kind: "unjudged", reason: "absent-unscoped-target" };
	return { kind: "misdirected", reason: "absent-other-scope" };
}

// --- Run ---

export interface RescopeOptions {
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

export interface RescopeResult {
	manifest: RescopeManifest;
	written: string[];
	exitCode: number;
}

const compareLex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byEdge = (
	a: { artist: string; field: string; from: string },
	b: { artist: string; field: string; from: string },
): number => compareLex(a.artist, b.artist) || compareLex(a.field, b.field) || compareLex(a.from, b.from);

export async function runRescope(options: RescopeOptions): Promise<RescopeResult> {
	const { cacheDir, apply, manifestPath } = options;
	const log = options.log ?? (() => undefined);
	const cache = new NodeCache(cacheDir);
	// First of all: a table that cannot be read refuses the run before anything is decided or written.
	const redirects = await loadRunRedirects(options.dataDir);

	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	// Only an unreadable ARTIST file fails the run: it is the one thing that cannot be fixed. A corrupt work
	// file consulted as a target is `unjudged`; an unrelated corrupt file must not refuse a correct apply.
	// Relative to nodes/ and without the cache dir: the channel's preview and apply use different scratch dirs.
	const failed: RescopeManifest["failed"] = invalid
		.map((entry) => ({ rel: relative(join(cacheDir, "nodes"), entry.path), error: entry.error }))
		.filter(({ rel }) => rel.startsWith("artist:"))
		.map(({ rel, error }) => ({
			slug: rel,
			reason: `unreadable node file: ${error.split(cacheDir).join("<cache>")}`,
		}));

	// Every file on disk, a corrupt one included: a target that exists but cannot be read is `unreadable`.
	const inCache = new Set<string>(await cache.listSlugs());
	const artists = new Map<string, Obj>();
	for (const n of nodes) if (n.type === "artist") artists.set(n.slug, n.node);

	const relationIndex = indexRelations(artists);
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

	const rewritten: RewrittenEdge[] = [];
	const skippedRelatives: SkippedRelative[] = [];
	const unjudged: Unjudged[] = [];
	const collisions: Collision[] = [];
	const choicesMoved: MovedChoice[] = [];
	const pendingWrites: { path: string; data: unknown }[] = [];
	let redirectedEdges = 0;
	let credited = 0;
	log(`${artists.size} artist(s), ${nodes.length - artists.size} other node(s) read`);

	for (const { slug, path, node: raw } of nodes.filter((n) => n.type === "artist")) {
		const name = str(raw.name) ?? slug;
		// Decided per artist, committed to the manifest only once the node is known to be writable.
		const mine = {
			rewritten: [] as RewrittenEdge[],
			skipped: [] as SkippedRelative[],
			unjudged: [] as Unjudged[],
			collisions: [] as Collision[],
			moved: [] as MovedChoice[],
			redirectedEdges: 0,
			credited: 0,
		};
		const next: Obj = { ...raw };
		let artist: Extract<NodePayload, { type: "artist" }> | null = null;
		let relatives: Relative[] | null = null;
		let parseFailure: string | null = null;

		for (const { list, pick } of EDGE_LISTS) {
			const entries = Array.isArray(raw[list]) ? (raw[list] as unknown[]) : [];
			const present = new Set<string>();
			for (const e of entries) if (isRecord(e) && typeof e.slug === "string") present.add(e.slug);
			const moved = new Map<string, string>();
			const out: unknown[] = [];
			let changed = false;

			for (const edge of entries) {
				const from = isRecord(edge) ? str(edge.slug) : undefined;
				if (!isRecord(edge) || from === undefined || !isReadableSlug(from)) {
					out.push(edge);
					continue;
				}
				const type = parseSlug(from).type;
				if (type !== "project" && type !== "track") {
					out.push(edge);
					continue;
				}
				// What a read of this slug opens: the node itself when it is live, else one redirect hop.
				const target = await resolveReadSlug(from as Slug, redirects, cache);
				if (target === from) {
					out.push(edge);
					continue;
				}
				mine.redirectedEdges++;

				if (artist === null && parseFailure === null) {
					const parsed = nodePayloadSchema.safeParse(raw);
					if (parsed.success && parsed.data.type === "artist") {
						// The schema's output type differs from NodePayload only by `undefined` on optional
						// fields (exactOptionalPropertyTypes).
						artist = parsed.data as Extract<NodePayload, { type: "artist" }>;
					} else {
						parseFailure = parsed.success ? "not an artist" : parsed.error.message;
					}
				}
				if (artist === null) {
					out.push(edge);
					continue;
				}
				relatives ??= relativesOf(raw, slug, artists, relationIndex);

				let workState: JudgeInput["work"] = { kind: "absent" };
				if (inCache.has(target)) {
					const work = await readWork(target);
					workState =
						work === null || (work.type !== "project" && work.type !== "track")
							? { kind: "unreadable" }
							: {
									kind: "work",
									work: work as Work,
									creditsArtist: await reciprocates(artist, work as Work, cache, redirects),
								};
				}
				const verdict = judge({ target, slug, name, relatives, work: workState });

				if (verdict.kind === "credited") {
					mine.credited++;
					out.push(edge);
					continue;
				}
				if (verdict.kind === "relative") {
					mine.skipped.push({
						artist: slug,
						field: list,
						from,
						target,
						relative: verdict.relative.slug,
						relation: verdict.relative.relation,
					});
					out.push(edge);
					continue;
				}
				if (verdict.kind === "unjudged") {
					mine.unjudged.push({ artist: slug, field: list, from, target, reason: verdict.reason });
					out.push(edge);
					continue;
				}

				const scoped = canonicalScopedSlug(type, str(edge.name) ?? "", name);
				if (scoped === null || scoped === from) {
					mine.unjudged.push({
						artist: slug,
						field: list,
						from,
						target,
						reason: scoped === null ? "no-scoped-slug" : "redirect-from-scoped-slug",
					});
					out.push(edge);
					continue;
				}
				// The scoped version is a node already: it is taken only if it credits this artist.
				if (inCache.has(scoped)) {
					const existing = await readWork(scoped);
					if (existing === null || (existing.type !== "project" && existing.type !== "track")) {
						mine.collisions.push({ artist: slug, field: list, from, to: scoped, reason: "unreadable" });
						out.push(edge);
						continue;
					}
					if (!(await reciprocates(artist, existing as Work, cache, redirects))) {
						mine.collisions.push({
							artist: slug,
							field: list,
							from,
							to: scoped,
							reason: "credits-another-artist",
						});
						out.push(edge);
						continue;
					}
				}
				moved.set(from, scoped);
				changed = true;
				if (present.has(scoped)) {
					// The list already holds the scoped slug (it was there, or an earlier entry just took it).
					mine.rewritten.push({ artist: slug, field: list, from, to: scoped, reason: "duplicate-of-scoped" });
					continue;
				}
				present.add(scoped);
				mine.rewritten.push({ artist: slug, field: list, from, to: scoped, reason: verdict.reason });
				out.push({ ...edge, slug: scoped });
			}

			if (!changed) continue;
			next[list] = out;
			// The pick moves with its list entry, to the slug the entry took (or the surviving duplicate).
			const choice = raw[pick];
			const choiceSlug = isRecord(choice) ? str(choice.slug) : undefined;
			const moveTo = choiceSlug === undefined ? undefined : moved.get(choiceSlug);
			if (isRecord(choice) && choiceSlug !== undefined && moveTo !== undefined) {
				next[pick] = { ...choice, slug: moveTo };
				mine.moved.push({ artist: slug, field: pick, from: choiceSlug, to: moveTo });
			}
		}

		if (parseFailure !== null) {
			failed.push({ slug, reason: `refusing to fix an invalid node: ${parseFailure}` });
			continue;
		}
		if (mine.rewritten.length > 0) {
			const valid = nodePayloadSchema.safeParse(next);
			if (!valid.success) {
				failed.push({ slug, reason: `refusing to write an invalid node: ${valid.error.message}` });
				continue;
			}
			if (!onlyAddsSchemaDefaults(next, valid.data)) {
				// The schema strips undeclared fields, edges' included: only slugs may change.
				failed.push({ slug, reason: "refusing to write: validation would alter fields the node carries" });
				continue;
			}
			pendingWrites.push({ path, data: valid.data });
		}
		// Committed to the manifest once the artist is known to be writable, so that the counters add up:
		// redirectedEdges = credited + rewritten + skippedAliasOrMember + unjudged + collisions.
		rewritten.push(...mine.rewritten);
		choicesMoved.push(...mine.moved);
		collisions.push(...mine.collisions);
		unjudged.push(...mine.unjudged);
		skippedRelatives.push(...mine.skipped);
		redirectedEdges += mine.redirectedEdges;
		credited += mine.credited;
	}

	// A collision or a failure refuses the whole run: nothing is written, whatever the other artists need.
	const written: string[] = [];
	if (apply && collisions.length === 0 && failed.length === 0) {
		for (const w of pendingWrites) {
			await atomicWriteJson(w.path, w.data);
			written.push(w.path);
		}
	}

	const duplicatesRemoved = rewritten.filter((r) => r.reason === "duplicate-of-scoped").length;
	const manifest: RescopeManifest = {
		migration: MIGRATION_NAME,
		removed: [],
		renamed: {},
		redirects: {},
		summary: {
			artists: artists.size,
			redirectedEdges,
			credited,
			rewritten: rewritten.length,
			duplicatesRemoved,
			skippedAliasOrMember: skippedRelatives.length,
			unjudged: unjudged.length,
			collisions: collisions.length,
			choicesMoved: choicesMoved.length,
		},
		rewritten: rewritten.sort(byEdge),
		skippedAliasOrMember: skippedRelatives.sort(byEdge),
		unjudged: unjudged.sort(byEdge),
		collisions: collisions.sort(byEdge),
		choicesMoved: choicesMoved.sort(byEdge),
		failed: failed.sort((a, b) => compareLex(a.slug, b.slug)),
	};
	await mkdir(dirname(manifestPath), { recursive: true });
	await atomicWriteJson(manifestPath, manifest);
	return { manifest, written, exitCode: failed.length > 0 || collisions.length > 0 ? 1 : 0 };
}

export function formatSummary(result: RescopeResult, apply: boolean, manifestPath: string): string {
	const { manifest, written } = result;
	const s = manifest.summary;
	const lines = [
		`${s.redirectedEdges} redirected edge(s): ${s.credited} credit the artist, ${s.rewritten} rewritten (${s.duplicatesRemoved} duplicate(s) removed), ${s.skippedAliasOrMember} alias/member/group, ${s.unjudged} unjudged`,
		`${s.choicesMoved} landmark/reference pick(s) moved`,
		`${s.collisions} collision(s)${s.collisions > 0 ? ": run refused, nothing written" : ""}`,
		`${manifest.failed.length} failed`,
		apply ? `${written.length} node file(s) written` : "dry-run: no node file written",
		`manifest: ${manifestPath}`,
	];
	for (const c of manifest.collisions)
		lines.push(`collision ${c.artist} ${c.field}: ${c.from} -> ${c.to} (${c.reason})`);
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
			"usage: 2026-10-18-rescope-misdirected-artist-edges.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runRescope({
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
