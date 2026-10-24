// TRA-607: the label counterpart of genre-registry.ts. Every producer of a label edge (the LLM draft's
// `artist.labels` / `project.label` / `genre.key_labels`, the MusicBrainz `meta.label` override) derives the
// target slug from the cited NAME alone, so "Warp" and "Warp Records" mint two nodes for one label. TRA-600
// and TRA-608 merge such pairs after the fact; this module stops the pipeline from recreating them.
//
// For each label edge, in order:
//   1. a slug with a live cache node never moves (a live node is never redirected away from itself);
//   2. a redirect of data/slug-redirects.json (a merged loser must not be reborn) is followed;
//   3. a slug that is a member of a PROVEN group of the identity table (TRA-600/608) goes to the group's
//      canonical member, and so does a ref whose name is a suffix variant ("Records", "Recordings", "Music",
//      "Ltd") of a member and whose mbid is one of the group's;
//   4. a suffix variant of a cached label that carries the SAME mbid goes to that label;
//   5. otherwise the name-derived slug is kept.
// Steps 3 and 4 need a proof of identity. A normalized name alone is never one: "Virgin", "KMS", "Plus 8" and
// the six "Axis Records" of MusicBrainz show two labels can share it. Without proof the edge keeps its own slug
// and the label gets its own node, which is the safe side of the trade (a duplicate is mergeable later, a wrong
// merge rewrites another label's history).

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { NodeCache } from "./cache.js";
import { isNotFoundError } from "./errors.js";
import { logger } from "./logger.js";
import { EDGE_TARGET_TYPES_BY_TYPE, NODE_TYPES } from "./node-spec.js";
import { isReadableSlug } from "./slug.js";
import type { EdgeRef, NodeType, Slug } from "./types.js";

const log = logger.child({ module: "label-registry" });

/** Loser slug -> canonical slug: the merged table loadRedirects() returns (data/slug-redirects.json). */
export type LabelRedirects = ReadonlyMap<Slug, Slug>;

/** One set of label slugs proven to be the same label, with the MusicBrainz ids that identify it. */
export interface LabelIdentityGroup {
	key: string;
	members: readonly Slug[];
	mbids: ReadonlySet<string>;
}

// The proofs the pipeline reads: the PROVEN groups of the TRA-600/608 identity table, in data/ and not in
// scripts/migrations/ where that table lives. Two constraints decide it: the server's import graph must not
// read outside the paths the iOS workflow watches (test/native-ci-triggers.test.ts), and the migration and
// its tests (edited by TRA-609) keep the table where they expect it. So this is a derived copy, reduced to
// what a lookup needs (the refused groups, the MusicBrainz/Wikidata names, anchors and evidence stay in the
// source), and test/label-registry.test.ts fails when the two drift apart.
const IDENTITIES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "label-identities.json");

const mbid = z.string().uuid();
const labelSlug = z.string().refine((s): s is Slug => isReadableSlug(s) && s.startsWith("label:"), {
	message: "not a label slug",
});
const identitiesFileSchema = z.object({
	groups: z.array(z.object({ key: z.string().min(1), members: z.array(labelSlug), mbids: z.array(mbid) })),
});

/**
 * Parses data/label-identities.json. Pure. A malformed table throws, like the redirect tables: silently
 * reading less proof would make the pipeline mint duplicates again.
 */
export function parseLabelIdentities(raw: unknown): LabelIdentityGroup[] {
	return identitiesFileSchema.parse(raw).groups.map((g) => ({
		key: g.key,
		members: g.members as Slug[],
		mbids: new Set(g.mbids.map((id) => id.toLowerCase())),
	}));
}

/**
 * Loads the identity table. An absent file means no proof, not an error: the registry then only follows
 * redirects and same-mbid variants. `path` overrides the default location (tests).
 */
export async function loadLabelIdentities(path: string = IDENTITIES_PATH): Promise<LabelIdentityGroup[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (e) {
		if (isNotFoundError(e)) {
			log.warn("label identity table not found: label variants are only merged on a shared mbid", {
				path,
			});
			return [];
		}
		throw e;
	}
	return parseLabelIdentities(JSON.parse(raw));
}

// Trailing words that make two label names the same label's name ("Warp" / "Warp Records").
const NAME_SUFFIXES = ["records", "recordings", "music", "ltd", "limited"] as const;
const SUFFIX_SET: ReadonlySet<string> = new Set(NAME_SUFFIXES);

/**
 * The slug body without its company suffixes, or undefined for a slug that carries a disambiguator
 * (`--`, a homonym already told apart on purpose) or that is nothing but a suffix. Pure.
 */
export function labelBaseOf(slug: Slug): string | undefined {
	const body = slug.slice("label:".length);
	if (!body || body.includes("--")) return undefined;
	const tokens = body.split("-");
	while (tokens.length > 1 && SUFFIX_SET.has(tokens[tokens.length - 1] ?? "")) tokens.pop();
	const base = tokens.join("-");
	return SUFFIX_SET.has(base) ? undefined : base;
}

