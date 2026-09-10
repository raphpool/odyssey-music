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

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { NodeCache } from "./cache.js";
import type { GenreResolver } from "./genre-identity.js";
import { LIST_EDGES_BY_TYPE, NODE_TYPES } from "./node-spec.js";
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
 */
export async function loadGenreRedirects(): Promise<GenreRedirects> {
	const here = dirname(fileURLToPath(import.meta.url));
	const path = join(here, "..", "data", "genre-redirects.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
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
		ref: { slug: Slug; name: string; qid?: string },
		batchMemo: Map<string, Slug> | undefined,
	): Promise<{ slug: Slug; qid?: string }> {
		const qid = ref.qid ?? deps.resolver.resolve({ name: ref.name })?.qid ?? undefined;

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

	async function canonicalizeGenreEdges(refs: readonly EdgeRef[]): Promise<EdgeRef[]> {
		const batchMemo = new Map<string, Slug>();
		const seenSlugs = new Set<Slug>();
		const out: EdgeRef[] = [];
		for (const ref of refs) {
			const { slug, qid } = await resolveCanonical(ref, batchMemo);
			// De-dup by final slug, first occurrence wins -- order is otherwise preserved.
			if (seenSlugs.has(slug)) continue;
			seenSlugs.add(slug);
			out.push(qid ? { ...ref, slug, qid } : { ...ref, slug });
		}
		return out;
	}

	async function canonicalizeNodeEdges(node: unknown): Promise<void> {
		if (node === null || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const nodeType = rec.type;
		if (!isNodeType(nodeType)) return;

		for (const field of LIST_EDGES_BY_TYPE[nodeType]) {
			const value = rec[field];
			if (!Array.isArray(value)) continue;
			const refs = value as EdgeRef[];
			const genreRefs = refs.filter((r) => r?.type === "genre");
			if (genreRefs.length === 0) continue;
			const canonicalGenreRefs = await canonicalizeGenreEdges(genreRefs);
			if (genreRefs.length === refs.length) {
				rec[field] = canonicalGenreRefs;
				continue;
			}
			// Defensive path: every genre-bearing list field declared in EDGE_FIELDS_BY_TYPE
			// (node-spec.ts) targets "genre" only, so a mix isn't expected in practice. Keep
			// non-genre refs untouched, in their original relative order, ahead of the
			// canonicalized genre refs -- correctness over positional fidelity for a case that
			// shouldn't occur.
			const nonGenreRefs = refs.filter((r) => r?.type !== "genre");
			rec[field] = [...nonGenreRefs, ...canonicalGenreRefs];
		}
	}

	return { canonicalSlugFor, canonicalizeGenreEdges, canonicalizeNodeEdges };
}
