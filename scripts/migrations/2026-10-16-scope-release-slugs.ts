/**
 * Scope the work slugs (TRA-478, plan docs/plans/graph-integrity.md, part 1, decision 1): a project or
 * track becomes `<title>--<primary credit>`, every incoming edge follows, the duplicates that collapse
 * onto the same identity are merged, and the old slugs go to data/slug-redirects.json. The same pass
 * applies the TRA-528/TRA-531 transliteration (`MØ` -> `artist:mo`) to artist and label nodes and to
 * the dangling edge targets, because both rename sets share one flag (ODYSSEY_SCOPED_RELEASE_SLUGS)
 * and one redirect table. Offline and deterministic: no network, no LLM.
 *
 * Safety rules (safety before rate):
 * - Dry-run by default. `--apply` writes nothing unless the whole plan validates (no stale edge, every
 *   written node passes nodePayloadSchema without losing a field, the redirect table parses); an
 *   invariant violation exits 1 and leaves the cache untouched. Idempotent: a second run plans nothing.
 * - The flag must be ON: the target slugs depend on it. The script refuses to run otherwise (exit 2).
 * - An incoming `artist.discography` / `notable_tracks` edge follows a renamed work only when the source
 *   artist is credited on it (or is a member of a credited group). Otherwise it is DETACHED: it keeps
 *   pointing at a slug scoped by the source artist (`track:fitna--rohff`), a dangling target that can be
 *   materialized later, instead of silently resolving to the namesake's work (Rohff -> Akuma's Fitna).
 * - Two nodes that land on one slug are merged only if their identity agrees (same mbid, or no mbid on
 *   one side and the same credit); otherwise it is a listed conflict and nothing is written for them.
 * - A dangling target named two ways ("MØ" and "M" on `artist:m`) is a listed conflict, never rewritten
 *   edge by edge. A slug that cannot be re-derived from the name (free-text legacy disambiguator on a
 *   transliterated title) is left as is and listed.
 *
 * Writes go through atomicWriteJson after nodePayloadSchema validation, deliberately not through
 * NodeCache.write or NodeCache.update (TRA-535): both go through the cache's write path, which emits
 * reverse edges and merges pending ones, and a rename must not invent edges (that is the reverse-edge
 * backfill, 2.2). The only pending entries applied here are those of a key this run moved onto an
 * existing node. A migration also rewrites many nodes in one plan, validated as a whole before the
 * first write, which a per-node read-modify-write does not give.
 *
 * THE GUARANTEE is an invariant on the finished plan, validatePlan, checked before any write: no edge ends up
 * resolving to a node of another identity than its reference (mbid, credit, name), whichever path produced it.
 * A violation refuses the run (exit 2 with --apply, 1 in a dry-run), listed in `invariantViolations`; nothing
 * is resolved automatically. The per-path guards below are DIAGNOSTICS: they say early, and with a precise
 * reason, why a rename was not made. A path they miss is still caught by the invariant.
 *
 * Where a slug can land on a node that already exists, and the diagnostic each path goes through (one function,
 * facetsDisagreement: different mbids never agree, otherwise the folded credit/name must; no agreement = a
 * reported conflict, no rewrite, no redirect):
 *   1. a renamed or merged node onto an existing node, or two nodes onto one slug: identityDisagreement
 *      (members of a manifest collision are settled by the manifest's mbid, others must agree with them);
 *   2. a dangling edge target whose transliterated slug is a node: the node against every reference to it
 *      ("dangling-target"); the benign Lætitia / Laetitia stays (æ -> ae is one spelling), MØ / Mo does not;
 *   3. a pending-reverses key: it only moves along a redirect of path 1 or 2, so it inherits their guard;
 *   4. a detached edge whose source-scoped slug is a node: that node must be credited to the same artist
 *      ("detach-target", refused as an error since the old slug is being retired);
 *   5. an edge rewritten through a redirect: the redirects come from paths 1 and 2, or from an earlier run's
 *      table, which went through the same guards.
 *
 * Order of execution (TRA-483): the artist identity backfill (TRA-463) is APPLIED first, then the work identity
 * backfill (TRA-474), then this migration. The artist manifest names collisions by mbid; `--apply` is refused
 * (exit 2) while a node of a collision does not carry the mbid the manifest gives it.
 *
 * Apply order: new node files -> redirects -> nodes whose edges changed -> pending-reverses.json -> `rm` of the
 * old files last. What is guaranteed after a crash at ANY of those writes (tested at each one, with a renamed
 * node pointing at another renamed node): a plain re-run of this script exits 0 and leaves the cache a clean
 * run would have left. Edges also follow the redirects an interrupted run already wrote, and an old node that
 * survived merges into its new slug. What is NOT guaranteed is the state in between: until the re-run the cache
 * can hold both the old and the new node, and, once removals have started, an old file can still point at a
 * node that is gone. So after a crash: re-run (or restore), and do not serve or ship that cache first.
 * Edges are never de-duplicated wholesale: only a collision this run creates is folded (same mbid, or none) or
 * reported (different mbids, all kept); duplicates already in a list are left alone (TRA-557). A rename never
 * overwrites a file it cannot read (reported as a conflict), and pending-reverses entries that cannot be applied
 * to a node kept as is stay under their key. The real run is TRA-483 (repo) and TRA-484 (prod, through the
 * migration channel of deploy/sync-genre-cache.sh, which reads the manifest written here).
 *
 * Usage: ODYSSEY_SCOPED_RELEASE_SLUGS=1 tsx scripts/migrations/2026-10-16-scope-release-slugs.ts <cache-dir>
 *        [--apply] [--manifest out/scope-release-slugs.json] [--artist-manifest out/artist-identity.json]
 *        [--redirects data/slug-redirects.json]
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { scopedReleaseSlugsEnabled } from "../../src/flags.js";
import { parseSlugRedirects } from "../../src/genre-registry.js";
import { LIST_EDGES_BY_TYPE, type NodeType, SINGULAR_EDGES_BY_TYPE } from "../../src/node-spec.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import {
	hasTransliteratedLetter,
	isReadableSlug,
	makeScopedSlug,
	normalizeSlugBody,
	parseSlug,
	pickScopeArtistName,
	scopeMatchesArtist,
	transliteratedSlug,
} from "../../src/slug.js";
import {
	type CacheNodeFile,
	defaultDataDir,
	isRecord,
	looksLikeCacheDir,
	mergeRedirects,
	readCacheNodes,
	readTextOrDefault,
	rewritePendingReverses,
	unionSingularField,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-16-scope-release-slugs";
export const DEFAULT_MANIFEST_PATH = "out/scope-release-slugs.json";
export const DEFAULT_ARTIST_MANIFEST_PATH = "out/artist-identity.json";

type Obj = Record<string, unknown>;

// Artist fields whose edges name a work on behalf of the artist: following a rename is conditioned on
// the credit. landmark_project / reference_track are chosen among the first two (TRA-457), so they must
// make the same decision or an artist would keep a flagship album it no longer lists.
const CREDITED_FIELDS = ["discography", "notable_tracks", "landmark_project", "reference_track"] as const;

// --- Report shapes ---

export interface DetachedEdge {
	node: string;
	field: string;
	from: string;
	to: string;
	name: string;
}
export interface RewrittenEdge {
	node: string;
	from: string;
	to: string;
	count: number;
}
export interface MergeEntry {
	slug: string;
	winner: string;
	losers: string[];
	criterion: string;
}
export interface FoldedEdge {
	node: string;
	field: string;
	before: Obj[];
	after: Obj;
}
export interface Conflict {
	kind:
		| "merge"
		| "chain"
		| "transliteration"
		| "edge-mbid"
		| "unreadable-target"
		| "dangling-target"
		| "detach-target";
	slugs: string[];
	reason: string;
}
export interface Reported {
	slug: string;
	reason: string;
}

export interface InvariantViolation {
	node: string;
	field: string;
	from: string;
	to: string;
	reason: string;
}

export interface Manifest {
	migration: string;
	generated_at: string;
	mode: "dry-run" | "apply";
	/** Contract of the migration channel (deploy/sync-genre-cache.sh, TRA-464): the four keys below. */
	renamed: Record<string, string>;
	removed: string[];
	redirects: Record<string, string>;
	written: number;
	detached: DetachedEdge[];
	merged: MergeEntry[];
	skipped: Reported[];
	not_derivable: Reported[];
	/** Unreadable node files and nodes kept as they are because they would not validate. */
	malformed: Reported[];
	/** Edges that would resolve to a node of another identity than their reference: the run is refused. */
	invariantViolations: InvariantViolation[];
	/** Edges folded because THIS run made them collide (never a duplicate that was already there). */
	folded: FoldedEdge[];
	conflicts: Conflict[];
	rewritten: RewrittenEdge[];
	self_edges_removed: { node: string; field: string }[];
	pending_reverses: { from: string; to: string }[];
	errors: string[];
	notes: string[];
	summary: Record<string, number>;
}

