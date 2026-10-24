// 2026-09-09: the three producers of genre edges (mbGenreEdges, the parent_genres catalog
// backfill, and normalizeEdge) all derive a genre's slug from its display *name*, never asking
// "does a node for this QID already exist?". That produced 20 groups of duplicate genre nodes
// sharing a QID (e.g. "electronic" / "electronic-music"), 7 of them exact catalog slugs emitted
// by the parent_genres backfill. This module is the canonicalization rule (decision d'archi 7,
// docs/plans/qid-genre-identity.md): for each genre edge, in order —
//   1. resolve/stamp a qid on the ref if it doesn't already carry one;
//   2. a slug with an existing cache node always wins, unchanged — that's what makes this safe
//      to run *before* the duplicate-merge migration;
//   3. otherwise follow a redirect (data/genre-redirects.json), if one exists;
//   4. otherwise, if a qid is known, point at the slug already carrying that qid (batch memory,
//      then NodeCache.findGenreSlugByQid);
//   5. otherwise mint: keep the name-derived slug, same as today.
// Nothing calls this yet — see TRA-28 for wiring it into runPipeline.
//
// 2026-09-10 (review round): a ref's own `qid`, when already set, is never replaced by a fresh
// resolver lookup -- and the freshly resolved qid for a ref can legitimately disagree with the
// qid already persisted on the node that rule 2 keeps pointing at (e.g. "trap" MBID-resolves to
// Q2913982 while the existing genre:trap node was minted with a different qid); this module
// doesn't reconcile that, it only decides the slug -- tracked as a curation follow-up in TRA-35.
//
// 2026-09-10 (TRA-36): canonicalizeNodeEdges now shares one batchMemo across every genre-bearing
// field of a node instead of one per field. That widens the window for the mismatch above: a
// rule-2 hit in one field still memoizes its freshly-resolved (possibly wrong) qid, and that entry
// is now visible to every later field on the same node, not just later refs in the same field.
// Still tracked under TRA-35, not reconciled here.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { NodeCache } from "./cache.js";
import { isNotFoundError } from "./errors.js";
import type { GenreResolver } from "./genre-identity.js";
import type { LabelRegistry } from "./label-registry.js";
import { logger } from "./logger.js";
import { EDGE_TARGET_TYPES_BY_TYPE, LIST_EDGES_BY_TYPE, NODE_TYPES } from "./node-spec.js";
import { isReadableSlug, isValidSlug, parseSlug } from "./slug.js";
import type { EdgeRef, NodePayload, NodeType, Slug } from "./types.js";

const log = logger.child({ module: "genre-registry" });

/** Loser slug -> canonical slug, as produced by TRA-22's duplicate-merge migration. */
export type GenreRedirects = ReadonlyMap<Slug, Slug>;

const genreRedirectsFileSchema = z.object({
	// `source` / `generated_at` (TRA-22's provenance fields) are not declared here, so Zod
	// strips them: this module only cares about the redirect table itself.
	redirects: z.record(z.string(), z.string()),
});

function isGenreSlug(value: string): value is Slug {
	return isValidSlug(value) && value.startsWith("genre:");
}

// A redirect KEY is the retired slug: only ever a lookup key, never turned into a path or markup. It may
// be a legacy, non-canonical slug -- renaming such a node away (the TRA-501 remediation channel,
// scripts/migrations/2026-09-10-rename-genre-node.ts) writes exactly that key -- so keys only need to be
// readable. VALUES are where a read lands and stay canonical.
function isRedirectKey(value: string): value is Slug {
	return isReadableSlug(value);
}

/**
 * Parses the shape TRA-22's merge script writes to data/genre-redirects.json. Pure: no I/O.
 *
 * Every key and value must be a valid genre slug, and the table must already be flattened by
 * the producer — no value may also appear as a key, since that single-hop invariant is what
 * lets canonicalSlugFor follow a redirect without chasing a chain. Either violation throws:
 * this is the only case where this module raises, because a malformed redirects file would
 * otherwise silently mis-canonicalize genre edges rather than fail loudly.
 */
