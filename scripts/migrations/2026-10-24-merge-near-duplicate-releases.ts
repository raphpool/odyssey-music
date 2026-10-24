/**
 * Merge the near-duplicate releases of an artist's discography (TRA-633, PR 2 of 2; the policy that stops minting
 * new ones is PR 1, #618). The key of PR 1 never removes anything, so the twins already in the cache stay: a hand
 * written entry ("800% Ndagga (album)", no mbid) next to the entry the MusicBrainz backfill appended
 * ("800% Ndagga", mbid), or the same entry twice under its legacy slug and its scoped slug.
 *
 * CLOSED LIST. Nothing is guessed here. The pairs to merge are read from the proof table next to this file
 * (2026-10-24-merge-near-duplicate-releases.pairs.json: MusicBrainz looked up on 2026-10-24, one line of evidence
 * per pair, and the `kept` list of look-alikes that were judged distinct and stay). A pair is merged only when the
 * cache is in exactly the state the table describes:
 * - the artist holds BOTH entries, by slug and by name; the survivor carries the table's mbid (when it gives one),
 *   the loser carries no mbid or the same one;
 * - the redirect table has no entry for the loser, or one that already leads to the survivor;
 * - at most one of the two slugs has a project node file. With two, the redirect `loser -> survivor` must be
 *   committed: the repository then already moved the node and the loser is the old copy still on the server (the
 *   union of repository and prod). Its lists are merged into the survivor's node, it is deleted (`renamed`) and
 *   every edge follows. Without the redirect, two bodies of prose are in play and a human picks: the run FAILS
 *   (exit 1, 2 with --apply, so the channel stops) instead of exiting 0 with the pair untouched.
 * Anything else is `flagged` in the manifest and left untouched (exit 0: the channel's preview shows it); a pair
 * whose loser is already gone is `alreadyDone`. The migration therefore runs unchanged on the union of the
 * repository and the server, and a second run writes nothing.
 *
 * Two options added by PR 3 (the last four twins, which the re-review of #632 judged; the migration had not run on
 * prod yet, so they extend this list instead of a sibling migration: one name for the channel):
 * - `kind: "edge-only"`: the artist's entry is already merged and only an edge of a label / genre / project still names
 *   the bare slug (`label:barooni` -> `project:nunatak-gongamur`, no node, no redirect). The artist must hold exactly
 *   the proven survivor and no loser entry. The edge follows (deduplicated), the redirect is posted. It stays
 *   `alreadyDone` only once no node names the slug, so the server's older copy of the label is still cleaned.
 * - `redirect: false`: for a bare slug that belongs to a famous homonym (`project:made-in-japan` is Deep Purple's, the
 *   survivor is Ayumi Hamasaki's). Only the artist's own entry is merged: no redirect is posted and no other node's edge
 *   to the slug is rewritten. A loser that has a node, or that already redirects, is flagged.
 *
 * Merge of a pair. The survivor is the entry that holds the mbid (the release group MusicBrainz names), or, when
 * the table gives `loser.mbid`, the entry that has the node and the title people use (Kraftwerk's English titles):
 * it takes the loser's mbid, year and type and sits in the loser's place. The loser is removed from the artist's `discography` and the artist's `landmark_project` follows if it pointed at the
 * loser. In every node that is NOT an artist (label.notable_releases, genre.landmark_projects, project and track
 * edges), an edge to the loser points at the survivor, with the survivor's name (the audit counts a stale name as
 * drift), deduplicated, but only when the survivor's node, if there is one, points back at that label or genre
 * (the audit does not see an edge to a redirect key; re-pointing it would start counting a missing reverse edge,
 * which is not this migration's to repair): the others stay and are listed in `left`. An edge to a loser whose node
 * moves always follows: the old slug would have no file at all. Another ARTIST's edge to a loser that has no node
 * is never rewritten (a bare legacy slug can be a homonym: `project:birth-of-the-cool` is also Gerry Mulligan's,
 * TRA-672): it is listed in `foreignArtistEdges`.
 * When the loser has a project node and the survivor has none, the node moves to the survivor's slug (its prose is
 * the only copy) and takes the survivor's name. pending-reverses.json follows. `loser -> survivor` goes into
 * slug-redirects.json (`--data-dir`, else the repo's data/), so a link to the old slug still opens the survivor.
 *
 * NOT done here: the 65 slugs that lose a letter (non-Latin titles, `project:bad--hikaru-utada`). They are kept as
 * they are: changing one is an identity decision (TRA-557).
 *
 * Dry-run by default; `--apply` writes. Every node to write is validated (nodePayloadSchema) before the first
 * write; one error blocks the whole run (exit 1, 2 with --apply). Apply order: nodes, pending-reverses.json,
 * redirects, THEN the deletions, so a crash leaves a duplicate (harmless), never a dangling edge. The manifest has
 * no timestamp.
 *
 * Migration channel (deploy/sync-genre-cache.sh): `--apply`, `--manifest` and `--data-dir` are the flags it
 * passes. The manifest declares `renamed` (a moved node: old slug to new slug), `removed` (empty: every deleted
 * file is the old side of a rename) and `redirects`.
 *
 * Usage: tsx scripts/migrations/2026-10-24-merge-near-duplicate-releases.ts <cache-dir> [--apply]
 *        [--manifest out/merge-near-duplicate-releases.json] [--data-dir <dir>]
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { parseSlugRedirects } from "../../src/genre-registry.js";
import { EDGE_FIELDS_BY_TYPE, type NodeType } from "../../src/node-spec.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { parseSlug } from "../../src/slug.js";
import {
	type CacheNodeFile,
	defaultDataDir,
	isRecord,
	looksLikeCacheDir,
	mergeRedirects,
	readCacheNodes,
	readTextOrDefault,
	rewritePendingReverses,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-24-merge-near-duplicate-releases";
export const DEFAULT_MANIFEST_PATH = "out/merge-near-duplicate-releases.json";
export const PAIRS_PATH = join(dirname(fileURLToPath(import.meta.url)), `${MIGRATION_NAME}.pairs.json`);

type Obj = Record<string, unknown>;

const projectSlug = z.string().regex(/^project:.+/u);
const mbid = z.string().uuid();
export const pairsSchema = z.object({
	source: z.string(),
	pairs: z.array(
		z
			.object({
				id: z.string().min(1),
				// release-group: MusicBrainz proves the two titles are one release group. same-node: the two entries
				// already resolve to the same node (same title, same mbid or none, redirect in place). edge-only: the
				// artist's entry is already merged; a label / genre / project still names the bare slug (no node, no
				// redirect), and only that edge follows.
				kind: z.enum(["release-group", "same-node", "edge-only"]),
				artist: z.string().regex(/^artist:.+/u),
				// `false`: no redirect for the loser's slug, and no other node's edge to it is rewritten. For a bare slug
				// that belongs to a famous homonym (`project:made-in-japan` is Deep Purple's): only the artist's own
				// entry is merged. The loser then has no node.
				redirect: z.literal(false).optional(),
				// `mbid` on the loser: the survivor is the entry that has the node and the title people use (Kraftwerk's
				// English titles), the loser is the entry that holds the release group. The survivor takes the loser's
				// mbid, year and type, and the entry keeps the loser's place in the list.
				loser: z.object({ slug: projectSlug, name: z.string().min(1), mbid: mbid.optional() }),
				survivor: z.object({ slug: projectSlug, name: z.string().min(1), mbid: mbid.optional() }),
				evidence: z.string().min(1),
			})
			// An edge-only pair posts the redirect and re-points the edges: it cannot also opt out of them, and it has
			// no entry to adopt a release group from.
			.refine((p) => p.kind !== "edge-only" || (p.redirect === undefined && p.loser.mbid === undefined), {
				message: "an edge-only pair takes neither `redirect: false` nor a loser mbid",
			}),
	),
	// Look-alikes judged distinct: documentation only, never read by the merge.
	kept: z.array(z.object({ artist: z.string(), titles: z.array(z.string()), reason: z.string() })),
});
export type PairsTable = z.infer<typeof pairsSchema>;
type Pair = PairsTable["pairs"][number];

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

export interface Flagged {
	id: string;
	reason: string;
	detail: string;
}
export interface Manifest {
	migration: string;
	mode: "dry-run" | "apply";
	blocked: boolean;
	written: number;
	merged: Array<{ id: string; loser: string; survivor: string; movedNode: boolean }>;
	alreadyDone: string[];
	flagged: Flagged[];
	/** Edges of another artist to a loser slug, left alone (see the header). */
	foreignArtistEdges: Array<{ id: string; artist: string; field: string }>;
	/** Label / genre edges kept on the old slug because the survivor does not point back (see planMerge). */
	left: Array<{ id: string; node: string }>;
	rewritten: Record<string, number>;
	pendingRewritten: number;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	errors: string[];
}