export interface ArtistIdentities {
	/** Artist slug -> MBIDs of the groups it belongs to (artist-identity manifest, TRA-463). */
	groups: ReadonlyMap<string, readonly string[]>;
	collisions: readonly { mbid: string; slugs: readonly string[] }[];
}

export const NO_IDENTITIES: ArtistIdentities = { groups: new Map(), collisions: [] };

// --- Small helpers ---

function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function edgeList(value: unknown): Obj[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Every edge of a node, list and singular fields alike, with its field name. */
function allEdges(node: Obj, type: NodeType): { field: string; edge: Obj }[] {
	const out: { field: string; edge: Obj }[] = [];
	for (const field of LIST_EDGES_BY_TYPE[type])
		for (const edge of edgeList(node[field])) out.push({ field, edge });
	for (const field of SINGULAR_EDGES_BY_TYPE[type]) {
		const edge = node[field];
		if (isRecord(edge)) out.push({ field, edge });
	}
	return out;
}

function sortedUnique(values: Iterable<string>): string[] {
	return [...new Set(values)].sort();
}

// --- Election and merge ---

function rank(file: CacheNodeFile): { citations: number; edges: number } {
	return {
		citations: Array.isArray(file.node.citations) ? file.node.citations.length : 0,
		edges: allEdges(file.node, file.type).length,
	};
}

/** Winner = (artist collisions only) a slug without "--", then more citations, more edges, shorter slug. */
export function elect(
	members: readonly CacheNodeFile[],
	preferBare: boolean,
): { winner: CacheNodeFile; criterion: string } {
	const keyed = members.map((file) => ({ file, ...rank(file) }));
	const compare = (a: (typeof keyed)[number], b: (typeof keyed)[number]): [number, string] => {
		const bare = (s: string): number => (preferBare && s.includes("--") ? 1 : 0);
		const steps: [string, number][] = [
			["no-disambiguator", bare(a.file.slug) - bare(b.file.slug)],
			["citations", b.citations - a.citations],
			["edges", b.edges - a.edges],
			["slug-length", a.file.slug.length - b.file.slug.length],
			["slug-order", a.file.slug < b.file.slug ? -1 : a.file.slug > b.file.slug ? 1 : 0],
		];
		const decisive = steps.find(([, diff]) => diff !== 0);
		return decisive ? [decisive[1], decisive[0]] : [0, "tie"];
	};
	const sorted = [...keyed].sort((a, b) => compare(a, b)[0]);
	const [first, second] = sorted;
	if (!first) throw new Error("elect: empty group");
	return { winner: first.file, criterion: second ? compare(first, second)[1] : "single" };
}

/** Informative = more filled keys, an mbid counting most (it is what the JIT click sends back). */
function informativeness(edge: Obj): number {
	return Object.values(edge).filter((v) => v !== undefined && v !== "").length + (str(edge.mbid) ? 10 : 0);
}

/** One edge out of colliding ones: the most informative, completed with keys only others have. Null if their mbids differ. */
export function foldEdges(edges: readonly Obj[]): Obj | null {
	if (sortedUnique(edges.flatMap((e) => str(e.mbid) ?? [])).length > 1) return null;
	const [best, ...others] = [...edges].sort((a, b) => informativeness(b) - informativeness(a));
	const out: Obj = { ...best };
	for (const other of others)
		for (const [k, v] of Object.entries(other)) if (out[k] === undefined) out[k] = v;
	return out;
}

/**
 * Rewrites the edges of `node` through `map` (old slug -> new slug) and drops self-edges. Unlike
 * rewriteNodeEdges it never de-duplicates by slug on its own: three edges with one slug and three
 * mbids ("Booty La La" and its remixes) are three works, and a duplicate that was already there is not
 * this migration's to remove. Only a collision CREATED by a rewrite is folded (foldEdges), and two
 * mbids that disagree are kept side by side and reported.
 */
export function rewriteEdges(
	node: Obj,
	type: NodeType,
	map: Readonly<Record<string, string>>,
	ownSlug: string,
): { node: Obj; hits: Map<string, number>; folded: FoldedEdge[]; conflicts: Conflict[] } {
	const hits = new Map<string, number>();
	const folded: FoldedEdge[] = [];
	const conflicts: Conflict[] = [];
	const next: Obj = { ...node };
	const move = (
		edge: unknown,
	): { orig: unknown; edge: unknown; slug: string | undefined; moved: boolean } => {
		const slug = isRecord(edge) ? str(edge.slug) : undefined;
		const to = slug ? map[slug] : undefined;
		if (slug && to) hits.set(slug, (hits.get(slug) ?? 0) + 1);
		return {
			orig: edge,
			edge: to && isRecord(edge) ? { ...edge, slug: to } : edge,
			slug: to ?? slug,
			moved: to !== undefined,
		};
	};
	for (const field of LIST_EDGES_BY_TYPE[type]) {
		const list = node[field];
		if (!Array.isArray(list)) continue;
		const kept = list.map(move).filter((e) => e.slug !== ownSlug);
		const groups = new Map<string, typeof kept>();
		for (const e of kept) if (e.slug) groups.set(e.slug, [...(groups.get(e.slug) ?? []), e]);
		const out: unknown[] = [];
		const done = new Set<string>();
		for (const e of kept) {
			const group = e.slug ? groups.get(e.slug) : undefined;
			if (!e.slug || !group || group.length < 2 || !group.some((g) => g.moved)) {
				out.push(e.edge);
				continue;
			}
			const one = foldEdges(group.map((g) => g.edge as Obj));
			if (one === null) {
				out.push(e.edge);
				if (!done.has(e.slug)) {
					const mbids = sortedUnique(group.flatMap((g) => str((g.edge as Obj).mbid) ?? []));
					conflicts.push({
						kind: "edge-mbid",
						slugs: [`${ownSlug}.${field}`, e.slug],
						reason: `edges collide on ${e.slug} with different mbids (${mbids.join(", ")}): all kept`,
					});
				}
			} else if (!done.has(e.slug)) {
				out.push(one);
				folded.push({ node: ownSlug, field, before: group.map((g) => g.orig as Obj), after: one });
			}
			done.add(e.slug);
		}
		next[field] = out;
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[type]) {
		if (!isRecord(node[field])) continue;
		const e = move(node[field]);
		next[field] = e.slug === ownSlug ? undefined : e.edge;
	}
	return { node: next, hits, folded, conflicts };
}

/**
 * Winner content under `slug`. The winner's lists stay as they are; a loser's edge is added when its slug
 * is not there yet, or when it carries another mbid than the one there (two works, both kept and reported
 * through `onConflict`). Singulars from the winner, mbid from whoever has it.
 */
export function mergeNodes(
	winner: CacheNodeFile,
	losers: readonly CacheNodeFile[],
	slug: string,
	onConflict: (field: string, edgeSlug: string) => void = () => {},
): Obj {
	const out: Obj = { ...winner.node, slug };
	for (const field of LIST_EDGES_BY_TYPE[winner.type]) {
		if ([winner, ...losers].every((f) => f.node[field] === undefined)) continue;
		const list = edgeList(winner.node[field]);
		const have = new Set(list.map((e) => str(e.slug)));
		for (const loser of losers) {
			const added = new Set<string>();
			for (const edge of edgeList(loser.node[field])) {
				const edgeSlug = str(edge.slug);
				if (edgeSlug === undefined || !have.has(edgeSlug)) {
					list.push(edge);
					if (edgeSlug !== undefined) added.add(edgeSlug);
					continue;
				}
				const mbid = str(edge.mbid);
				const clash =
					mbid !== undefined &&
					!list.some((e) => e.slug === edgeSlug && (str(e.mbid) === mbid || !str(e.mbid)));
				if (clash) {
					list.push(edge);
					onConflict(field, edgeSlug);
				}
			}
			for (const a of added) have.add(a);
		}
		out[field] = list;
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[winner.type]) {
		const value = unionSingularField(
			winner.node[field],
			losers.map((l) => l.node[field]),
		);
		if (value !== undefined) out[field] = value;
	}
	const mbid = str(winner.node.mbid) ?? losers.map((l) => str(l.node.mbid)).find((m) => m !== undefined);
	if (mbid !== undefined) out.mbid = mbid;
	return out;
}

// Letters whose standard ASCII spelling is several letters (æ -> ae, Lætitia / Laetitia): the same name.
// Single-letter substitutions of the slug table (ø -> o, ł -> l...) are NOT folded here: "MØ" and "Mo" share a
// slug and are not known to be one artist.
const EXPANSIONS: Record<string, string> = { æ: "ae", œ: "oe", ß: "ss", þ: "th" };
const fold = (text: string): string =>
	text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.toLowerCase()
		.replace(/[æœßþ]/g, (c) => EXPANSIONS[c] ?? c);

/** What the identity guard looks at: the mbid when known and the credit (a work's primary credit, an artist's name). */
export interface IdentityFacet {
	slug: string;
	mbid: string | undefined;
	credit: string;
}

export function nodeFacet(m: CacheNodeFile): IdentityFacet {
	const credit =
		m.type === "project" || m.type === "track" ? str(edgeList(m.node.artists)[0]?.name) : str(m.node.name);
	return { slug: m.slug, mbid: str(m.node.mbid), credit: fold(credit ?? "") };
}

/** A citation of a node by an edge: the edge's mbid, and its name (an artist, label...) or its `artist` (a work). */
export function referenceFacet(
	slug: string,
	ref: { name: string; artist: string | undefined; mbid: string | undefined },
	work: boolean,
): IdentityFacet {
	return { slug: `ref:${slug}`, mbid: ref.mbid, credit: fold((work ? ref.artist : ref.name) ?? "") };
}

/**
 * THE identity guard, used by every path where a slug lands on a node (see the header for the list). Null when
 * the facets may share one slug, else why not. Sharing a slug is not sharing an identity ("Mo" and "MØ" both
 * give `artist:mo`): different mbids never agree, and as soon as one facet has no mbid the credits have to
 * agree. `settled`: slug -> mbid of the collisions of the artist manifest inside the group, which MusicBrainz
 * already settled. That mbid joins the comparison. They are exempt from the credit check among themselves
 * ("Pole" and "Pole (Stefan Betke)"), but any other facet still has to agree with them.
 */
export function facetsDisagreement(
	facets: readonly IdentityFacet[],
	settled: ReadonlyMap<string, string> = new Map(),
): string | null {
	const mbids = sortedUnique([...facets.flatMap((f) => f.mbid ?? []), ...settled.values()]);
	if (mbids.length > 1) return `different mbids: ${mbids.join(", ")}`;
	const outsiders = facets.filter((f) => !settled.has(f.slug));
	if (outsiders.every((f) => f.mbid !== undefined)) return null;
	const credits = sortedUnique(outsiders.map((f) => f.credit));
	const inside = new Set(facets.filter((f) => settled.has(f.slug)).map((f) => f.credit));
	const agree =
		credits.length === 1 && credits[0] !== "" && (inside.size === 0 || inside.has(credits[0] as string));
	return agree ? null : `different credits: ${sortedUnique([...credits, ...inside]).join(", ")}`;
}

/** Path 1 (node onto node): the members of one merge group. */
export function identityDisagreement(
	members: readonly CacheNodeFile[],
	settled: ReadonlyMap<string, string> = new Map(),
): string | null {
	return facetsDisagreement(members.map(nodeFacet), settled);
}

// --- The invariant (the guarantee) ---

/**
 * THE guarantee, checked on the finished plan before anything is written: no edge ends up resolving to a node
 * of another identity than the one it cited. For every edge of the cache whose resolved target changes (its
 * slug is rewritten, detached, or still the same while a DIFFERENT node now sits at it because of a rename or a
 * merge), the reference (mbid, credit, name; a detached edge counts as its source artist) is compared with the
 * final node at that slug by facetsDisagreement; references citing a slug that is about to receive a node, or
 * that other rewritten edges converge on, are compared with each other too. An unreadable file at the target
 * is a disagreement; an empty credit is never an agreement. A violation refuses the run (exit 2 with
 * --apply, 1 in a dry-run): nothing is resolved automatically.
 */
export function validatePlan(
	plan: {
		finals: ReadonlyMap<string, Obj>;
		origin: ReadonlyMap<string, readonly CacheNodeFile[]>;
		edgeMap: Readonly<Record<string, string>>;
		detached: readonly DetachedEdge[];
	},
	before: readonly CacheNodeFile[],
	unreadable: ReadonlySet<string> = new Set(),
): InvariantViolation[] {
	const bySlug = new Map(before.map((f) => [f.slug, f]));
	const detachedTo = new Map(plan.detached.map((d) => [`${d.node}|${d.field}|${d.from}`, d.to]));
	const isWork = (slug: string): boolean => slug.startsWith("project:") || slug.startsWith("track:");
	const finalFacet = (slug: string, node: Obj): IdentityFacet => {
		const credit = isWork(slug) ? str(edgeList(node.artists)[0]?.name) : str(node.name);
		return { slug: `node:${slug}`, mbid: str(node.mbid), credit: fold(credit ?? "") };
	};
	interface Cite {
		node: string;
		field: string;
		from: string;
		needsCheck: boolean;
		name: string;
		facet: IdentityFacet;
		creditCheck: IdentityFacet[] | null;
	}
	const byTarget = new Map<string, Cite[]>();
	for (const [fin, node] of plan.finals) {
		const members = plan.origin.get(fin) ?? [];
		const kept = members.length === 1 && node === members[0]?.node;
		const sourceName = str(node.name);
		const sourceMbid = str(node.mbid);
		for (const member of members) {
			for (const { field, edge } of allEdges(member.node, member.type)) {
				const from = str(edge.slug);
				if (!from) continue;
				const detachedSlug = kept ? undefined : detachedTo.get(`${fin}|${field}|${from}`);
				const to = detachedSlug ?? (kept ? from : (plan.edgeMap[from] ?? from));
				if (to === fin) continue; // a self-edge, dropped
				const beforeNode = bySlug.get(from);
				const after = plan.finals.get(to);
				const sameNode =
					after !== undefined && beforeNode !== undefined && (plan.origin.get(to) ?? []).includes(beforeNode);
				const needsCheck = !sameNode && (to !== from || after !== undefined);
				const credit = detachedSlug ? sourceName : isWork(to) ? str(edge.artist) : str(edge.name);
				const facet: IdentityFacet = {
					slug: `ref:${fin}.${field}.${from}`,
					mbid: detachedSlug ? undefined : str(edge.mbid),
					credit: fold(credit ?? ""),
				};
				const creditedBy = after ? str(edgeList(after.artists)[0]?.mbid) : undefined;
				const creditName = after ? str(edgeList(after.artists)[0]?.name) : undefined;
				const cite: Cite = {
					node: fin,
					field,
					from,
					needsCheck,
					name: str(edge.name) ?? "",
					facet,
					creditCheck:
						detachedSlug && after
							? [
									{ slug: "source", mbid: sourceMbid, credit: fold(sourceName ?? "") },
									{ slug: "credit", mbid: creditedBy, credit: fold(creditName ?? "") },
								]
							: null,
				};
				byTarget.set(to, [...(byTarget.get(to) ?? []), cite]);
			}
		}
	}
	const violations: InvariantViolation[] = [];
	for (const [to, cites] of byTarget) {
		// A citation identical (same node, field, name, mbid, credit) to one already accepted for this target
		// cannot bring a new identity: it is that edge's earlier rewrite, left by an interrupted run.
		const accepted = cites.filter((c) => !c.needsCheck);
		for (const c of cites) {
			if (!c.needsCheck) continue;
			const twin = accepted.some(
				(o) =>
					o.node === c.node &&
					o.field === c.field &&
					o.name === c.name &&
					o.facet.mbid === c.facet.mbid &&
					o.facet.credit === c.facet.credit,
			);
			if (twin) c.needsCheck = false;
		}
		const changed = cites.filter((c) => c.needsCheck);
		if (changed.length === 0) continue;
		const refuse = (reason: string): void => {
			for (const c of changed) violations.push({ node: c.node, field: c.field, from: c.from, to, reason });
		};
		if (unreadable.has(to)) {
			refuse(`${to} is an unreadable file`);
			continue;
		}
		const after = plan.finals.get(to);
		const facets: IdentityFacet[] = [
			...(after ? [finalFacet(to, after)] : []),
			...changed.map((c) => c.facet),
			// A slug that had no node before: the references that already cited it are part of the picture.
			...(bySlug.has(to) ? [] : cites.filter((c) => !c.needsCheck && c.from === to).map((c) => c.facet)),
		];
		if (facets.length >= 2) {
			const why = facetsDisagreement(facets);
			if (why !== null) refuse(`${to}: ${why}`);
		}
		for (const c of changed) {
			const why = c.creditCheck ? facetsDisagreement(c.creditCheck) : null;
			if (why !== null)
				violations.push({
					node: c.node,
					field: c.field,
					from: c.from,
					to,
					reason: `${to} is credited to another artist (${why})`,
				});
		}
	}
	return violations.sort((a, b) =>
		`${a.node}${a.field}${a.from}` < `${b.node}${b.field}${b.from}` ? -1 : 1,
	);
}

// --- The plan (pure) ---

export interface PlanInput {
	files: readonly CacheNodeFile[];
	identities: ArtistIdentities;
	pending: Readonly<Record<string, PendingReverse[]>>;
	existingRedirects: Readonly<Record<string, string>>;
	/** Slugs whose file exists but cannot be read: a rename never overwrites one. */
	unreadable?: ReadonlySet<string>;
}

export interface Plan {
	/** Final slug -> node to write (only nodes whose content changes or that are new). */
	writes: Map<string, Obj>;
	/** Final slugs that have no file yet: written before the edited ones. */
	fresh: Set<string>;
	/** Old slug -> file to delete once the new files are in place. */
	deletions: Map<string, CacheNodeFile>;
	pending: { result: Record<string, PendingReverse[]>; changed: boolean };
	redirects: Record<string, string>;
	mergedRedirects: Record<string, string>;
	/** Final slug -> node as it will be on disk, for every node (invariant checks). */
	finals: Map<string, Obj>;
	manifest: Omit<Manifest, "mode" | "generated_at" | "written">;
}

type Target =
	| { kind: "same" }
	| { kind: "rename"; slug: string }
	| { kind: "skip" | "not-derivable"; reason: string };

export function planMigration(input: PlanInput): Plan {
	const { files, identities } = input;
	const bySlug = new Map(files.map((f) => [f.slug, f]));
	const artistByMbid = new Map<string, CacheNodeFile>();
	for (const f of files) {
		const mbid = f.type === "artist" ? str(f.node.mbid) : undefined;
		if (mbid !== undefined && !artistByMbid.has(mbid)) artistByMbid.set(mbid, f);
	}
	const skipped: Reported[] = [];
	const notDerivable: Reported[] = [];
	const conflicts: Conflict[] = [];
	const errors: string[] = [];

	// 1. The slug each node would get.
	const targetOf = (f: CacheNodeFile): Target => {
		const name = str(f.node.name);
		if (!name) return { kind: "skip", reason: "no-name" };
		if (f.type === "project" || f.type === "track") {
			const credits = edgeList(f.node.artists);
			const credit = credits[0];
			const creditName = str(credit?.name);
			if (!credit || !creditName) return { kind: "skip", reason: "no-credit" };
			// TRA-571: the order of `artists` is MusicBrainz's only for a work it resolved (it has an mbid). Without
			// one the order comes from the model, so `artists[0]` of a collaboration or a compilation is arbitrary
			// and would freeze a random artist into the canonical slug. "Various Artists" names no artist at all.
			// Skipped like `no-credit`: the work and every edge to it keep their bare slug.
			if (isVariousArtists(credit) || (credits.length > 1 && str(f.node.mbid) === undefined)) {
				return { kind: "skip", reason: "multi-credit-unresolved" };
			}
			const creditMbid = str(credit.mbid);
			const creditSlug = str(credit.slug);
			// The cache's own artist node names the scope first (by mbid, then by slug): the credit may be
			// in a script the slug cannot hold (TRA-494).
			const scopeName = pickScopeArtistName([
				creditMbid ? str(artistByMbid.get(creditMbid)?.node.name) : undefined,
				creditSlug ? str(bySlug.get(creditSlug)?.node.name) : undefined,
				creditName,
			]);
			if (scopeName === null) return { kind: "skip", reason: "no-latin-scope-name" };
			const scoped = makeScopedSlug(f.type, name, scopeName);
			if (!scoped.ok) return { kind: "skip", reason: scoped.reason };
			if (scoped.slug === f.slug) return { kind: "same" };
			if (
				(hasTransliteratedLetter(name) || hasTransliteratedLetter(creditName)) &&
				!transliteratedSlug(f.slug, name, creditName).ok
			) {
				return { kind: "not-derivable", reason: "legacy slug is not derived from the name (left as is)" };
			}
			return { kind: "rename", slug: scoped.slug };
		}
		if (!hasTransliteratedLetter(name)) return { kind: "same" };
		const t = transliteratedSlug(f.slug, name);
		if (!t.ok)
			return { kind: "not-derivable", reason: "legacy slug is not derived from the name (left as is)" };
		if (t.slug === f.slug) return { kind: "same" };
		// Genres have their own protections (onboarding, taxonomy) and their own tickets.
		return f.type === "genre"
			? { kind: "skip", reason: `genre rename to ${t.slug} is out of scope` }
			: { kind: "rename", slug: t.slug };
	};

	const finalOf = new Map<string, string>();
	for (const f of files) {
		const t = targetOf(f);
		finalOf.set(f.slug, t.kind === "rename" ? t.slug : f.slug);
		if (t.kind === "skip") skipped.push({ slug: f.slug, reason: t.reason });
		if (t.kind === "not-derivable") notDerivable.push({ slug: f.slug, reason: t.reason });
	}
	const ownRenames = new Map([...finalOf].filter(([s, fin]) => s !== fin));
	// A file we cannot read may hold a node: a rename onto its slug would overwrite it blindly.
	const unreadable = input.unreadable ?? new Set<string>();

	// 2. Collisions of the artist manifest merge onto one slug (the one without "--", else rule 2).
	const collisionGroups: { mbid: string; members: CacheNodeFile[] }[] = [];
	for (const c of identities.collisions) {
		const present = c.slugs.flatMap((s) => bySlug.get(s) ?? []);
		if (present.length < 2) continue;
		collisionGroups.push({ mbid: c.mbid, members: present });
		const { winner } = elect(present, true);
		for (const m of present) finalOf.set(m.slug, finalOf.get(winner.slug) ?? winner.slug);
	}
	// A group holding a whole collision of the artist manifest: MusicBrainz settled it, and its bare slug wins.
	const preferBare = (members: readonly CacheNodeFile[]): boolean =>
		collisionGroups.some((g) => g.members.every((m) => members.includes(m)));
	// The slugs of every manifest collision wholly inside the group: only those are settled by MusicBrainz.
	const settledIn = (members: readonly CacheNodeFile[]): Map<string, string> =>
		new Map(
			collisionGroups
				.filter((g) => g.members.every((m) => members.includes(m)))
				.flatMap((g) => g.members.map((m): [string, string] => [m.slug, g.mbid])),
		);

	// 3. Merge groups and their guards, until stable (reverting one group can expose another).
	const revert = (slugs: readonly string[]): void => {
		for (const s of slugs) finalOf.set(s, s);
	};
	const seenConflicts = new Set<string>();
	const addConflict = (c: Conflict): void => {
		const key = `${c.kind}|${c.slugs.join(",")}`;
		if (seenConflicts.has(key)) return;
		seenConflicts.add(key);
		conflicts.push(c);
	};
	for (let pass = 0; pass < 20; pass++) {
		let changed = false;
		for (const [slug, fin] of [...finalOf]) {
			if (slug !== fin && unreadable.has(fin)) {
				addConflict({
					kind: "unreadable-target",
					slugs: [slug, fin],
					reason: `${fin} exists but cannot be read: ${slug} is not renamed onto it`,
				});
				revert([slug]);
				changed = true;
			}
		}
		for (const [slug, fin] of [...finalOf]) {
			// A rename onto a node that itself leaves: the chain is not guessed, the sources stay.
			if (slug !== fin && bySlug.has(fin) && finalOf.get(fin) !== fin) {
				addConflict({
					kind: "chain",
					slugs: [slug, fin],
					reason: `${fin} is itself renamed to ${finalOf.get(fin)}`,
				});
				revert([slug]);
				changed = true;
			}
		}
		const groups = new Map<string, CacheNodeFile[]>();
		for (const f of files)
			groups.set(finalOf.get(f.slug) ?? f.slug, [...(groups.get(finalOf.get(f.slug) ?? f.slug) ?? []), f]);
		for (const [fin, members] of groups) {
			if (members.length < 2) continue;
			const why = identityDisagreement(members, settledIn(members));
			if (why === null) continue;
			addConflict({ kind: "merge", slugs: members.map((m) => m.slug).sort(), reason: `${fin}: ${why}` });
			revert(members.map((m) => m.slug));
			changed = true;
		}
		if (!changed) break;
	}

	const groups = new Map<string, CacheNodeFile[]>();
	for (const f of files) {
		const fin = finalOf.get(f.slug) ?? f.slug;
		groups.set(fin, [...(groups.get(fin) ?? []), f]);
	}

	// 4. Dangling targets (no node file) renamed by the transliteration, guarded against two readings.
	// Every reference to a dangling slug is read, and the slug is only touched when one of them holds a
	// transliterated letter: "M" and "MØ" both name `artist:m`, and rewriting edge by edge would send the
	// "M" edge to MØ.
	const refsBySlug = new Map<
		string,
		{ name: string; artist: string | undefined; mbid: string | undefined }[]
	>();
	for (const f of files) {
		for (const { edge } of allEdges(f.node, f.type)) {
			const slug = str(edge.slug);
			const name = str(edge.name);
			if (!slug || !name || bySlug.has(slug) || !isReadableSlug(slug) || parseSlug(slug).type === "genre")
				continue;
			refsBySlug.set(slug, [
				...(refsBySlug.get(slug) ?? []),
				{ name, artist: str(edge.artist), mbid: str(edge.mbid) },
			]);
		}
	}
	const proposals = new Map<string, Set<string>>();
	for (const [slug, refs] of refsBySlug) {
		if (!refs.some((r) => hasTransliteratedLetter(r.name) || (r.artist && hasTransliteratedLetter(r.artist))))
			continue;
		proposals.set(
			slug,
			new Set(
				refs.map((r) => {
					const t = transliteratedSlug(slug, r.name, r.artist);
					return t.ok ? t.slug : "";
				}),
			),
		);
	}
	const danglingRenames = new Map<string, string>();
	for (const [slug, set] of [...proposals].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const derived = [...set].filter((s) => s !== "");
		if (derived.length === 0) {
			notDerivable.push({ slug, reason: "dangling target not derived from its name (left as is)" });
		} else if (derived.length > 1 || set.has("")) {
			addConflict({
				kind: "transliteration",
				slugs: sortedUnique([slug, ...derived]),
				reason: `references name ${slug} in different ways: not rewritten`,
			});
		} else if (derived[0] !== undefined && derived[0] !== slug) {
			// Path 2: the derived slug is a node that exists. The references have to be that node.
			const target = bySlug.get(derived[0]);
			const why = target
				? facetsDisagreement([
						nodeFacet(target),
						...(refsBySlug.get(slug) ?? []).map((r) =>
							referenceFacet(slug, r, target.type === "project" || target.type === "track"),
						),
					])
				: null;
			if (why !== null) {
				addConflict({
					kind: "dangling-target",
					slugs: [slug, derived[0]],
					reason: `${slug} is cited but ${derived[0]} is another identity (${why}): no new rewrite, no new redirect (an older redirect that already sends ${slug} there is caught by the invariant)`,
				});
			} else {
				danglingRenames.set(slug, derived[0]);
			}
		}
	}

	// 5. Redirects (old -> final), flattened; the rewrite map is the same table.
	const additions: Record<string, string> = {};
	for (const [slug, fin] of finalOf) if (slug !== fin) additions[slug] = fin;
	for (const [slug, fin] of danglingRenames) additions[slug] = finalOf.get(fin) ?? fin;
	let rewriteMap: Record<string, string> = {};
	let edgeMap: Record<string, string> = {};
	let mergedRedirects: Record<string, string> = {};
	try {
		rewriteMap = mergeRedirects({}, additions);
		mergedRedirects = mergeRedirects(input.existingRedirects, rewriteMap);
		// Edges follow the redirects of an earlier, interrupted run too (keys with no node left): after a
		// crash in the removal phase an old file can still hold an edge to a node that is already gone.
		edgeMap = mergeRedirects(
			{},
			{
				...Object.fromEntries(Object.entries(input.existingRedirects).filter(([k]) => !bySlug.has(k))),
				...rewriteMap,
			},
		);
		parseSlugRedirects({ redirects: mergedRedirects });
	} catch (e) {
		errors.push(`redirect table would be invalid: ${e instanceof Error ? e.message : String(e)}`);
	}
	const resolve = (slug: string): string => edgeMap[slug] ?? slug;

	// 6. Merged / renamed nodes, before any edge is rewritten.
	const finals = new Map<string, Obj>();
	const merged: MergeEntry[] = [];
	const renamed: Record<string, string> = {};
	const removed: string[] = [];
	const deletions = new Map<string, CacheNodeFile>();
	const fresh = new Set<string>();
	const origin = new Map<string, CacheNodeFile[]>();
	for (const [fin, members] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
		origin.set(fin, members);
		if (members.length === 1) {
			const only = members[0] as CacheNodeFile;
			if (only.slug !== fin) {
				renamed[only.slug] = fin;
				deletions.set(only.slug, only);
				fresh.add(fin);
			}
			finals.set(fin, { ...only.node, slug: fin });
			continue;
		}
		const { winner, criterion } = elect(members, preferBare(members));
		const losers = members.filter((m) => m !== winner);
		finals.set(
			fin,
			mergeNodes(winner, losers, fin, (field, edgeSlug) =>
				conflicts.push({
					kind: "edge-mbid",
					slugs: [`${fin}.${field}`, edgeSlug],
					reason: `merged nodes hold ${edgeSlug} with different mbids: both kept`,
				}),
			),
		);
		fresh.add(fin);
		merged.push({
			slug: fin,
			winner: winner.slug,
			losers: losers.map((l) => l.slug).sort(),
			criterion,
		});
		for (const m of members) {
			if (m.slug === fin) continue;
			deletions.set(m.slug, m);
			if (m === winner) renamed[m.slug] = fin;
			else removed.push(relative(dirname(dirname(dirname(m.path))), m.path));
		}
	}

	// 7. Edge rewriting, with the credit condition on the artist -> work edges.
	const detached: DetachedEdge[] = [];
	const rewritten: RewrittenEdge[] = [];
	const folded: FoldedEdge[] = [];
	const malformed: Reported[] = [];
	const selfEdges: { node: string; field: string }[] = [];
	const credited = (
		source: { slug: string; mbids: Set<string>; groups: Set<string>; names: Set<string> },
		target: Obj,
	): boolean => {
		for (const c of [...edgeList(target.artists), ...edgeList(target.producers)]) {
			const cSlug = str(c.slug) ? resolve(str(c.slug) as string) : undefined;
			const cMbid = str(c.mbid);
			// A credit that is only a name counts when it is the source's own name.
			if (!cSlug && !cMbid && source.names.has(fold(str(c.name) ?? ""))) return true;
			if (cSlug === source.slug || (cMbid && source.mbids.has(cMbid))) return true;
			if (cMbid && source.groups.has(cMbid)) return true;
			const cNode = cSlug ? finals.get(cSlug) : undefined;
			if (!cNode) continue;
			if (edgeList(cNode.members).some((m) => resolve(str(m.slug) ?? "") === source.slug)) return true;
			const nodeMbid = str(cNode.mbid);
			if (nodeMbid && source.groups.has(nodeMbid)) return true;
		}
		return false;
	};

	const results = new Map<string, Obj>();
	for (const [fin, base] of finals) {
		const type = parseSlug(fin).type;
		let node = base;
		for (const { field, edge } of allEdges(node, type)) {
			if (resolve(str(edge.slug) ?? "") === fin) selfEdges.push({ node: fin, field });
		}
		if (type === "artist") {
			const members = origin.get(fin) ?? [];
			const source = {
				slug: fin,
				mbids: new Set(members.flatMap((m) => str(m.node.mbid) ?? [])),
				groups: new Set(members.flatMap((m) => identities.groups.get(m.slug) ?? [])),
				names: new Set(members.flatMap((m) => str(m.node.name) ?? []).map(fold)),
			};
			const sourceName = pickScopeArtistName([str(node.name)]);
			const next: Obj = { ...node };
			for (const field of CREDITED_FIELDS) {
				const value = node[field];
				const fix = (edge: Obj): Obj => {
					const oldSlug = str(edge.slug);
					const newSlug = oldSlug ? edgeMap[oldSlug] : undefined;
					const targetType = oldSlug && isReadableSlug(oldSlug) ? parseSlug(oldSlug).type : undefined;
					if (!oldSlug || !newSlug || (targetType !== "project" && targetType !== "track")) return edge;
					const targetNode = finals.get(newSlug);
					const hinted =
						str(edge.artist) !== undefined && scopeMatchesArtist(newSlug, str(edge.artist) as string);
					if (targetNode && (credited(source, targetNode) || hinted)) return edge;
					const name = str(edge.name);
					const scoped = name && sourceName ? makeScopedSlug(targetType, name, sourceName) : null;
					if (!scoped?.ok || !sourceName) {
						errors.push(`cannot detach ${fin}.${field} -> ${oldSlug}: no scoped slug for ${name ?? "?"}`);
						return edge;
					}
					// The scoped slug is where the edge's own target is going (the work's rename destination): the
					// edge keeps pointing at that same work, credited to someone else. Not a detachment.
					const formerTarget = bySlug.get(oldSlug);
					if (formerTarget && (origin.get(scoped.slug) ?? []).includes(formerTarget)) {
						conflicts.push({
							kind: "detach-target",
							slugs: [fin, scoped.slug],
							reason: `${fin} cites ${oldSlug}, which is renamed to ${scoped.slug} and credited to another artist: left on that work, not detached`,
						});
						return edge;
					}
					// Path 4: the scoped slug may already be a node; it must be this artist's.
					const clash = bySlug.get(scoped.slug);
					const clashCredit = clash ? str(edgeList(clash.node.artists)[0]?.name) : undefined;
					if (clashCredit !== undefined && fold(clashCredit) !== fold(sourceName)) {
						const message = `${scoped.slug} exists with credit ${clashCredit}, not ${sourceName}`;
						conflicts.push({ kind: "detach-target", slugs: [fin, scoped.slug], reason: message });
						errors.push(`cannot detach ${fin}.${field} -> ${oldSlug}: ${message}`);
						return edge;
					}
					detached.push({ node: fin, field, from: oldSlug, to: scoped.slug, name: name ?? "" });
					const { mbid: _dropped, ...rest } = edge;
					return { ...rest, slug: scoped.slug, artist: sourceName };
				};
				if (Array.isArray(value)) next[field] = value.map((e) => (isRecord(e) ? fix(e) : e));
				else if (isRecord(value)) next[field] = fix(value);
			}
			node = next;
		}
		const out = rewriteEdges(node, type, edgeMap, fin);
		folded.push(...out.folded);
		conflicts.push(...out.conflicts);
		for (const [from, count] of [...out.hits].sort(([a], [b]) => (a < b ? -1 : 1))) {
			rewritten.push({ node: fin, from, to: edgeMap[from] ?? from, count });
		}
		results.set(fin, out.node);
	}

	// pending-reverses.json: keys and edge slugs follow the renames. A key that lands on a node that
	// exists (the benign collision `artist:l-titia-sadier` -> `artist:laetitia-sadier`) is applied to it
	// now and dropped: the pending edge would otherwise wait for a write that never comes, and the
	// forward edge the rename just attached to a real node would have no reverse (audit reciprocity).
	// A key already redirected by an earlier (interrupted) run is moved too: after a crash the edges no
	// longer name the old slug, so the rename could not be deduced again from them.
	const pendingMap = edgeMap;
	const pending = rewritePendingReverses(input.pending, new Map(Object.entries(pendingMap)));
	const pendingRenames = Object.keys(input.pending)
		.filter((k) => pendingMap[k] !== undefined)
		.sort()
		.map((from) => ({ from, to: pendingMap[from] as string }));
	const appliedPending = new Map<string, PendingReverse[]>();
	for (const { to } of pendingRenames) {
		const target = results.get(to);
		const entries = pending.result[to];
		if (!target || !entries) continue;
		const next: Obj = { ...target };
		for (const { field, cardinality, edge } of entries) {
			if (edge.slug === to) continue;
			if (cardinality === "list") {
				const list = edgeList(next[field]);
				if (!list.some((e) => e.slug === edge.slug)) next[field] = [...list, edge];
			} else if (next[field] == null) {
				next[field] = edge;
			}
		}
		results.set(to, next);
		appliedPending.set(to, entries);
		delete pending.result[to];
	}

	// 8. Writes: what is new, merged, or edited.
	const writes = new Map<string, Obj>();
	for (const [fin, node] of results) {
		const members = origin.get(fin) ?? [];
		const unchanged =
			members.length === 1 && !fresh.has(fin) && JSON.stringify(node) === JSON.stringify(members[0]?.node);
		if (unchanged) continue;
		const parsed = nodePayloadSchema.safeParse(node);
		const problem = !parsed.success
			? `invalid node: ${parsed.error.message}`
			: onlyAddsSchemaDefaults(node, parsed.data)
				? null
				: "validation would alter fields the node carries";
		if (problem === null && parsed.success) {
			writes.set(fin, parsed.data as Obj);
		} else if (members.length === 1 && !fresh.has(fin) && members[0]) {
			// An existing node we cannot rewrite safely stays as it is, and is reported. If it still points at
			// a retired slug the invariant below refuses the run.
			results.set(fin, members[0].node);
			const back = appliedPending.get(fin);
			if (back) pending.result[fin] = [...(pending.result[fin] ?? []), ...back];
			malformed.push({
				slug: fin,
				reason: `kept as is: ${problem}${back ? ` (${back.length} pending reverse edge(s) kept under their key)` : ""}`,
			});
		} else {
			errors.push(`refusing to write ${fin}: ${problem}`);
		}
	}

	// 9. Invariants over the resulting cache.
	for (const [fin, node] of results) {
		for (const { field, edge } of allEdges(node, parseSlug(fin).type)) {
			const slug = str(edge.slug);
			if (slug && slug !== fin && edgeMap[slug] !== undefined && !results.has(slug)) {
				errors.push(`stale edge: ${fin}.${field} still points to ${slug}`);
			}
		}
	}
	for (const slug of Object.keys(rewriteMap)) {
		if (results.has(slug)) errors.push(`redirect key ${slug} is also a live node after the migration`);
	}

	const invariantViolations = validatePlan({ finals: results, origin, edgeMap, detached }, files, unreadable);

	const sortRecord = (r: Record<string, string>): Record<string, string> =>
		Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	const bySlugKey = <T extends { slug: string }>(a: T, b: T): number =>
		a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
	return {
		writes,
		fresh,
		deletions,
		pending,
		redirects: rewriteMap,
		mergedRedirects,
		finals: results,
		manifest: {
			migration: MIGRATION_NAME,
			renamed: sortRecord(renamed),
			removed: removed.sort(),
			redirects: sortRecord(rewriteMap),
			detached: detached.sort((a, b) => (a.node + a.field + a.from < b.node + b.field + b.from ? -1 : 1)),
			merged: merged.sort(bySlugKey),
			skipped: skipped.sort(bySlugKey),
			not_derivable: notDerivable.sort(bySlugKey),
			malformed: malformed.sort(bySlugKey),
			invariantViolations,
			folded,
			conflicts,
			rewritten,
			self_edges_removed: selfEdges,
			pending_reverses: pendingRenames,
			errors,
			notes: [],
			summary: {
				nodes: files.length,
				renamed: Object.keys(renamed).length,
				own_renames: ownRenames.size,
				removed: removed.length,
				merged_groups: merged.length,
				redirects_added: Object.keys(rewriteMap).filter((k) => input.existingRedirects[k] !== rewriteMap[k])
					.length,
				rewritten_edges: rewritten.reduce((n, r) => n + r.count, 0),
				detached_edges: detached.length,
				self_edges_removed: selfEdges.length,
				pending_reverse_keys: pendingRenames.length,
				skipped: skipped.length,
				not_derivable: notDerivable.length,
				conflicts: conflicts.length,
				folded_edges: folded.length,
				malformed: malformed.length,
				invariant_violations: invariantViolations.length,
				nodes_to_write: writes.size,
			},
		},
	};
}

// --- Disk ---

export interface MigrationOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath?: string;
	artistManifestPath?: string;
	redirectsPath?: string;
	/**
	 * Library-only (tests, scratch copies), deliberately not a CLI flag: lets `--apply` run without the
	 * artist-identity manifest and while the transliteration table lacks ð / ı (TRA-531).
	 */
	scratch?: boolean;
	/** Library-only (crash tests): called before each disk write of the apply phase, with its index. */
	beforeWrite?: (index: number) => void;
}