export function parseGenreRedirects(raw: unknown): GenreRedirects {
	const parsed = genreRedirectsFileSchema.parse(raw);
	const redirects = new Map<Slug, Slug>();
	for (const [from, to] of Object.entries(parsed.redirects)) {
		if (!isRedirectKey(from) || !from.startsWith("genre:")) {
			throw new Error(`Invalid genre-redirects.json entry: key "${from}" is not a genre slug`);
		}
		if (!isGenreSlug(to)) {
			throw new Error(`Invalid genre-redirects.json entry: value "${to}" is not a genre slug`);
		}
		redirects.set(from, to);
	}
	assertFlattened(redirects, "genre-redirects.json");
	return redirects;
}

/**
 * Parses data/slug-redirects.json (TRA-453): same file shape as genre-redirects.json, but the
 * table covers every node type (the identity migration renames project and track slugs). Pure:
 * no I/O.
 *
 * Every key and value must be a valid slug, and a redirect never changes type (`track:a ->
 * project:b` is a type mismatch: a read of a track slug must not answer with another kind of
 * node). The table must be flattened, as for genres, so a read follows a single hop. Any
 * violation throws, for the same reason as parseGenreRedirects: a malformed table would
 * silently misroute deep links instead of failing loudly.
 */
export function parseSlugRedirects(raw: unknown): GenreRedirects {
	const parsed = genreRedirectsFileSchema.parse(raw);
	const redirects = new Map<Slug, Slug>();
	for (const [from, to] of Object.entries(parsed.redirects)) {
		if (!isRedirectKey(from)) {
			throw new Error(`Invalid slug-redirects.json entry: key "${from}" is not a slug`);
		}
		if (!isValidSlug(to)) {
			throw new Error(`Invalid slug-redirects.json entry: value "${to}" is not a slug`);
		}
		if (parseSlug(from).type !== parseSlug(to).type) {
			throw new Error(`slug-redirects.json type mismatch: "${from}" -> "${to}"`);
		}
		redirects.set(from, to);
	}
	assertFlattened(redirects, "slug-redirects.json");
	return redirects;
}

function assertFlattened(redirects: ReadonlyMap<Slug, Slug>, label: string): void {
	for (const to of redirects.values()) {
		if (redirects.has(to)) {
			throw new Error(`${label} is not flattened: "${to}" appears as both key and value`);
		}
	}
}

/**
 * Loads data/genre-redirects.json, resolved relative to this module (same pattern as
 * loadGenreCatalog / loadGenreResolver). TRA-22's merge script hasn't run until it produces this
 * file, so a missing file resolves to an empty table rather than an error. Not memoized — the
 * caller (server.ts, wired in a later ticket) loads it once and holds onto the result; reuse
 * that loaded value instead of reading the file again (see TRA-23).
 *
 * `path` overrides the default location -- for tests exercising the absent/present transition
 * against a real temp file rather than the (currently nonexistent) real data file, which would
 * start failing the moment TRA-22 lands it. Production callers omit it.
 */
export async function loadGenreRedirects(path?: string): Promise<GenreRedirects> {
	const filePath =
		path ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "genre-redirects.json");
	return readRedirectsFile(filePath, parseGenreRedirects);
}

async function readRedirectsFile(
	filePath: string,
	parse: (raw: unknown) => GenreRedirects,
): Promise<GenreRedirects> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw e;
	}
	return parse(JSON.parse(raw));
}

/**
 * The table every read path and the graph export load (TRA-453): the union of
 * data/genre-redirects.json (genre rules unchanged) and data/slug-redirects.json (every type).
 * Either file may be absent (-> empty). A key present in both files throws rather than letting
 * one silently win, and the union is re-checked for flatness since a slug-redirects.json genre
 * entry could point at a genre-redirects.json key. `paths` overrides the default locations --
 * test-only injection, like loadGenreRedirects's `path`.
 */