export interface Plan {
	writes: Map<string, Obj>;
	deletions: string[];
	pending: PendingFile | null;
	redirects: Record<string, string>;
	manifest: Manifest;
}

function sorted<T>(items: readonly T[], key: (item: T) => string): T[] {
	return [...items].sort((a, b) => key(a).localeCompare(key(b), "en"));
}

function edgesOf(node: Obj, field: string): Obj[] {
	const value = node[field];
	return (Array.isArray(value) ? value : [value]).filter(isRecord);
}

/** The edge fields of a node type that can point at a project. */
function projectFields(type: NodeType): string[] {
	return Object.entries(EDGE_FIELDS_BY_TYPE[type])
		.filter(([, spec]) => (spec.targets as readonly string[]).includes("project"))
		.map(([field]) => field);
}

const ARTIST_WORK_FIELDS = ["discography", "notable_tracks", "landmark_project"] as const;

interface Target {
	slug: string;
	name: string;
	artist?: string;
}

/** Does the project node point back at `n` (label.notable_releases <-> project.label, genre.landmark_projects <-> project.genres)? */
function answers(n: CacheNodeFile, project: Obj | undefined): boolean {
	if (project === undefined) return true;
	if (n.type === "label") return isRecord(project.label) && project.label.slug === n.slug;
	if (n.type === "genre") return edgesOf(project, "genres").some((g) => g.slug === n.slug);
	return true;
}

