/**
 * One edge per slug in a list (TRA-557, decision of 2026-10-23: one page per title).
 *
 * The slug is the identity of the page an edge points at. Two entries of the same list that share a slug
 * point at the same page, and the card prints it twice: 173 of them sat in 83 cached nodes (166 in
 * `artist.discography`, where a single, its remixes and the album of the same title share a scoped slug).
 * The pipeline keeps the invariant with this module (src/pipeline.ts), and the migration
 * `2026-10-24-dedupe-list-edges` applies it to the cache that already exists: same rule, same code.
 *
 * Which entry stays, for two entries of one slug:
 *  - the mbid is the same, or one side has none: they describe the same thing. The first occurrence stays and
 *    takes the fields it lacks from the other (`year`, `releaseType`, ...), never overwriting one it has, and
 *    only when that cannot graft another release's identity on it (same mbid, or same name);
 *  - the mbids differ (two release groups under one title), in this order:
 *      1. `target-mbid`: the entry whose mbid is the one of the node the slug points at (when the caller knows
 *         the nodes: the migration does, on the union). The page was born from that release group;
 *      2. `canonical-title`: a title that is not a variant (`isNonCanonicalReleaseTitle`, a remix, a live mix,
 *         "(Remixes)"...) beats one that is. `classifyRelease` excludes these titles from a generated
 *         discography BEFORE it collapses release groups that share a slug, so an original never loses to one;
 *      3. `bare-title`: a title without a trailing parenthesis beats one with it ("Biking" over "Biking (solo)");
 *      4. `release-type`: album before EP before single, then
 *      5. `earlier-year`: the earliest year (an unknown year loses to a known one), as
 *         `byPreferredDuplicate` (src/discography-policy.ts) orders two release groups of one project slug.
 *    No field is merged across two mbids: the year of a remix is not the year of the album;
 *  - still a tie (same type and year, or an edge that carries neither, such as a tracklist entry): doubt, the
 *    first occurrence stays and the removal says so. MusicBrainz votes would break the tie, but they are
 *    stored nowhere in the cache, and this module never calls a network.
 *
 * The surviving entries keep their relative order, so a discography stays sorted by year. An entry without a
 * usable slug is not an edge reference this module can compare: it passes through untouched.
 */
import { isNonCanonicalReleaseTitle } from "./discography-policy.js";
import { LIST_EDGES_BY_TYPE, NODE_TYPES, type NodeType } from "./node-spec.js";

type Obj = Record<string, unknown>;

export type DedupeReason =
	/** Same mbid, or no mbid on one side: the later entry is the same thing, merged into the first. */
	| "same-or-missing-mbid"
	/** Different mbids: the entry carrying the mbid of the target node won. */
	| "target-mbid"
	/** Different mbids: the title that is not a variant (remix, live mix...) won. */
	| "canonical-title"
	/** Different mbids: the title without a trailing parenthesis won. */
	| "bare-title"
	/** Different mbids: the stronger release type won (album, EP, single). */
	| "release-type"
	/** Different mbids, same type: the earlier year won. */
	| "earlier-year"
	/** Different mbids and nothing in the edges tells them apart: the first occurrence stayed. */
	| "doubt-first-kept";

export interface EdgeRemoval {
	slug: string;
	reason: DedupeReason;
	/** The entry dropped, as it was read. */
	removed: Obj;
	/** The entry that stays in its place, after the merge of the complementary fields. */
	kept: Obj;
}

export interface DedupeResult {
	/** The list without the duplicates; the same entries, in the same order, when there was none. */
	edges: unknown[];
	removals: EdgeRemoval[];
}

/** slug -> lower-cased mbid of the node that slug points at, for the nodes that exist and carry one. */
export type TargetMbids = ReadonlyMap<string, string>;

/** Fields a later duplicate may fill in on the kept entry; `name` and `slug` never move. */
const COMPLEMENTARY_FIELDS = ["mbid", "qid", "year", "releaseType", "artist"] as const;

const RELEASE_TYPE_RANK: Readonly<Record<string, number>> = { album: 0, ep: 1, single: 2 };
const UNKNOWN_RANK = 3;
const TRAILING_PARENTHESIS = /[([][^()[\]]*[)\]]\s*$/u;

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function slugOf(entry: unknown): string | undefined {
	return isObj(entry) && typeof entry.slug === "string" && entry.slug !== "" ? entry.slug : undefined;
}

function mbidOf(edge: Obj): string | undefined {
	const raw = edge.mbid;
	const mbid = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return mbid === "" ? undefined : mbid;
}

function nameOf(edge: Obj): string {
	return typeof edge.name === "string" ? edge.name.trim() : "";
}

function hasText(v: unknown): v is string {
	return typeof v === "string" && v.trim() !== "";
}

function yearOf(edge: Obj): number | undefined {
	return typeof edge.year === "string" && /^\d{4}$/.test(edge.year) ? Number(edge.year) : undefined;
}

function rankOf(edge: Obj): number {
	return typeof edge.releaseType === "string"
		? (RELEASE_TYPE_RANK[edge.releaseType] ?? UNKNOWN_RANK)
		: UNKNOWN_RANK;
}

function sameOrMissingMbid(a: Obj, b: Obj): boolean {
	const ma = mbidOf(a);
	const mb = mbidOf(b);
	return ma === undefined || mb === undefined || ma === mb;
}

/** Whether `other` may fill the gaps of `edge`: the same release (same mbid) or the same title. */
function mayFill(edge: Obj, other: Obj): boolean {
	const mbid = mbidOf(edge);
	if (mbid !== undefined && mbid === mbidOf(other)) return true;
	return nameOf(edge).toLowerCase() === nameOf(other).toLowerCase();
}