/** The slugs of the suffix variants of `base`: `x`, `x-records`, `x-recordings`, ... */
function variantsOf(base: string): Slug[] {
	return [`label:${base}`, ...NAME_SUFFIXES.map((s) => `label:${base}-${s}`)] as Slug[];
}

export interface LabelRef {
	slug: Slug;
	mbid?: string | undefined;
}

export interface LabelRegistry {
	/** The slug a reference to this label should carry; `ref.slug` itself when nothing is proven. */
	canonicalSlugFor(ref: LabelRef): Promise<Slug>;
	/**
	 * Canonicalizes every label-bearing edge field of a node in place (list or single), de-duplicating a
	 * list by final slug, first occurrence wins. Same hook as GenreRegistry.canonicalizeNodeEdges, which
	 * calls it.
	 */
	canonicalizeNodeEdges(node: unknown): Promise<void>;
}

export interface LabelRegistryDeps {
	cache: NodeCache;
	redirects: LabelRedirects;
	/** Proven identity groups; empty (or omitted) = no proof beyond a shared mbid. */
	identities?: readonly LabelIdentityGroup[];
}

function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

export function createLabelRegistry(deps: LabelRegistryDeps): LabelRegistry {
	const groups = deps.identities ?? [];
	const groupOfMember = new Map<Slug, LabelIdentityGroup>();
	for (const group of groups) for (const member of group.members) groupOfMember.set(member, group);

	// The slug a proven group lands on: its single member that is not a merged loser, else (the migration
	// has not run on this cache yet) its first member that has a node, else undefined.
	async function groupTarget(group: LabelIdentityGroup): Promise<Slug | undefined> {
		const survivors = group.members.filter((m) => !deps.redirects.has(m));
		if (survivors.length === 1) return survivors[0];
		for (const member of group.members) if (await deps.cache.has(member)) return member;
		return undefined;
	}

	// A suffix variant of the ref that is a member of a group the ref's mbid belongs to.
	function groupOfVariant(ref: LabelRef): LabelIdentityGroup | undefined {
		const base = labelBaseOf(ref.slug);
		if (base === undefined || !ref.mbid) return undefined;
		const id = ref.mbid.toLowerCase();
		return groups.find((g) => g.mbids.has(id) && g.members.some((m) => labelBaseOf(m) === base));
	}

	// A cached suffix variant of the ref carrying the ref's own mbid. A node with no mbid proves nothing.
	async function variantWithSameMbid(ref: LabelRef): Promise<Slug | undefined> {
		const base = labelBaseOf(ref.slug);
		if (base === undefined || !ref.mbid) return undefined;
		const id = ref.mbid.toLowerCase();
		for (const candidate of variantsOf(base)) {
			if (candidate === ref.slug || !(await deps.cache.has(candidate))) continue;
			try {
				const node = await deps.cache.get(candidate);
				if (node.type === "label" && node.mbid?.toLowerCase() === id) return candidate;
			} catch (e) {
				// An unreadable node cannot prove anything; the edge keeps its own slug.
				if (!isNotFoundError(e)) {
					log.warn("canonicalSlugFor: skipping unreadable label node", {
						slug: candidate,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}
		return undefined;
	}

	async function canonicalSlugFor(ref: LabelRef): Promise<Slug> {
		if (await deps.cache.has(ref.slug)) return ref.slug;
		const redirected = deps.redirects.get(ref.slug);
		if (redirected) return redirected;
		const group = groupOfMember.get(ref.slug) ?? groupOfVariant(ref);
		if (group) {
			const target = await groupTarget(group);
			if (target) return target;
		}
		return (await variantWithSameMbid(ref)) ?? ref.slug;
	}

	async function canonicalizeRef(ref: EdgeRef): Promise<EdgeRef> {
		const slug = await canonicalSlugFor(ref);
		// ref.name is this edge's own display text, never realigned to the target node's name.
		return slug === ref.slug ? ref : { ...ref, slug };
	}

	async function canonicalizeNodeEdges(node: unknown): Promise<void> {
		if (node === null || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const nodeType = rec.type;
		if (!isNodeType(nodeType)) return;
		for (const [field, targets] of Object.entries(EDGE_TARGET_TYPES_BY_TYPE[nodeType])) {
			if (!targets.includes("label")) continue;
			const value = rec[field];
			if (Array.isArray(value)) {
				const seen = new Set<Slug>();
				const out: EdgeRef[] = [];
				for (const ref of value as EdgeRef[]) {
					const canonical = await canonicalizeRef(ref);
					if (seen.has(canonical.slug)) continue;
					seen.add(canonical.slug);
					out.push(canonical);
				}
				rec[field] = out;
			} else if (value !== null && typeof value === "object") {
				rec[field] = await canonicalizeRef(value as EdgeRef);
			}
		}
	}

	return { canonicalSlugFor, canonicalizeNodeEdges };
}