/** Does a label, genre, project or track name `slug`? (An artist's edge to a bare slug is never rewritten.) */
function holdsEdgeTo(
	nodes: readonly CacheNodeFile[],
	work: ReadonlyMap<string, Obj>,
	pending: PendingFile,
	slug: string,
): boolean {
	return (
		nodes.some(
			(n) =>
				n.type !== "artist" &&
				projectFields(n.type).some((f) => edgesOf(work.get(n.slug) as Obj, f).some((e) => e.slug === slug)),
		) ||
		// pending-reverses.json: a key or an edge naming the slug follows the survivor too.
		Object.entries(pending).some(([key, list]) => key === slug || list.some((p) => p.edge.slug === slug))
	);
}

/** `node` with every edge of `fields` to a key of `to` pointed at its target; null when nothing changes. */
function repoint(
	node: Obj,
	fields: readonly string[],
	to: ReadonlyMap<string, Target>,
	hits: Map<string, number>,
	label: string,
): Obj | null {
	let next: Obj | null = null;
	for (const field of fields) {
		const value: unknown = (next ?? node)[field];
		const edges = Array.isArray(value) ? value : [value];
		if (!edges.some((e) => isRecord(e) && typeof e.slug === "string" && to.has(e.slug))) continue;
		const seen = new Set<string>();
		const rewritten = edges.flatMap((e) => {
			if (!isRecord(e) || typeof e.slug !== "string") return [e];
			const target = to.get(e.slug);
			let edge: Obj = e;
			if (target) {
				edge = { ...e, slug: target.slug, name: target.name };
				if (target.artist !== undefined) edge.artist = target.artist;
				hits.set(`${label}.${field}`, (hits.get(`${label}.${field}`) ?? 0) + 1);
			}
			if (seen.has(edge.slug as string)) return [];
			seen.add(edge.slug as string);
			return [edge];
		});
		next = { ...(next ?? node), [field]: Array.isArray(value) ? rewritten : rewritten[0] };
	}
	return next;
}