export interface MigrationResult {
	manifest: Manifest;
	/** 0 clean; 1 invariant violation (nothing written); 2 refused to run. */
	exitCode: 0 | 1 | 2;
}

// The two files read besides the cache are validated, not cast: a manifest whose `groups` held strings
// would silently read as "no group" and detach every member's edge.
const identityManifestSchema = z
	.object({
		resolved: z.record(
			z.string(),
			z
				.object({
					mbid: z.string(),
					groups: z.array(z.object({ mbid: z.string() }).passthrough()).default([]),
				})
				.passthrough(),
		),
		collisions: z.array(z.object({ mbid: z.string(), slugs: z.array(z.string()) }).passthrough()).default([]),
	})
	.passthrough();

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

/** Null when the file is absent; throws (the run exits 2 before any write) when it is not a valid manifest. */
async function readIdentities(path: string): Promise<ArtistIdentities | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	const parsed = identityManifestSchema.parse(JSON.parse(text));
	return {
		groups: new Map(Object.entries(parsed.resolved).map(([slug, e]) => [slug, e.groups.map((g) => g.mbid)])),
		collisions: parsed.collisions.map((c) => ({ mbid: c.mbid, slugs: c.slugs })),
	};
}

const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

/** MusicBrainz's "Various Artists" special purpose artist, by mbid or by normalized name. */
function isVariousArtists(credit: Obj): boolean {
	return (
		str(credit.mbid) === VARIOUS_ARTISTS_MBID ||
		str(credit.name)?.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() === "various artists"
	);
}