/** `edge` plus the complementary fields it lacks and `other` has. A new object; neither input is touched. */
function withComplements(edge: Obj, other: Obj): Obj {
	if (!mayFill(edge, other)) return edge;
	const merged: Obj = { ...edge };
	for (const field of COMPLEMENTARY_FIELDS) {
		if (!hasText(merged[field]) && hasText(other[field])) merged[field] = other[field];
	}
	return merged;
}

interface Verdict {
	/** Whether the later entry replaces the incumbent. */
	challengerWins: boolean;
	reason: Exclude<DedupeReason, "same-or-missing-mbid">;
}

/** Two entries of one slug with different mbids. A tie leaves the incumbent, which is the first occurrence. */
function prefer(incumbent: Obj, challenger: Obj, targetMbid: string | undefined): Verdict {
	if (targetMbid !== undefined) {
		const incumbentIs = mbidOf(incumbent) === targetMbid;
		const challengerIs = mbidOf(challenger) === targetMbid;
		if (incumbentIs !== challengerIs) return { challengerWins: challengerIs, reason: "target-mbid" };
	}
	const incumbentVariant = isNonCanonicalReleaseTitle(nameOf(incumbent));
	const challengerVariant = isNonCanonicalReleaseTitle(nameOf(challenger));
	if (incumbentVariant !== challengerVariant) {
		return { challengerWins: incumbentVariant, reason: "canonical-title" };
	}
	const incumbentSuffixed = TRAILING_PARENTHESIS.test(nameOf(incumbent));
	const challengerSuffixed = TRAILING_PARENTHESIS.test(nameOf(challenger));
	if (incumbentSuffixed !== challengerSuffixed) {
		return { challengerWins: incumbentSuffixed, reason: "bare-title" };
	}
	const rankI = rankOf(incumbent);
	const rankC = rankOf(challenger);
	if (rankI !== rankC) return { challengerWins: rankC < rankI, reason: "release-type" };
	const yearI = yearOf(incumbent);
	const yearC = yearOf(challenger);
	if (yearI !== yearC && (yearI !== undefined || yearC !== undefined)) {
		const challengerWins = yearI === undefined || (yearC !== undefined && yearC < yearI);
		return { challengerWins, reason: "earlier-year" };
	}
	return { challengerWins: false, reason: "doubt-first-kept" };
}

interface Drop {
	slug: string;
	reason: DedupeReason;
	removed: Obj;
}

interface Survivor {
	index: number;
	/** The entry with the fields merged into it so far. */
	edge: Obj;
	/** The entry as it was read. */
	original: Obj;
}

/**
 * Keeps one entry per slug in `list`. Pure: returns a new list, and never mutates an entry. `targetMbids`
 * (optional) names the mbid of the node a slug points at, the first criterion between two release groups.
 */
export function dedupeEdgeList(list: readonly unknown[], targetMbids?: TargetMbids): DedupeResult {
	const survivors = new Map<string, Survivor>();
	const drops: Drop[] = [];

	list.forEach((entry, index) => {
		const slug = slugOf(entry);
		if (slug === undefined || !isObj(entry)) return;
		const incumbent = survivors.get(slug);
		if (incumbent === undefined) {
			survivors.set(slug, { index, edge: entry, original: entry });
		} else if (sameOrMissingMbid(incumbent.edge, entry)) {
			survivors.set(slug, { ...incumbent, edge: withComplements(incumbent.edge, entry) });
			drops.push({ slug, reason: "same-or-missing-mbid", removed: entry });
		} else {
			const verdict = prefer(incumbent.edge, entry, targetMbids?.get(slug)?.toLowerCase());
			if (verdict.challengerWins) {
				survivors.set(slug, { index, edge: entry, original: entry });
				drops.push({ slug, reason: verdict.reason, removed: incumbent.original });
			} else {
				drops.push({ slug, reason: verdict.reason, removed: entry });
			}
		}
	});

	if (drops.length === 0) return { edges: [...list], removals: [] };

	const edges: unknown[] = [];
	list.forEach((entry, index) => {
		const slug = slugOf(entry);
		const survivor = slug === undefined ? undefined : survivors.get(slug);
		if (survivor === undefined) edges.push(entry);
		else if (survivor.index === index) edges.push(survivor.edge);
	});
	const removals = drops.map((d): EdgeRemoval => {
		const kept = survivors.get(d.slug)?.edge;
		if (kept === undefined) throw new Error(`dedupeEdgeList: no survivor for ${d.slug}`); // unreachable
		return { slug: d.slug, reason: d.reason, removed: d.removed, kept };
	});
	return { edges, removals };
}

export interface FieldRemovals {
	field: string;
	removals: EdgeRemoval[];
}

function nodeTypeOf(node: Obj): NodeType | undefined {
	return (NODE_TYPES as readonly string[]).includes(node.type as string)
		? (node.type as NodeType)
		: undefined;
}

/**
 * Applies {@link dedupeEdgeList} to every list edge field of a node (`LIST_EDGES_BY_TYPE`), in place, and
 * reports what it removed per field. A node of an unknown type, or a field that is not an array, is left alone.
 * Singular edges (`landmark_project`) cannot hold a duplicate.
 */
export function dedupeNodeListEdges(node: Obj, targetMbids?: TargetMbids): FieldRemovals[] {
	const type = nodeTypeOf(node);
	if (type === undefined) return [];
	const out: FieldRemovals[] = [];
	for (const field of LIST_EDGES_BY_TYPE[type]) {
		const value = node[field];
		if (!Array.isArray(value)) continue;
		const result = dedupeEdgeList(value, targetMbids);
		if (result.removals.length === 0) continue;
		node[field] = result.edges;
		out.push({ field, removals: result.removals });
	}
	return out;
}