/**
 * The entry that stays in the artist's discography. Usually the survivor's own; when the loser carries the
 * release group (`loser.mbid`), the loser's entry (mbid, year, type, artist) under the survivor's slug and name.
 */
function keptEntry(pair: Pair, discography: readonly Obj[]): Obj {
	const survivor = discography.find((e) => e.slug === pair.survivor.slug) as Obj;
	if (pair.loser.mbid === undefined) return survivor;
	const loser = discography.find((e) => e.slug === pair.loser.slug) as Obj;
	return { ...loser, slug: pair.survivor.slug, name: pair.survivor.name };
}

/**
 * The survivor's node with what only the old copy of it holds: the lists are unioned (the survivor's order first),
 * a single edge (the label) stays the survivor's unless it has none. Prose and scalar fields are the survivor's.
 */
function mergeProjectNodes(survivor: Obj, oldCopy: Obj): Obj {
	const next: Obj = { ...survivor };
	for (const [field, spec] of Object.entries(EDGE_FIELDS_BY_TYPE.project)) {
		if (spec.cardinality === "single") {
			if (!isRecord(survivor[field]) && isRecord(oldCopy[field])) next[field] = oldCopy[field];
			continue;
		}
		const have = edgesOf(survivor, field);
		const seen = new Set(have.map((e) => e.slug));
		const extra = edgesOf(oldCopy, field).filter((e) => typeof e.slug === "string" && !seen.has(e.slug));
		if (extra.length > 0) next[field] = [...have, ...extra];
	}
	return next;
}

