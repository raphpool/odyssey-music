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
 * Writes go through atomicWriteJson after nodePayloadSchema validation, never NodeCache.write: write()
 * also emits reverse edges and merges pending ones, which is the job of the reverse-edge backfill
 * (2.2), not of a rename. (NodeCache.update, TRA-535, is not on main yet.)
 *
 * Apply order (crash-safe, like TRA-22/41): new node files -> rewritten nodes -> pending-reverses.json
 * -> redirects -> `rm` of the old files last. The real run is TRA-483 (repo) and TRA-484 (prod, through
 * the migration channel of deploy/sync-genre-cache.sh, which reads the manifest written here).
 *
 * Usage: ODYSSEY_SCOPED_RELEASE_SLUGS=1 tsx scripts/migrations/2026-10-16-scope-release-slugs.ts <cache-dir>
 *        [--apply] [--manifest out/scope-release-slugs.json] [--artist-manifest out/artist-identity.json]
 *        [--redirects data/slug-redirects.json]
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
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
	rewriteNodeEdges,
	rewritePendingReverses,
	unionListField,
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
export interface Conflict {
	kind: "merge" | "chain" | "transliteration";
	slugs: string[];
	reason: string;
}
export interface Reported {
	slug: string;
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

/** Winner content under `slug`; edge lists unioned by slug, singulars from the winner, mbid from whoever has it. */
export function mergeNodes(winner: CacheNodeFile, losers: readonly CacheNodeFile[], slug: string): Obj {
	const out: Obj = { ...winner.node, slug };
	for (const field of LIST_EDGES_BY_TYPE[winner.type]) {
		const lists = [winner, ...losers].map((f) => f.node[field]);
		if (lists.every((l) => l === undefined)) continue;
		out[field] = unionListField(
			edgeList(winner.node[field]),
			losers.map((l) => edgeList(l.node[field])),
		);
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

const fold = (text: string): string =>
	text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.toLowerCase();

/**
 * Null when the members may be merged, else why not. Sharing a slug is not sharing an identity ("Mo" and
 * "MØ" both give `artist:mo`): different mbids never merge, and as soon as one member has no mbid the
 * credit (a work's primary credit, an artist's own name; letters kept, only accents folded) has to agree.
 * `mbidOnly`: the members are one collision of the artist manifest, which MusicBrainz already settled.
 */
export function identityDisagreement(members: readonly CacheNodeFile[], mbidOnly = false): string | null {
	const mbids = sortedUnique(members.flatMap((m) => str(m.node.mbid) ?? []));
	if (mbids.length > 1) return `different mbids: ${mbids.join(", ")}`;
	if (mbidOnly || members.every((m) => str(m.node.mbid) !== undefined)) return null;
	const credits = sortedUnique(
		members.map((m) =>
			fold(
				(m.type === "project" || m.type === "track"
					? str(edgeList(m.node.artists)[0]?.name)
					: str(m.node.name)) ?? "",
			),
		),
	);
	return credits.length > 1 ? `different credits: ${credits.join(", ")}` : null;
}

// --- The plan (pure) ---

export interface PlanInput {
	files: readonly CacheNodeFile[];
	identities: ArtistIdentities;
	pending: Readonly<Record<string, PendingReverse[]>>;
	existingRedirects: Readonly<Record<string, string>>;
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
			const credit = edgeList(f.node.artists)[0];
			const creditName = str(credit?.name);
			if (!credit || !creditName) return { kind: "skip", reason: "no-credit" };
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

	// 2. Collisions of the artist manifest merge onto one slug (the one without "--", else rule 2).
	const collisionGroups: CacheNodeFile[][] = [];
	for (const c of identities.collisions) {
		const present = c.slugs.flatMap((s) => bySlug.get(s) ?? []);
		if (present.length < 2) continue;
		collisionGroups.push(present);
		const { winner } = elect(present, true);
		for (const m of present) finalOf.set(m.slug, finalOf.get(winner.slug) ?? winner.slug);
	}
	// A group holding a whole collision of the artist manifest: MusicBrainz settled it, and its bare slug wins.
	const preferBare = (members: readonly CacheNodeFile[]): boolean =>
		collisionGroups.some((g) => g.every((m) => members.includes(m)));

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
			const why = identityDisagreement(members, preferBare(members));
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
	const refsBySlug = new Map<string, { name: string; artist: string | undefined }[]>();
	for (const f of files) {
		for (const { edge } of allEdges(f.node, f.type)) {
			const slug = str(edge.slug);
			const name = str(edge.name);
			if (!slug || !name || bySlug.has(slug) || !isReadableSlug(slug) || parseSlug(slug).type === "genre")
				continue;
			refsBySlug.set(slug, [...(refsBySlug.get(slug) ?? []), { name, artist: str(edge.artist) }]);
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
			danglingRenames.set(slug, derived[0]);
		}
	}

	// 5. Redirects (old -> final), flattened; the rewrite map is the same table.
	const additions: Record<string, string> = {};
	for (const [slug, fin] of finalOf) if (slug !== fin) additions[slug] = fin;
	for (const [slug, fin] of danglingRenames) additions[slug] = finalOf.get(fin) ?? fin;
	let rewriteMap: Record<string, string> = {};
	let mergedRedirects: Record<string, string> = {};
	try {
		rewriteMap = mergeRedirects({}, additions);
		mergedRedirects = mergeRedirects(input.existingRedirects, rewriteMap);
		parseSlugRedirects({ redirects: mergedRedirects });
	} catch (e) {
		errors.push(`redirect table would be invalid: ${e instanceof Error ? e.message : String(e)}`);
	}
	const resolve = (slug: string): string => rewriteMap[slug] ?? slug;
	const rewriteEntries = new Map(Object.entries(rewriteMap));

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
		finals.set(fin, mergeNodes(winner, losers, fin));
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
					const newSlug = oldSlug ? rewriteMap[oldSlug] : undefined;
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
					detached.push({ node: fin, field, from: oldSlug, to: scoped.slug, name: name ?? "" });
					const { mbid: _dropped, ...rest } = edge;
					return { ...rest, slug: scoped.slug, artist: sourceName };
				};
				if (Array.isArray(value)) next[field] = value.map((e) => (isRecord(e) ? fix(e) : e));
				else if (isRecord(value)) next[field] = fix(value);
			}
			node = next;
		}
		const out = rewriteNodeEdges(node, type, rewriteEntries);
		for (const [from, count] of [...out.hits].sort(([a], [b]) => (a < b ? -1 : 1))) {
			rewritten.push({ node: fin, from, to: rewriteMap[from] ?? from, count });
		}
		results.set(fin, out.node);
	}

	// pending-reverses.json: keys and edge slugs follow the renames. A key that lands on a node that
	// exists (the benign collision `artist:l-titia-sadier` -> `artist:laetitia-sadier`) is applied to it
	// now and dropped: the pending edge would otherwise wait for a write that never comes, and the
	// forward edge the rename just attached to a real node would have no reverse (audit reciprocity).
	const pending = rewritePendingReverses(input.pending, rewriteEntries);
	const pendingRenames = Object.keys(input.pending)
		.filter((k) => rewriteMap[k] !== undefined)
		.sort()
		.map((from) => ({ from, to: rewriteMap[from] as string }));
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
		if (!parsed.success) {
			errors.push(`refusing to write an invalid node ${fin}: ${parsed.error.message}`);
		} else if (!onlyAddsSchemaDefaults(node, parsed.data)) {
			errors.push(`refusing to write ${fin}: validation would alter fields the node carries`);
		} else {
			writes.set(fin, parsed.data as Obj);
		}
	}

	// 9. Invariants over the resulting cache.
	for (const [fin, node] of results) {
		for (const { field, edge } of allEdges(node, parseSlug(fin).type)) {
			const slug = str(edge.slug);
			if (slug && slug !== fin && rewriteMap[slug] !== undefined && !results.has(slug)) {
				errors.push(`stale edge: ${fin}.${field} still points to ${slug}`);
			}
		}
	}
	for (const slug of Object.keys(rewriteMap)) {
		if (results.has(slug)) errors.push(`redirect key ${slug} is also a live node after the migration`);
	}

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
}