function pathOf(cacheDir: string, slug: string): string {
	const { type, body } = parseSlug(slug);
	return join(cacheDir, "nodes", type, `${body}.json`);
}

export async function runMigration(options: MigrationOptions): Promise<MigrationResult> {
	const { cacheDir, apply } = options;
	const base = {
		migration: MIGRATION_NAME,
		mode: apply ? "apply" : "dry-run",
		generated_at: new Date().toISOString(),
	} as const;
	const empty = (errors: string[]): Manifest => ({
		...base,
		renamed: {},
		removed: [],
		redirects: {},
		written: 0,
		detached: [],
		merged: [],
		skipped: [],
		not_derivable: [],
		malformed: [],
		invariantViolations: [],
		folded: [],
		conflicts: [],
		rewritten: [],
		self_edges_removed: [],
		pending_reverses: [],
		errors,
		notes: [],
		summary: {},
	});
	if (!scopedReleaseSlugsEnabled()) {
		return {
			manifest: empty([
				"ODYSSEY_SCOPED_RELEASE_SLUGS is off: the target slugs depend on it. Refusing to run (TRA-509 lists every process that needs it).",
			]),
			exitCode: 2,
		};
	}

	const artistManifestPath = options.artistManifestPath ?? DEFAULT_ARTIST_MANIFEST_PATH;
	let identities: ArtistIdentities | null;
	try {
		identities = await readIdentities(artistManifestPath);
	} catch (e) {
		return {
			manifest: empty([
				`invalid artist manifest ${artistManifestPath}: ${e instanceof Error ? e.message : String(e)}`,
			]),
			exitCode: 2,
		};
	}
	// Without the manifest there is no collision to merge and no group membership: a member's edge to a
	// band's work would be detached for good. Reading is fine (the dry-run says so), writing is refused.
	if (identities === null && apply && !options.scratch) {
		return {
			manifest: empty([
				`no artist-identity manifest at ${artistManifestPath}: refusing --apply without it (TRA-463)`,
			]),
			exitCode: 2,
		};
	}

	// TRA-531 completes the table with ð and ı. Without them `Gökhan Kırdar` is still scoped as
	// `gokhan-k-rdar`, a second identity pass would be needed once they land: applying is refused.
	const tableComplete = normalizeSlugBody("ðı") === "di";
	if (apply && !tableComplete && !options.scratch) {
		return {
			manifest: empty(["the transliteration table lacks ð / ı (TRA-531): merge it before --apply"]),
			exitCode: 2,
		};
	}

	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	const notes: string[] = [];
	if (!tableComplete) notes.push("transliteration table lacks ð / ı (TRA-531): this plan is not final");
	if (identities === null) {
		notes.push(
			`no artist manifest at ${artistManifestPath}: no collision to merge, no group membership known`,
		);
		identities = NO_IDENTITIES;
	}
	// The manifest settles collisions by mbid, so the nodes must carry it: TRA-463 must have been APPLIED
	// (not only run as a dry-run) before this migration. Not waived by `scratch`.
	const notBackfilled = identities.collisions.flatMap((c) =>
		c.slugs.flatMap((slug) => {
			const file = nodes.find((n) => n.slug === slug);
			return file && str(file.node.mbid) !== c.mbid
				? [`${slug} (node mbid ${str(file.node.mbid) ?? "none"}, manifest ${c.mbid})`]
				: [];
		}),
	);
	if (notBackfilled.length > 0) {
		const message = `nodes of an artist-manifest collision do not carry the manifest's mbid: apply the artist identity backfill (TRA-463) first: ${notBackfilled.join("; ")}`;
		if (apply) return { manifest: empty([message]), exitCode: 2 };
		notes.push(message);
	}
	const redirectsPath = options.redirectsPath ?? join(defaultDataDir(), "slug-redirects.json");
	let existingRedirects: Record<string, string> = {};
	try {
		const raw = JSON.parse(await readTextOrDefault(redirectsPath, '{"redirects":{}}')) as unknown;
		existingRedirects = Object.fromEntries(parseSlugRedirects(raw));
	} catch (e) {
		return {
			manifest: empty([`cannot read ${redirectsPath}: ${e instanceof Error ? e.message : String(e)}`]),
			exitCode: 1,
		};
	}
	const pendingPath = join(cacheDir, "pending-reverses.json");
	let pendingOld: Record<string, PendingReverse[]>;
	try {
		pendingOld = pendingFileSchema.parse(JSON.parse(await readTextOrDefault(pendingPath, "{}"))) as Record<
			string,
			PendingReverse[]
		>;
	} catch (e) {
		return {
			manifest: empty([`invalid ${pendingPath}: ${e instanceof Error ? e.message : String(e)}`]),
			exitCode: 2,
		};
	}

	const nodesDir = join(cacheDir, "nodes");
	const unreadable = new Set(invalid.map((i) => relative(nodesDir, i.path)));
	const plan = planMigration({
		files: nodes,
		identities,
		pending: pendingOld,
		existingRedirects,
		unreadable,
	});
	// A node file we cannot read (malformed slug, bad JSON) is left alone and listed, not a reason to stop.
	plan.manifest.malformed.push(...invalid.map((i) => ({ slug: i.path, reason: `unreadable: ${i.error}` })));
	plan.manifest.summary.malformed = plan.manifest.malformed.length;
	const manifest: Manifest = { ...base, ...plan.manifest, notes, written: 0 };
	const blocked = plan.manifest.invariantViolations.length > 0;
	if (blocked) {
		manifest.errors.push(
			`${plan.manifest.invariantViolations.length} invariant violation(s): an edge would resolve to a node of another identity (see invariantViolations); refusing, nothing is resolved automatically`,
		);
	}

	if (apply && !blocked && plan.manifest.errors.length === 0) {
		// Crash-safe order: a crash at any point leaves no edge to a node that is gone, and a re-run
		// finishes the job. New nodes, then the redirects, then the nodes that point at them, then
		// pending-reverses, and only then the removal of the old files (a duplicate is harmless, a loss
		// is not: an old node that survives a crash merges into its new slug on the next run).
		let step = 0;
		const write = async (path: string, data: unknown): Promise<void> => {
			options.beforeWrite?.(step++);
			await mkdir(dirname(path), { recursive: true });
			await atomicWriteJson(path, data);
		};
		const bySlugOrder = (([a], [b]: [string, Obj]) => (a < b ? -1 : 1)) as (
			a: [string, Obj],
			b: [string, Obj],
		) => number;
		const writes = [...plan.writes].sort(bySlugOrder);
		for (const [slug, node] of writes) if (plan.fresh.has(slug)) await write(pathOf(cacheDir, slug), node);
		if (JSON.stringify(plan.mergedRedirects) !== JSON.stringify(existingRedirects)) {
			await write(redirectsPath, {
				source: "release slug scoping",
				generated_at: base.generated_at,
				redirects: plan.mergedRedirects,
			});
		}
		for (const [slug, node] of writes) if (!plan.fresh.has(slug)) await write(pathOf(cacheDir, slug), node);
		manifest.written = plan.writes.size;
		if (plan.pending.changed) await write(pendingPath, plan.pending.result);
		for (const file of [...plan.deletions.values()].sort((x, y) => (x.slug < y.slug ? -1 : 1))) {
			options.beforeWrite?.(step++);
			await rm(file.path);
		}
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: blocked && apply ? 2 : manifest.errors.length > 0 ? 1 : 0 };
}