/** Pure plan: what to merge, write and report. Does not touch the disk. */
export function planMerge(
	nodes: readonly CacheNodeFile[],
	pending: PendingFile,
	table: PairsTable,
	existingRedirects: Readonly<Record<string, string>>,
	cacheDir: string,
): Plan {
	const manifest: Manifest = {
		migration: MIGRATION_NAME,
		mode: "dry-run",
		blocked: false,
		written: 0,
		merged: [],
		alreadyDone: [],
		flagged: [],
		foreignArtistEdges: [],
		left: [],
		rewritten: {},
		pendingRewritten: 0,
		removed: [],
		renamed: {},
		redirects: {},
		errors: [],
	};
	const bySlug = new Map(nodes.map((n) => [n.slug, n]));
	const work = new Map<string, Obj>(nodes.map((n) => [n.slug, n.node]));
	const accepted: Pair[] = [];
	const oldCopies = new Set<string>();
	const flag = (pair: Pair, reason: string, detail: string): void => {
		manifest.flagged.push({ id: pair.id, reason, detail });
	};

	for (const pair of sorted(table.pairs, (p) => p.id)) {
		const artist = work.get(pair.artist);
		const disc = artist && Array.isArray(artist.discography) ? artist.discography.filter(isRecord) : null;
		if (!artist || !disc) {
			flag(pair, "artist-missing", `${pair.artist} has no discography in this cache`);
			continue;
		}
		const survivor = disc.find((e) => e.slug === pair.survivor.slug);
		const loser = disc.find((e) => e.slug === pair.loser.slug);
		if (pair.kind === "edge-only") {
			if (
				loser ||
				!survivor ||
				survivor.name !== pair.survivor.name ||
				survivor.mbid !== pair.survivor.mbid
			) {
				flag(
					pair,
					"state-differs",
					"the artist does not hold exactly the proven survivor and no loser entry",
				);
			} else if (bySlug.has(pair.loser.slug)) {
				flag(pair, "state-differs", `${pair.loser.slug} has a node: not a bare edge`);
			} else if (
				existingRedirects[pair.loser.slug] !== undefined &&
				existingRedirects[pair.loser.slug] !== pair.survivor.slug
			) {
				flag(
					pair,
					"redirect-conflict",
					`${pair.loser.slug} already redirects to ${existingRedirects[pair.loser.slug]}`,
				);
			} else if (holdsEdgeTo(nodes, work, pending, pair.loser.slug)) accepted.push(pair);
			else manifest.alreadyDone.push(pair.id);
			continue;
		}
		if (pair.redirect === false && loser) {
			if (bySlug.has(pair.loser.slug)) {
				flag(pair, "state-differs", `${pair.loser.slug} has a node and no redirect would lead anywhere`);
				continue;
			}
			if (existingRedirects[pair.loser.slug] !== undefined) {
				flag(pair, "redirect-conflict", `${pair.loser.slug} is a homonym's slug and already redirects`);
				continue;
			}
		}
		if (!loser) {
			if (survivor) manifest.alreadyDone.push(pair.id);
			else flag(pair, "state-differs", "neither the loser nor the survivor is in the discography");
			continue;
		}
		if (!survivor) {
			flag(pair, "state-differs", `the survivor ${pair.survivor.slug} is not in the discography`);
			continue;
		}
		if (survivor.name !== pair.survivor.name || loser.name !== pair.loser.name) {
			flag(pair, "state-differs", `names are "${String(loser.name)}" / "${String(survivor.name)}"`);
			continue;
		}
		if (pair.loser.mbid !== undefined) {
			// The survivor adopts the loser's release group.
			if (loser.mbid !== pair.loser.mbid || (survivor.mbid !== undefined && survivor.mbid !== loser.mbid)) {
				flag(
					pair,
					"state-differs",
					`the mbid is ${String(loser.mbid)} / ${String(survivor.mbid)}, not the proven one`,
				);
				continue;
			}
		} else {
			if (pair.survivor.mbid !== undefined && survivor.mbid !== pair.survivor.mbid) {
				flag(pair, "state-differs", `the survivor carries mbid ${String(survivor.mbid)}, not the proven one`);
				continue;
			}
			if (loser.mbid !== undefined && loser.mbid !== survivor.mbid) {
				flag(pair, "state-differs", `the loser carries its own mbid ${String(loser.mbid)}`);
				continue;
			}
		}
		const redirect = existingRedirects[pair.loser.slug];
		if (redirect !== undefined && redirect !== pair.survivor.slug) {
			flag(pair, "redirect-conflict", `${pair.loser.slug} already redirects to ${redirect}`);
			continue;
		}
		if (bySlug.has(pair.loser.slug) && bySlug.has(pair.survivor.slug)) {
			if (redirect === pair.survivor.slug) {
				// The repository already moved the node and committed the redirect: this one is the old copy.
				oldCopies.add(pair.id);
			} else {
				// Two bodies of prose and no committed decision: this is not for the migration to pick. It blocks
				// the run (a flag exits 0 and the channel would ship the half-merged state).
				manifest.errors.push(
					`${pair.id}: ${pair.loser.slug} and ${pair.survivor.slug} both have a node and the redirect is not committed: a human picks the prose to keep`,
				);
				continue;
			}
		}
		accepted.push(pair);
	}

	// loser slug -> where its edges go. One loser, one survivor.
	const targetOf = new Map<string, Target>();
	for (const pair of accepted) {
		const prior = targetOf.get(pair.loser.slug);
		if (prior && prior.slug !== pair.survivor.slug) {
			manifest.errors.push(
				`${pair.loser.slug} would go to two survivors (${prior.slug}, ${pair.survivor.slug})`,
			);
			continue;
		}
		const artist = work.get(pair.artist) as Obj;
		const entry = keptEntry(pair, artist.discography as Obj[]);
		targetOf.set(pair.loser.slug, {
			slug: pair.survivor.slug,
			name: pair.survivor.name,
			...(typeof entry.artist === "string" ? { artist: entry.artist } : {}),
		});
	}
	// A slug without redirect (a homonym's) is followed by the artist's own entry only, never by another node's edge.
	const noRedirect = new Set(accepted.filter((p) => p.redirect === false).map((p) => p.loser.slug));
	const repointTo = new Map([...targetOf].filter(([slug]) => !noRedirect.has(slug)));

	// The node each loser's edges will land on: the survivor's, or the loser's own once it has moved.
	const survivorNodeOf = new Map<string, Obj | undefined>(
		accepted.map((p) => [p.loser.slug, (bySlug.get(p.survivor.slug) ?? bySlug.get(p.loser.slug))?.node]),
	);
	const touched = new Set<string>();
	const hits = new Map<string, number>();
	const deletions: string[] = [];
	const writes = new Map<string, Obj>();
	const redirects: Record<string, string> = {};

	for (const pair of accepted) {
		if (pair.kind === "edge-only") {
			// The artist is already right: only the redirect, and the edges re-pointed below.
			if (existingRedirects[pair.loser.slug] === undefined) redirects[pair.loser.slug] = pair.survivor.slug;
			manifest.merged.push({
				id: pair.id,
				loser: pair.loser.slug,
				survivor: pair.survivor.slug,
				movedNode: false,
			});
			continue;
		}
		const target = targetOf.get(pair.loser.slug) as Target;
		const artist = work.get(pair.artist) as Obj;
		const kept = keptEntry(pair, artist.discography as Obj[]);
		const next: Obj = {
			...artist,
			// The survivor entry stays where it is, or, when it adopts the loser's release group, takes the
			// loser's place (the list is sorted by year).
			discography: (artist.discography as Obj[]).flatMap((e) => {
				if (e.slug === pair.loser.slug) return pair.loser.mbid !== undefined ? [kept] : [];
				if (e.slug === pair.survivor.slug && pair.loser.mbid !== undefined) return [];
				return [e];
			}),
		};
		const landmark = artist.landmark_project;
		if (isRecord(landmark) && landmark.slug === pair.loser.slug) {
			next.landmark_project = {
				slug: target.slug,
				type: "project",
				name: target.name,
				...(target.artist !== undefined ? { artist: target.artist } : {}),
			};
			hits.set("artist.landmark_project", (hits.get("artist.landmark_project") ?? 0) + 1);
		}
		hits.set("artist.discography", (hits.get("artist.discography") ?? 0) + 1);
		work.set(pair.artist, next);
		touched.add(pair.artist);
		if (oldCopies.has(pair.id)) {
			work.set(
				pair.survivor.slug,
				mergeProjectNodes(work.get(pair.survivor.slug) as Obj, work.get(pair.loser.slug) as Obj),
			);
			touched.add(pair.survivor.slug);
		}
		if (pair.redirect !== false && existingRedirects[pair.loser.slug] === undefined)
			redirects[pair.loser.slug] = pair.survivor.slug;
		manifest.merged.push({
			id: pair.id,
			loser: pair.loser.slug,
			survivor: pair.survivor.slug,
			movedNode: bySlug.has(pair.loser.slug),
		});
	}

	// Edges of the other nodes. An artist is only rewritten through its own pair (above).
	const artistsWithPair = new Set(accepted.map((p) => `${p.artist} ${p.loser.slug}`));
	const foreign = new Map<string, { id: string; artist: string; field: string }>();
	// A loser whose node moves leaves its slug for good: every edge to it follows, whoever holds it.
	const movedTo = new Map([...repointTo].filter(([slug]) => bySlug.has(slug)));
	for (const n of nodes) {
		if (n.type === "artist") {
			for (const field of ARTIST_WORK_FIELDS) {
				for (const e of edgesOf(work.get(n.slug) as Obj, field)) {
					const slug = typeof e.slug === "string" ? e.slug : "";
					if (!repointTo.has(slug) || movedTo.has(slug) || artistsWithPair.has(`${n.slug} ${slug}`)) continue;
					const pair = accepted.find((p) => p.loser.slug === slug) as Pair;
					foreign.set(`${pair.id} ${n.slug} ${field}`, { id: pair.id, artist: n.slug, field });
				}
			}
			const next = repoint(work.get(n.slug) as Obj, ARTIST_WORK_FIELDS, movedTo, hits, "artist(other)");
			if (next) {
				work.set(n.slug, next);
				touched.add(n.slug);
			}
			continue;
		}
		// A label or a genre only follows when the survivor's node answers it (project.label, project.genres):
		// the audit does not see an edge to a redirect key, and would start counting the missing reverse edge.
		const current = work.get(n.slug) as Obj;
		const fields = projectFields(n.type);
		const to = new Map(
			[...repointTo].filter(([loserSlug]) => {
				const held = fields.some((f) => edgesOf(current, f).some((e) => e.slug === loserSlug));
				if (!held || movedTo.has(loserSlug) || answers(n, survivorNodeOf.get(loserSlug))) return true;
				const pair = accepted.find((p) => p.loser.slug === loserSlug) as Pair;
				manifest.left.push({ id: pair.id, node: n.slug });
				return false;
			}),
		);
		const next = repoint(current, fields, to, hits, n.type);
		if (next) {
			work.set(n.slug, next);
			touched.add(n.slug);
		}
	}
	manifest.left = sorted(manifest.left, (l) => `${l.id} ${l.node}`);
	manifest.foreignArtistEdges = sorted([...foreign], ([k]) => k).map(([, v]) => v);

	// A loser's project node moves to the survivor's slug (and name).
	for (const pair of accepted) {
		const moved = bySlug.get(pair.loser.slug);
		if (!moved) continue;
		if (!oldCopies.has(pair.id)) {
			const body = parseSlug(pair.survivor.slug).body;
			const node = {
				...(work.get(pair.loser.slug) as Obj),
				slug: pair.survivor.slug,
				name: pair.survivor.name,
			};
			writes.set(join(cacheDir, "nodes", "project", `${body}.json`), node);
		}
		deletions.push(moved.path);
		manifest.renamed[pair.loser.slug] = pair.survivor.slug;
		touched.delete(pair.loser.slug);
	}
	for (const slug of touched) {
		const n = bySlug.get(slug) as CacheNodeFile;
		writes.set(n.path, work.get(slug) as Obj);
	}

	// Each node to write is validated before the caller writes any, and the validation must not drop a field.
	const checked = new Map<string, Obj>();
	for (const [path, node] of sorted([...writes], ([p]) => p)) {
		const parsed = nodePayloadSchema.safeParse(node);
		if (!parsed.success)
			manifest.errors.push(
				`${String(node.slug)}: refusing to write an invalid node: ${parsed.error.message}`,
			);
		else if (!onlyAddsSchemaDefaults(node, parsed.data))
			manifest.errors.push(
				`${String(node.slug)}: refusing to write: validation would alter fields the node carries`,
			);
		// The node as read, not the parsed copy: the schema reorders keys, which would rewrite every line of an
		// artist file for the sake of one removed entry. Validation only adds defaults (checked above).
		else checked.set(path, node);
	}
	manifest.written = checked.size;
	manifest.rewritten = Object.fromEntries(sorted([...hits], ([k]) => k));
	manifest.redirects = Object.fromEntries(sorted(Object.entries(redirects), ([k]) => k));
	manifest.flagged = sorted(manifest.flagged, (f) => f.id);
	manifest.alreadyDone.sort();

	// pending-reverses.json: a key or an edge naming a loser follows the survivor (and its name).
	const renamedPending = Object.fromEntries(
		Object.entries(structuredClone(pending)).map(([k, list]) => [
			k,
			list.map((p) => {
				const target = repointTo.get(p.edge.slug);
				return target ? { ...p, edge: { ...p.edge, name: target.name } } : p;
			}),
		]),
	);
	const rewrittenPending = rewritePendingReverses(
		renamedPending,
		new Map([...repointTo].map(([from, to]) => [from, to.slug])),
	);
	manifest.pendingRewritten = Object.entries(pending).reduce(
		(sum, [key, list]) =>
			sum + (repointTo.has(key) ? list.length : list.filter((p) => repointTo.has(p.edge.slug)).length),
		0,
	);
	return {
		writes: checked,
		deletions,
		pending: rewrittenPending.changed ? rewrittenPending.result : null,
		redirects,
		manifest,
	};
}