export interface MigrationResult {
	manifest: Manifest;
	/** 0 clean; 1 invariant violation (nothing written); 2 refused to run. */
	exitCode: 0 | 1 | 2;
}

async function readIdentities(path: string): Promise<ArtistIdentities | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	const raw = JSON.parse(text) as unknown;
	if (!isRecord(raw) || !isRecord(raw.resolved))
		throw new Error(`${path} is not an artist-identity manifest`);
	const groups = new Map<string, string[]>();
	for (const [slug, entry] of Object.entries(raw.resolved)) {
		if (!isRecord(entry)) continue;
		groups.set(
			slug,
			edgeList(entry.groups).flatMap((g) => str(g.mbid) ?? []),
		);
	}
	const collisions = (Array.isArray(raw.collisions) ? raw.collisions : []).flatMap((c: unknown) =>
		isRecord(c) && str(c.mbid) && Array.isArray(c.slugs)
			? [{ mbid: c.mbid as string, slugs: c.slugs.filter((s): s is string => typeof s === "string") }]
			: [],
	);
	return { groups, collisions };
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
	let identities = await readIdentities(artistManifestPath);
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
	const pendingOld = JSON.parse(await readTextOrDefault(pendingPath, "{}")) as Record<
		string,
		PendingReverse[]
	>;

	const plan = planMigration({ files: nodes, identities, pending: pendingOld, existingRedirects });
	const failed = plan.manifest.errors.length > 0 || invalid.length > 0;
	if (invalid.length > 0)
		plan.manifest.errors.push(
			`${invalid.length} unreadable node file(s): refusing to migrate a cache we cannot fully read`,
		);
	const manifest: Manifest = { ...base, ...plan.manifest, notes, written: 0 };

	if (apply && !failed && plan.manifest.errors.length === 0) {
		// New files first, then edited ones; the old files go last (a duplicate is harmless, a loss is not).
		const ordered = [...plan.writes].sort(
			([a], [b]) => Number(plan.fresh.has(b)) - Number(plan.fresh.has(a)) || (a < b ? -1 : 1),
		);
		for (const [slug, node] of ordered) {
			const path = pathOf(cacheDir, slug);
			await mkdir(dirname(path), { recursive: true });
			await atomicWriteJson(path, node);
		}
		manifest.written = plan.writes.size;
		if (plan.pending.changed) await atomicWriteJson(pendingPath, plan.pending.result);
		if (JSON.stringify(plan.mergedRedirects) !== JSON.stringify(existingRedirects)) {
			await mkdir(dirname(redirectsPath), { recursive: true });
			await atomicWriteJson(redirectsPath, {
				source: "release slug scoping",
				generated_at: base.generated_at,
				redirects: plan.mergedRedirects,
			});
		}
		for (const file of plan.deletions.values()) await rm(file.path);
	}
	if (options.manifestPath) {
		await mkdir(dirname(options.manifestPath), { recursive: true });
		await atomicWriteJson(options.manifestPath, manifest);
	}
	return { manifest, exitCode: manifest.errors.length > 0 ? 1 : 0 };
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