export function formatSummary(manifest: Manifest, manifestPath: string | undefined): string {
	const lines = [`${manifest.migration} (${manifest.mode})`];
	for (const [key, value] of Object.entries(manifest.summary)) lines.push(`  ${key.padEnd(22)} ${value}`);
	lines.push(`  ${"written".padEnd(22)} ${manifest.written}`);
	for (const note of manifest.notes) lines.push(`note: ${note}`);
	for (const error of manifest.errors) lines.push(`error: ${error}`);
	if (manifestPath) lines.push(`manifest: ${manifestPath}`);
	if (manifest.mode === "dry-run") lines.push("dry-run: nothing written to the cache (re-run with --apply)");
	return lines.join("\n");
}

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	artistManifestPath: string;
	redirectsPath?: string;
}

/** `<cache-dir> [--apply] [--manifest p] [--artist-manifest p] [--redirects p]`; null (exit 2) on anything else. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	let apply = false;
	const values: Record<string, string> = {};
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--apply" && !apply) apply = true;
		else if (
			(token === "--manifest" ||
				token === "--artist-manifest" ||
				token === "--redirects" ||
				token === "--data-dir") &&
			values[token] === undefined
		) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			values[token] = value;
		} else return null;
	}
	const dataDir = values["--data-dir"];
	if (dataDir !== undefined && values["--redirects"] !== undefined) return null;
	return {
		cacheDir,
		apply,
		manifestPath: values["--manifest"] ?? DEFAULT_MANIFEST_PATH,
		artistManifestPath: values["--artist-manifest"] ?? DEFAULT_ARTIST_MANIFEST_PATH,
		// --data-dir (deploy/sync-genre-cache.sh): the scratch tables the migration may write; --redirects
		// names the file itself. Both at once is ambiguous.
		...(values["--redirects"] ? { redirectsPath: values["--redirects"] } : {}),
		...(dataDir ? { redirectsPath: join(dataDir, "slug-redirects.json") } : {}),
	};
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-16-scope-release-slugs.ts <cache-dir> [--apply] [--manifest <path>] [--artist-manifest <path>] [--redirects <path>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runMigration({
		cacheDir: args.cacheDir,
		apply: args.apply,
		manifestPath: args.manifestPath,
		artistManifestPath: args.artistManifestPath,
		...(args.redirectsPath ? { redirectsPath: args.redirectsPath } : {}),
	});
	console.log(formatSummary(result.manifest, args.manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