export interface RunOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	/** Directory holding slug-redirects.json (the channel's `--data-dir`); the repo's data/ by default. */
	dataDir?: string;
	/** The proof table; the committed one by default. */
	table?: PairsTable;
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

	let table = options.table;
	if (!table) {
		try {
			table = pairsSchema.parse(JSON.parse(await readFile(PAIRS_PATH, "utf8")));
		} catch (e) {
			errors.push(`proof table unreadable: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	const redirectsPath = join(options.dataDir ?? defaultDataDir(), "slug-redirects.json");
	let existing: Record<string, string> = {};
	let redirectsError: string | null = null;
	try {
		const raw = JSON.parse(await readTextOrDefault(redirectsPath, '{"redirects":{}}')) as Obj;
		parseSlugRedirects(raw);
		existing = raw.redirects as Record<string, string>;
	} catch (e) {
		redirectsError = `${redirectsPath} is unreadable: ${e instanceof Error ? e.message : String(e)}`;
	}

	const plan = planMerge(nodes, pending, table ?? { source: "", pairs: [], kept: [] }, existing, cacheDir);
	const manifest = plan.manifest;
	manifest.errors.push(...errors);
	if (redirectsError) manifest.errors.push(redirectsError);

	let mergedRedirects = existing;
	if (!redirectsError && Object.keys(plan.redirects).length > 0) {
		try {
			mergedRedirects = mergeRedirects(existing, plan.redirects);
			parseSlugRedirects({ redirects: mergedRedirects });
			const live = new Set(nodes.filter((n) => !plan.deletions.includes(n.path)).map((n) => n.slug));
			for (const key of Object.keys(plan.redirects)) {
				if (live.has(key)) manifest.errors.push(`redirect key ${key} is also a live node after the merge`);
			}
		} catch (e) {
			manifest.errors.push(
				`${redirectsPath} cannot take the redirects: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	manifest.blocked = manifest.errors.length > 0;
	if (apply) manifest.mode = "apply";
	if (apply && !manifest.blocked) {
		for (const [path, node] of plan.writes) await atomicWriteJson(path, node);
		if (plan.pending) await atomicWriteJson(pendingPath, plan.pending);
		if (Object.keys(plan.redirects).length > 0) {
			await mkdir(dirname(redirectsPath), { recursive: true });
			// Like the genre and label merges: this run is the table's new source, stamped only when it changes.
			await atomicWriteJson(redirectsPath, {
				source: "near-duplicate release merge (TRA-633)",
				generated_at: new Date().toISOString(),
				redirects: mergedRedirects,
			});
		}
		for (const path of plan.deletions) await rm(path);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: manifest.blocked ? (apply ? 2 : 1) : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	for (const m of manifest.merged)
		lines.push(`  merged  ${m.loser} -> ${m.survivor}${m.movedNode ? " (node moved)" : ""}`);
	for (const id of manifest.alreadyDone) lines.push(`  done    ${id}`);
	for (const f of manifest.flagged) lines.push(`  flagged ${f.id}: ${f.reason} (${f.detail})`);
	for (const l of manifest.left)
		lines.push(`  left    ${l.node} keeps its edge to ${l.id}'s old slug (no reverse edge)`);
	for (const f of manifest.foreignArtistEdges)
		lines.push(`  foreign ${f.id}: ${f.artist} ${f.field} still names the old slug`);
	for (const [field, n] of Object.entries(manifest.rewritten))
		lines.push(`  ${field.padEnd(28)} ${n} edge(s) re-pointed`);
	lines.push(
		`  node files written ${manifest.written}, pending entries re-pointed ${manifest.pendingRewritten}`,
	);
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
			"usage: 2026-10-24-merge-near-duplicate-releases.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
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