export async function loadRedirects(paths?: {
	genre?: string | undefined;
	slug?: string | undefined;
}): Promise<GenreRedirects> {
	const slugPath =
		paths?.slug ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "slug-redirects.json");
	const [genre, slug] = await Promise.all([
		loadGenreRedirects(paths?.genre),
		readRedirectsFile(slugPath, parseSlugRedirects),
	]);
	const union = new Map(genre);
	for (const [from, to] of slug) {
		if (union.has(from)) {
			throw new Error(
				`Redirect key "${from}" is present in both genre-redirects.json and slug-redirects.json`,
			);
		}
		union.set(from, to);
	}
	assertFlattened(union, "merged redirects table");
	return union;
}

/**
 * The read-time canonicalization rule shared by every slug-keyed read path: a live cache node
 * always wins, unchanged (even if the slug also happens to be a redirect key -- inconsistent
 * state, but a live node is never redirected away from itself); otherwise follow the flattened
 * redirect table for a single hop; otherwise the slug is returned unchanged (unknown slug, or a
 * slug with neither a live node nor a redirect entry). Never consults the qid index
 * (decision d'archi 9, docs/plans/qid-genre-identity.md) -- a slug that was never materialized
 * under any identity stays unresolved, since none of these read paths materialize on miss.
 *
 * `redirects.get` is checked first because it's an in-memory Map lookup (an immediate miss for
 * every slug that was never renamed) -- `cache.has`, a disk read, only runs for the rare slug
 * that's actually a redirect key. Since TRA-453 the table covers every node type, not only genres.
 *
 * 2026-09-10 (TRA-39): extracted from node-service.ts's original inline check (TRA-30) so
 * image-service and server.ts's handleLinks apply the exact same rule instead of reimplementing
 * it -- before this, GET /image and GET /links on a redirected genre slug diverged from
 * GET /node/:slug on the same slug (the latter already applied this rule).
 */
export async function resolveReadSlug(
	slug: Slug,
	redirects: GenreRedirects,
	cache: NodeCache,
): Promise<Slug> {
	const redirected = redirects.get(slug);
	if (redirected && !(await cache.has(slug))) return redirected;
	return slug;
}

export interface GenreRegistry {
	canonicalSlugFor(ref: {
		slug: Slug;
		name: string;
		qid?: string;
		mbid?: string;
	}): Promise<{ slug: Slug; qid?: string }>;
	canonicalizeGenreEdges(refs: readonly EdgeRef[]): Promise<EdgeRef[]>;
	canonicalizeNodeEdges(node: unknown): Promise<void>;
	/**
	 * The qid already committed on the cached genre node at `slug`, if any (TRA-32). Read-only —
	 * used by runPipeline both to carry a previously-resolved qid onto a rematerialized node when
	 * the resolver itself can't re-derive one, and to let an already-committed qid win over a
	 * disagreeing fresh resolve (identity corrections are a migration/curation concern, not a
	 * runtime one). Resolves to `undefined`, never rejects, in three cases: (1) no cache node at
	 * `slug` — a genre reference to a not-yet-materialized slug is the common case; (2) a node
	 * exists but isn't a genre node; (3) the cached file exists but is unreadable (malformed JSON,
	 * schema violation) — logged as a warning rather than propagated, so one corrupt genre file
	 * can't take down qid resolution for every other node.
	 */
	existingGenreQid(slug: Slug): Promise<string | undefined>;
}

export interface GenreRegistryDeps {
	cache: NodeCache;
	resolver: GenreResolver;
	redirects: GenreRedirects;
	/**
	 * OPTIONAL (TRA-607): canonicalizes the label edges of a node (src/label-registry.ts). It rides on
	 * canonicalizeNodeEdges, the one hook runPipeline calls once every edge producer has run, so each
	 * caller that already passes a genreRegistry gets label dedup without a second dependency to forget.
	 * Unset = label edges keep their name-derived slug, as before.
	 */
	labels?: LabelRegistry;
}

