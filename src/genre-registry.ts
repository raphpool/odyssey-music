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
import type { GenreResolver } from "./genre-identity.js";
import { EDGE_TARGET_TYPES_BY_TYPE, LIST_EDGES_BY_TYPE, NODE_TYPES } from "./node-spec.js";
import { isValidSlug } from "./slug.js";
import type { EdgeRef, NodeType, Slug } from "./types.js";

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
		if (!isGenreSlug(from)) {
			throw new Error(`Invalid genre-redirects.json entry: key "${from}" is not a genre slug`);
		}
		if (!isGenreSlug(to)) {
			throw new Error(`Invalid genre-redirects.json entry: value "${to}" is not a genre slug`);
		}
		redirects.set(from, to);
	}
	for (const to of redirects.values()) {
		if (redirects.has(to)) {
			throw new Error(`genre-redirects.json is not flattened: "${to}" appears as both key and value`);
		}
	}
	return redirects;
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
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw e;
	}
	return parseGenreRedirects(JSON.parse(raw));
}

export interface GenreRegistry {
	canonicalSlugFor(ref: { slug: Slug; name: string; qid?: string }): Promise<{ slug: Slug; qid?: string }>;
	canonicalizeGenreEdges(refs: readonly EdgeRef[]): Promise<EdgeRef[]>;
	canonicalizeNodeEdges(node: unknown): Promise<void>;
}

export interface GenreRegistryDeps {
	cache: NodeCache;
	resolver: GenreResolver;
	redirects: GenreRedirects;
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
		if (node === null || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const nodeType = rec.type;
		if (!isNodeType(nodeType)) return;
		const ownSlug = rec.slug;

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
			// node reference itself.
			rec[field] = canonicalRefs.filter((r) => r.slug !== ownSlug);
		}
	}

	return { canonicalSlugFor, canonicalizeGenreEdges, canonicalizeNodeEdges };
}