function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

/** Builds a GenreRegistry from real collaborators. Doing no I/O itself beyond what they do. */
export function createGenreRegistry(deps: GenreRegistryDeps): GenreRegistry {
	// Applies the five-step rule to a single ref. `batchMemo` (qid -> slug already assigned
	// earlier in the same canonicalizeGenreEdges call) is checked before falling back to the
	// cache's own qid index, and is updated with whatever slug this ref lands on — so a second
	// new ref sharing a qid with an earlier one in the same batch converges on the same slug
	// even though neither has a cache node yet. Undefined when called from canonicalSlugFor
	// directly, which has no batch to remember across.
	async function resolveCanonical(
		ref: { slug: Slug; name: string; qid?: string; mbid?: string },
		batchMemo: Map<string, Slug> | undefined,
	): Promise<{ slug: Slug; qid?: string }> {
		// A ref's own qid, when already set, is authoritative and never replaced by a fresh
		// resolver lookup. A known mbid is passed through -- like mbGenreEdges -- so a curated
		// MBID match (GenreResolver.resolve's own step 1) wins over a plain name match.
		const qid =
			ref.qid ??
			deps.resolver.resolve(ref.mbid ? { name: ref.name, mbid: ref.mbid } : { name: ref.name })?.qid ??
			undefined;

		const settle = (slug: Slug): { slug: Slug; qid?: string } => {
			if (qid && batchMemo && !batchMemo.has(qid)) batchMemo.set(qid, slug);
			return qid ? { slug, qid } : { slug };
		};

		// Rule 2: a ref pointing at an existing node never moves, even if the qid index would
		// suggest a different slug -- this is what makes canonicalization safe to run before
		// the duplicate-merge migration has unified those nodes.
		if (await deps.cache.has(ref.slug)) return settle(ref.slug);

		// Rule 3: follow a merge-migration redirect for this exact slug.
		const redirected = deps.redirects.get(ref.slug);
		if (redirected) return settle(redirected);

		// Rule 4: a known qid already assigned a slug, either earlier in this batch or by an
		// existing genre node in the cache.
		if (qid) {
			const known = batchMemo?.get(qid) ?? (await deps.cache.findGenreSlugByQid(qid));
			if (known) return settle(known);
		}

		// Rule 5: nothing to canonicalize against -- mint, i.e. keep the name-derived slug.
		return settle(ref.slug);
	}

	async function canonicalSlugFor(ref: {
		slug: Slug;
		name: string;
		qid?: string;
		mbid?: string;
	}): Promise<{ slug: Slug; qid?: string }> {
		return resolveCanonical(ref, undefined);
	}

	// `sharedBatchMemo` lets canonicalizeNodeEdges (below) pass one memo across every genre-bearing
	// field of the same node, so a new qid seen in an earlier field is recognized in a later one --
	// see TRA-36. Callers other than canonicalizeNodeEdges omit it and get today's behavior
	// unchanged: a fresh, call-scoped memo.
	async function canonicalizeGenreEdges(
		refs: readonly EdgeRef[],
		sharedBatchMemo?: Map<string, Slug>,
	): Promise<EdgeRef[]> {
		const batchMemo = sharedBatchMemo ?? new Map<string, Slug>();
		const seenSlugs = new Set<Slug>();
		const out: EdgeRef[] = [];
		for (const ref of refs) {
			const { slug, qid } = await resolveCanonical(ref, batchMemo);
			// De-dup by final slug, first occurrence wins -- order is otherwise preserved.
			if (seenSlugs.has(slug)) continue;
			seenSlugs.add(slug);
			// ref.name is this edge's own display text, not the target node's name -- it is never
			// realigned to whatever the canonical slug's node is called, even across a redirect.
			out.push(qid ? { ...ref, slug, qid } : { ...ref, slug });
		}
		return out;
	}

	async function canonicalizeNodeEdges(node: unknown): Promise<void> {
		await canonicalizeGenreNodeEdges(node);
		await deps.labels?.canonicalizeNodeEdges(node);
	}

	async function canonicalizeGenreNodeEdges(node: unknown): Promise<void> {
		if (node === null || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const nodeType = rec.type;
		if (!isNodeType(nodeType)) return;
		const ownSlug = rec.slug;
		// The node's own qid, when already stamped (enrichFromMusicBrainz's genre-catalog
		// backfill runs before this call point) -- used below to drop a self-loop that resolves
		// to a DIFFERENT slug sharing this same qid, not just an exact ownSlug match (TRA-28
		// review B3): materializing "genre:electronic-music" (qid Q9778) with a related_genres
		// ref that canonicalizes to the existing "genre:electronic" (also Q9778, rule 4) is the
		// same duplicate-pair problem this module exists to prevent, just discovered from the
		// new node's own side instead of an existing one's -- keeping that edge would let two
		// not-yet-merged duplicates of one QID point at each other in the emitted graph.
		const ownQid = typeof rec.qid === "string" ? rec.qid : undefined;

		// One batchMemo shared across every genre-bearing field of this node (TRA-36) -- without
		// it, two fields naming the same new genre differently (e.g. parent_genres: "Electronic
		// Music", related_genres: "Electronic") would each mint their own slug for the same qid,
		// since neither has a cache node yet to converge on. Fields are processed in
		// node-spec.ts's EDGE_FIELDS_BY_TYPE declaration order, so the first field to see a given
		// qid decides the slug every later field converges on.
		const batchMemo = new Map<string, Slug>();

		for (const field of LIST_EDGES_BY_TYPE[nodeType]) {
			// Select genre-bearing fields the same way schemas.ts does (EDGE_TARGET_TYPES_BY_TYPE),
			// rather than filtering individual refs by ref.type -- every such field targets
			// "genre" only (node-spec.ts EDGE_FIELDS_BY_TYPE), so this is exact, not defensive.
			if (!EDGE_TARGET_TYPES_BY_TYPE[nodeType][field]?.includes("genre")) continue;
			const value = rec[field];
			if (!Array.isArray(value)) continue;
			const canonicalRefs = await canonicalizeGenreEdges(value as EdgeRef[], batchMemo);
			// A genre node's own related_genres/parent_genres/subgenres can canonicalize a
			// name-derived variant of itself back onto its own slug (e.g. "techno-music"
			// resolving to the same qid as "techno") -- drop that self-loop rather than let a
			// node reference itself. Also drop a ref that lands on a DIFFERENT slug sharing this
			// node's own qid (see ownQid comment above): that's the same node, just not merged yet.
			rec[field] = canonicalRefs.filter((r) => r.slug !== ownSlug && !(ownQid && r.qid === ownQid));
		}
	}

	async function existingGenreQid(slug: Slug): Promise<string | undefined> {
		let existing: NodePayload;
		try {
			existing = await deps.cache.get(slug);
		} catch (e) {
			if (isNotFoundError(e)) return undefined;
			// A malformed genre file (bad JSON, a qid violating QID_PATTERN, a field NodeCache.get's
			// schema parse rejects, ...) must not take down the caller's whole qid-stamping block
			// with it -- runPipeline's enrichFromMusicBrainz still needs to resolve/backfill a
			// DIFFERENT node's genre edges even when this one slug's cache file is unreadable. Same
			// posture as NodeCache.buildGenreQidIndex's "skipping invalid genre node" (cache.ts
			// ~270-280): warn and treat it as "no cached qid" rather than propagate.
			log.warn("existingGenreQid: skipping unreadable genre node", {
				slug,
				error: e instanceof Error ? e.message : String(e),
			});
			return undefined;
		}
		// Only GenreNode carries a top-level qid; narrow on `type` rather than casting.
		return existing.type === "genre" ? existing.qid : undefined;
	}

	return { canonicalSlugFor, canonicalizeGenreEdges, canonicalizeNodeEdges, existingGenreQid };
}
