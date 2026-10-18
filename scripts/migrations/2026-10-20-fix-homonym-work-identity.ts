/**
 * Works whose MusicBrainz identity is a homonym's (TRA-604, plan docs/plans/graph-integrity.md). The identity
 * backfill (TRA-474, applied to prod by TRA-484) chose some MB release groups / recordings on the TITLE, and
 * the scope migration then scoped the slug on the wrong credit: `project:wish-you-were-here--american-hot-wax`
 * has Pink Floyd's article, producers, genres and label, and the mbid, credit, year, tracklist and cover of a
 * 2001 release by American Hot Wax (2026-10-17, prod; same for Daft Punk's *Around the World* credited to
 * Stanley Black and His Orchestra, 1958). The artist's page then lists the album twice, one of them credited to
 * the homonym. The resolver itself is not at fault any more (TRA-537 requires the credit to equal the hint, and
 * test/musicbrainz.test.ts pins the case); this repairs what it wrote before.
 *
 * Detection (`detectHomonymWorks`, pure, offline, no clock). A project / track is suspect when
 *   - its credit looks like a MusicBrainz one (the work or a credit edge carries an mbid), and
 *   - no credited artist is named in the work's own prose (`editorial_article`, `editorial_pitch`,
 *     `editorial_teaser`), under any name the cache knows for it (credit, node name, aliases, "&" / "and",
 *     a leading "The"), and
 *   - an artist that is NOT a credited one is: it lists the work in `discography` / `notable_tracks` (through
 *     one hop of the redirect tables, the way a read resolves it, or by listing the SAME title scoped on
 *     itself: `project:human-after-all--daft-punk`, the right slug of the work) or is one of its `producers`,
 *     AND its name (4 letters or more, not the work's own title) is named in that prose. A band and its
 *     members that are all candidates count as the band.
 * Left alone, with the reason counted: a credit named in the prose; a credited artist who also produced the
 * work (Giorgio Moroder on a Donna Summer track); an article artist that is a RELATIVE of a credited one
 * (members / aliases / group, either direction: Kraftwerk and Ralf Hutter, Boards of Canada and Marcus Eoin)
 * or whose prose and the credited artist's name each other (the cache often lacks the members edge); a work
 * with no prose, a credit in a script the comparison cannot read, "Various Artists". Safety before rate: a
 * work the heuristic cannot judge is not touched.
 *
 * Fix. For each suspect, every artist its prose names is tried (one confirmed = the answer, several = left alone
 * and listed):
 *   1. look the work up again under A (the resolvers of src/musicbrainz.ts, which require the credit to equal
 *      A; no second search on the title alone), with the release type and the year of A's own list entry as
 *      hints (the node's are the wrong identity's);
 *   2. the credit must confirm A (by mbid when A has one), the year must agree with A's entry, and the credit
 *      must map onto cache artists. No artist confirmed: the identity is WRONG and has no replacement, and it
 *      is `stripped` only when ONE article artist both lists the work and is among its producers (the two
 *      prod cases); with less evidence the work is reported (`skipped`) and left as it is;
 *   3. success: everything the wrong identity gave the node is removed (mbid, credit, year, release type, a CAA
 *      cover, a label / project / tracklist that carries an MB id), and TRA-474's own write (`planWrite`)
 *      puts the right identity back: mbid, credit, year, release type, tracklist / project / label from MB.
 *      The editorial prose, genres, producers, personnel and every edge without an mbid are untouched;
 *   4. the slug moves from the wrong scope to `makeScopedSlug(title, first credit)` (canonical form), only when
 *      the old slug WAS scoped on a wrong credit (a bare slug stays): the old slug goes to
 *      data/slug-redirects.json, every incoming edge follows, except the ones that existed only because of the
 *      wrong identity (the wrong artist's discography entry, the tracks of the wrong release): those are
 *      dropped. Edges that collide on the new slug are folded (an artist that already lists both slugs ends
 *      with one entry). A node already at the new slug is MERGED with the fixed one (same mbid or none, same
 *      first credit, else a listed conflict and nothing is written for that work).
 * Failure path (no replacement): the wrong mbid, credit and derived fields are removed and the incoming edges
 * of the wrong credit are dropped; the node keeps its slug and is listed in `stripped` for a human.
 *
 * Writes go through atomicWriteJson after nodePayloadSchema validation (never NodeCache.write, which would emit
 * reverse edges). One invalid node = exit 1 and NOTHING is written. MusicBrainz unavailable = `failed`, exit 1,
 * nothing written, safe to re-run. Order of writes (crash safe, as the scope migration): new nodes, redirect
 * table, changed nodes, pending-reverses, removal of the old files. Idempotent: a repaired work is no longer
 * suspect. ORDER: after the identity and scope migrations (2026-10-15 .. 16); independent of the 2026-10-17+
 * ones.
 *
 * Manifest: deterministic (sorted, no timestamp), the same in a dry-run and an apply. It carries the channel's
 * constants (`migration`, `removed`, `renamed`, `redirects`): `renamed` = old slug -> new slug, and every pair of
 * `renamed` / `redirects` must be committed in data/slug-redirects.json before the channel will ship it (the
 * repo run writes that table; for the prod run, commit the pairs the preview lists as MISSING first).
 *
 * Usage: tsx scripts/migrations/2026-10-20-fix-homonym-work-identity.ts <cache-dir> [--apply]
 *        [--manifest out/fix-homonym-work-identity.json] [--data-dir <dir>]
 */
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { parseSlugRedirects } from "../../src/genre-registry.js";
import {
	fetchProjectMetaDetailedMb,
	fetchTrackMetaDetailedMb,
	type MbReleaseIdentity,
	resolveRecordingDetailed,
	resolveReleaseGroupDetailed,
} from "../../src/musicbrainz.js";
import { LIST_EDGES_BY_TYPE, SINGULAR_EDGES_BY_TYPE } from "../../src/node-spec.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { parseSlug, pickScopeArtistName } from "../../src/slug.js";
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
import {
	type Context,
	creditConfirmsHint,
	mapCredit,
	planWrite,
	type ResolvedWork,
	yearsAgree,
} from "./2026-10-15-backfill-release-identity.js";
import { elect, mergeNodes, rewriteEdges } from "./2026-10-16-scope-release-slugs.js";
import {
	canonicalScopedSlug,
	indexRelations,
	MIN_NAMED_LENGTH,
	normalizeForPhrase,
	type RelationIndex,
	relativesOf,
	sameArtist,
	scopedOn,
	withoutNames,
} from "./2026-10-18-rescope-misdirected-artist-edges.js";

export const MIGRATION_NAME = "2026-10-20-fix-homonym-work-identity";
export const DEFAULT_MANIFEST_PATH = "out/fix-homonym-work-identity.json";

type Obj = Record<string, unknown>;
type WorkType = "project" | "track";

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value : undefined;
const edgesOf = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const compareLex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const typeOfSlug = (slug: string): string => slug.slice(0, slug.indexOf(":"));
const isWorkSlug = (slug: string): boolean => typeOfSlug(slug) === "project" || typeOfSlug(slug) === "track";
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validMbid = (value: unknown): string | undefined =>
	typeof value === "string" && MBID_RE.test(value) ? value : undefined;

// --- Detection (pure) ---

export interface Credit {
	slug: string;
	name: string;
	mbid?: string | undefined;
}

export interface ArticleArtist {
	slug: string;
	name: string;
	mbid?: string | undefined;
	/** `lists`: the artist lists the work; `producer`: the work lists the artist among its producers. */
	evidence: ("lists" | "producer")[];
	/** The artist's own entry for the work (release type and year are hints for the new lookup). */
	entry?: { releaseType?: string; year?: string } | undefined;
}

export interface Suspect {
	slug: string;
	type: WorkType;
	name: string;
	credited: Credit[];
	articleArtists: ArticleArtist[];
}

export const KEPT_REASONS = [
	"no-credit",
	"no-musicbrainz-credit",
	"no-text",
	"unjudgeable-credit",
	"credit-named",
	"credit-produces",
	"no-candidate",
] as const;
export type KeptReason = (typeof KEPT_REASONS)[number];

export interface Exempted {
	work: string;
	artist: string;
	reason: "relative" | "mutual-naming";
}

export interface Detection {
	suspects: Suspect[];
	/** Works that were not flagged, by reason. A work counts once, under the first reason that kept it. */
	kept: Record<KeptReason, number>;
	/** Article artists that were left out because they are related to a credited artist. */
	exempted: Exempted[];
}

export interface NodeIndex {
	/** Every node of the cache by slug, as the files hold it. */
	nodes: ReadonlyMap<string, Obj>;
	artists: ReadonlyMap<string, Obj>;
	relations: RelationIndex;
	/** Work slug (after one hop of the redirect tables) -> the artists whose lists name it. */
	listers: ReadonlyMap<string, readonly { artist: string; edge: Obj }[]>;
	/**
	 * `type:<title body>` -> the artists that list a work of that title SCOPED ON THEMSELVES
	 * (`project:human-after-all--daft-punk`): the right slug of the work, whose node may not exist yet.
	 */
	siblings: ReadonlyMap<string, readonly { artist: string; edge: Obj }[]>;
}

/** `type:<title body>` of a work slug, without its scope. */
const titleKey = (slug: string): string =>
	`${typeOfSlug(slug)}:${slug.slice(slug.indexOf(":") + 1).split("--")[0]}`;

export function buildIndex(
	nodes: ReadonlyMap<string, Obj>,
	redirects: ReadonlyMap<string, string>,
): NodeIndex {
	const artists = new Map<string, Obj>();
	for (const [slug, node] of nodes) if (typeOfSlug(slug) === "artist") artists.set(slug, node);
	const listers = new Map<string, { artist: string; edge: Obj }[]>();
	const siblings = new Map<string, { artist: string; edge: Obj }[]>();
	for (const [artist, node] of [...artists].sort(([a], [b]) => compareLex(a, b))) {
		for (const field of ["discography", "notable_tracks"] as const) {
			for (const edge of edgesOf(node[field])) {
				const slug = str(edge.slug);
				if (slug === undefined) continue;
				// A live node wins over a redirect, as in resolveReadSlug.
				const target = nodes.has(slug) ? slug : (redirects.get(slug) ?? slug);
				listers.set(target, [...(listers.get(target) ?? []), { artist, edge }]);
				if (isWorkSlug(slug) && scopedOn(slug, artist, str(node.name) ?? artist)) {
					const key = titleKey(slug);
					siblings.set(key, [...(siblings.get(key) ?? []), { artist, edge }]);
				}
			}
		}
	}
	return { nodes, artists, relations: indexRelations(artists), listers, siblings };
}

const PLACEHOLDER_CREDIT = /^(various artists|unknown|anonymous|traditional|no artist)$/;

/**
 * The normalized spellings a name can have in a text: without a trailing "(band)" / "[...]", "&" read as
 * punctuation or as "and", with or without a leading "The" (`dropLeadingThe`: the name stripped of it is a
 * common word more often than not, so the exemptions below do not use it). Empty when nothing can match.
 */
export function nameForms(name: string, dropLeadingThe = true): string[] {
	const stripped = name.replace(/\s*[([][^)\]]*[)\]]\s*$/u, "").trim();
	const base = stripped === "" ? name : stripped;
	const forms = new Set<string>();
	for (const variant of [base, base.replace(/&/g, " and ")]) {
		const form = normalizeForPhrase(variant);
		if (form === "") continue;
		forms.add(form);
		if (dropLeadingThe && form.startsWith("the ")) forms.add(form.slice(4));
	}
	return [...forms].filter((f) => f !== "").sort();
}

const named = (text: string, forms: readonly string[], minLength: number): boolean =>
	forms.some((form) => form.length >= minLength && ` ${text} `.includes(` ${form} `));

const WORK_PROSE = ["editorial_article", "editorial_pitch", "editorial_teaser"] as const;
const ARTIST_PROSE = ["editorial_article", "editorial_bio"] as const;
const proseOf = (node: Obj, fields: readonly string[]): string =>
	normalizeForPhrase(fields.map((f) => str(node[f]) ?? "").join(" . "));

function creditsOf(node: Obj): Credit[] {
	return edgesOf(node.artists).flatMap((e) => {
		const slug = str(e.slug);
		return slug === undefined || typeOfSlug(slug) !== "artist"
			? []
			: [{ slug, name: str(e.name) ?? slug, mbid: validMbid(e.mbid) }];
	});
}

/** Every spelling the cache has for a credited artist: the edge's name, the node's, its aliases'. */
function creditForms(credit: Credit, index: NodeIndex, dropLeadingThe = true): string[] {
	const node = index.artists.get(credit.slug);
	const names = [credit.name, str(node?.name), ...edgesOf(node?.aliases).map((a) => str(a.name))];
	return [...new Set(names.flatMap((n) => (n === undefined ? [] : nameForms(n, dropLeadingThe))))];
}

export function detectHomonymWorks(index: NodeIndex): Detection {
	const kept = Object.fromEntries(KEPT_REASONS.map((r) => [r, 0])) as Record<KeptReason, number>;
	const suspects: Suspect[] = [];
	const exempted: Exempted[] = [];

	for (const [slug, node] of [...index.nodes].sort(([a], [b]) => compareLex(a, b))) {
		if (!isWorkSlug(slug)) continue;
		const type = typeOfSlug(slug) as WorkType;
		const credits = creditsOf(node);
		const keep = (reason: KeptReason): void => {
			kept[reason]++;
		};
		if (credits.length === 0) {
			keep("no-credit");
			continue;
		}
		// An LLM-written credit has no mbid: only the identity backfill can have chosen a homonym.
		if (validMbid(node.mbid) === undefined && !credits.some((c) => c.mbid !== undefined)) {
			keep("no-musicbrainz-credit");
			continue;
		}
		const text = proseOf(node, WORK_PROSE);
		if (text === "") {
			keep("no-text");
			continue;
		}
		const forms = credits.map((c) => creditForms(c, index));
		if (forms.some((f) => f.length === 0 || f.every((x) => PLACEHOLDER_CREDIT.test(x) || x.length < 2))) {
			keep("unjudgeable-credit");
			continue;
		}
		if (forms.some((f) => named(text, f, 2))) {
			keep("credit-named");
			continue;
		}
		const producers = edgesOf(node.producers).flatMap((e) => str(e.slug) ?? []);
		if (credits.some((c) => producers.includes(c.slug))) {
			keep("credit-produces");
			continue;
		}

		// The artists that could be the one the prose is about.
		const title = str(node.name) ?? "";
		const textWithoutTitle = withoutNames(text, [title]);
		const candidates = new Map<string, ArticleArtist>();
		const consider = (artistSlug: string, evidence: "lists" | "producer", edge: Obj): void => {
			const artistNode = index.artists.get(artistSlug);
			const name = str(artistNode?.name) ?? str(edge.name) ?? artistSlug;
			const mbid = validMbid(artistNode?.mbid) ?? validMbid(edge.mbid);
			const previous = candidates.get(artistSlug);
			if (previous) {
				if (!previous.evidence.includes(evidence)) previous.evidence.push(evidence);
				if (evidence === "lists" && previous.entry === undefined) {
					previous.entry = entryHints(edge);
				}
				return;
			}
			const entry = evidence === "lists" ? entryHints(edge) : undefined;
			candidates.set(artistSlug, {
				slug: artistSlug,
				name,
				mbid,
				evidence: [evidence],
				...(entry ? { entry } : {}),
			});
		};
		for (const { artist, edge } of index.listers.get(slug) ?? []) consider(artist, "lists", edge);
		for (const { artist, edge } of index.siblings.get(titleKey(slug)) ?? []) consider(artist, "lists", edge);
		for (const edge of edgesOf(node.producers)) {
			const producer = str(edge.slug);
			if (producer !== undefined && typeOfSlug(producer) === "artist") consider(producer, "producer", edge);
		}
		const titleForm = normalizeForPhrase(title);
		const remaining: ArticleArtist[] = [];
		for (const candidate of [...candidates.values()].sort((a, b) => compareLex(a.slug, b.slug))) {
			if (credits.some((c) => sameArtist({ slug: c.slug, mbid: c.mbid }, candidate))) continue;
			const candidateForms = nameForms(candidate.name);
			if (candidateForms.includes(titleForm) || !named(textWithoutTitle, candidateForms, MIN_NAMED_LENGTH))
				continue;
			const reason = exemption(candidate, credits, index);
			if (reason !== null) {
				exempted.push({ work: slug, artist: candidate.slug, reason });
				continue;
			}
			remaining.push(candidate);
		}
		if (remaining.length === 0) {
			keep("no-candidate");
			continue;
		}
		// A band and its members are one answer: the members give way to the band that is also a candidate
		// (Daft Punk, not Thomas Bangalter and Guy-Manuel de Homem-Christo).
		const isMemberOf = (x: ArticleArtist, group: ArticleArtist): boolean =>
			relativesOf(index.artists.get(group.slug) ?? {}, group.slug, index.artists, index.relations).some(
				(r) => r.relation === "member" && sameArtist({ slug: x.slug, mbid: x.mbid }, r),
			) ||
			relativesOf(index.artists.get(x.slug) ?? {}, x.slug, index.artists, index.relations).some(
				(r) => r.relation === "group" && sameArtist({ slug: group.slug, mbid: group.mbid }, r),
			);
		const collapsed = remaining.filter((x) => !remaining.some((y) => y !== x && isMemberOf(x, y)));
		suspects.push({
			slug,
			type,
			name: title,
			credited: credits.map(({ slug: s, name, mbid }) => ({ slug: s, name, mbid })),
			articleArtists: collapsed,
		});
	}
	return { suspects, kept, exempted };
}

function entryHints(edge: Obj): { releaseType?: string; year?: string } | undefined {
	const releaseType = str(edge.releaseType)?.toLowerCase();
	const year = str(edge.year);
	if (releaseType === undefined && year === undefined) return undefined;
	return {
		...(releaseType === undefined ? {} : { releaseType }),
		...(year === undefined ? {} : { year }),
	};
}

/**
 * Why an artist the prose names is NOT a homonym's replacement for a credit: it is a relative of a credited
 * artist (members / aliases / group, either way), or its prose and the credited artist's name each other.
 */
function exemption(
	candidate: ArticleArtist,
	credits: readonly Credit[],
	index: NodeIndex,
): Exempted["reason"] | null {
	const candidateNode = index.artists.get(candidate.slug) ?? {};
	const candidateProse = proseOf(candidateNode, ARTIST_PROSE);
	const candidateForms = nameForms(candidate.name, false);
	for (const credit of credits) {
		const creditNode = index.artists.get(credit.slug) ?? {};
		const creditMbid = validMbid(creditNode.mbid) ?? credit.mbid;
		const target = { slug: candidate.slug, mbid: candidate.mbid };
		const mine = relativesOf(
			{ ...creditNode, mbid: creditMbid },
			credit.slug,
			index.artists,
			index.relations,
		);
		if (mine.some((r) => sameArtist(target, r))) return "relative";
		const theirs = relativesOf(
			{ ...candidateNode, mbid: candidate.mbid },
			candidate.slug,
			index.artists,
			index.relations,
		);
		if (theirs.some((r) => sameArtist({ slug: credit.slug, mbid: creditMbid }, r))) return "relative";
		if (
			named(proseOf(creditNode, ARTIST_PROSE), candidateForms, MIN_NAMED_LENGTH) ||
			named(candidateProse, creditForms(credit, index, false), MIN_NAMED_LENGTH)
		) {
			return "mutual-naming";
		}
	}
	return null;
}

// --- What the wrong identity gave a node ---

/**
 * The node without what an identity chosen on the title gave it: `mbid`, the credit, `year`, `release_type`, a
 * Cover Art Archive cover (keyed on the wrong release group), and the label / project / tracklist that carry an
 * MB id (the edges TRA-474 wrote; the ones the LLM wrote have none and stay). Prose, genres, producers,
 * personnel and every other edge are the node's own and are kept.
 */
export function withoutWrongIdentity(node: Obj): Obj {
	const next: Obj = { ...node };
	delete next.mbid;
	delete next.year;
	delete next.release_type;
	next.artists = [];
	if (next.image_source === "caa") {
		delete next.image_url;
		delete next.image_source;
	}
	for (const field of ["label", "project"] as const) {
		const value = next[field];
		if (isRecord(value) && str(value.mbid) !== undefined) delete next[field];
	}
	const tracklist = edgesOf(next.tracklist);
	if (tracklist.length > 0 && tracklist.every((t) => str(t.mbid) !== undefined)) next.tracklist = [];
	return next;
}

// --- MusicBrainz ---

/**
 * The resolver's answer for `name` under the article's artist. The artist's own MBID lets the resolver count a
 * work printed under another name as direct, and the release type known from its own list entry tells a single
 * from the album of the same name (TRA-552, TRA-560). Unlike the identity backfill there is NO second search on
 * the title alone: it would find the very homonym this repairs (the node's own release), and "nothing credited
 * to the article's artist" is exactly the answer that decides between a fix and a strip.
 */
async function lookUp(
	type: WorkType,
	name: string,
	hint: { name: string; mbid?: string | undefined },
	releaseType: string | undefined,
): Promise<{ found: MbReleaseIdentity | null; ambiguous: boolean; unavailable: boolean }> {
	const resolve = type === "project" ? resolveReleaseGroupDetailed : resolveRecordingDetailed;
	// A known type also asks for the plain release over its compilations, lives and remixes (TRA-604).
	const typed =
		type === "project" && releaseType !== undefined ? { releaseType, preferPlainRelease: true } : {};
	const answer = await resolve(name, hint.name, {
		...(hint.mbid === undefined ? {} : { requestedArtistMbid: hint.mbid }),
		...typed,
	});
	return { found: answer.identity, ambiguous: answer.ambiguous, unavailable: answer.unavailable };
}

/**
 * The release type a project's own prose states: "album", "single" or "EP" when exactly one of them is named in
 * its pitch and the opening of its article ("Pink Floyd's ninth studio album"). The node's own `release_type` is
 * the wrong identity's, and the artist's list entry often has none.
 */
export function releaseTypeFromProse(node: Obj): (typeof RELEASE_TYPES)[number] | undefined {
	const text = normalizeForPhrase(
		`${str(node.editorial_pitch) ?? ""} . ${(str(node.editorial_article) ?? "").slice(0, 300)}`,
	);
	const named = RELEASE_TYPES.filter((t) => ` ${text} `.includes(` ${t} `));
	return named.length === 1 ? named[0] : undefined;
}

function yearOf(date: string | null): string | null {
	return date !== null && /^\d{4}/.test(date) ? date.slice(0, 4) : null;
}

const RELEASE_TYPES = ["album", "ep", "single"] as const;

/** The cache as the identity code reads it: artists and labels by slug and by mbid. */
function buildContext(files: readonly CacheNodeFile[]): Context {
	const ctx: Context = {
		artists: new Map(),
		artistSlugsByMbid: new Map(),
		labels: new Map(),
		labelSlugsByMbid: new Map(),
		pointers: new Map(),
		storedWorkMbids: new Map(),
		groupsByMbid: new Map(),
	};
	for (const { slug, type, node } of files) {
		if (type !== "artist" && type !== "label") continue;
		const name = str(node.name) ?? slug;
		const mbid = validMbid(node.mbid);
		const info = mbid ? { name, mbid } : { name };
		const [by, bySlug] =
			type === "artist" ? [ctx.artistSlugsByMbid, ctx.artists] : [ctx.labelSlugsByMbid, ctx.labels];
		bySlug.set(slug, info);
		if (mbid) by.set(mbid, [...(by.get(mbid) ?? []), slug]);
	}
	return ctx;
}

// --- Report shapes ---

export interface Fixed {
	slug: string;
	/** The slug after the fix (the same one when the old slug did not carry the wrong scope). */
	to: string;
	artist: string;
	mbid: { from: string | null; to: string };
	credit: { from: string[]; to: string[] };
	/** The node already at `to` was merged with the fixed one. */
	merged: boolean;
	/** Incoming edges that existed only because of the wrong identity, dropped. */
	droppedEdges: number;
}
export interface Stripped {
	slug: string;
	artist: string;
	reason:
		| "no-match"
		| "ambiguous-candidates"
		| "credit-mismatch"
		| "year-mismatch"
		| "unmappable-credit"
		| "invalid-new-node";
	droppedEdges: number;
}
export interface Skipped {
	slug: string;
	reason: "several-article-artists" | "already-consistent" | "no-replacement-weak-evidence";
	artists: string[];
}
export interface Conflict {
	slug: string;
	to: string;
	reason:
		| "no-scoped-slug"
		| "target-is-a-redirect-key"
		| "target-claimed-twice"
		| "target-other-identity"
		| "target-unreadable";
}

export interface FixManifest {
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	summary: {
		works: number;
		suspects: number;
		fixed: number;
		stripped: number;
		skipped: number;
		conflicts: number;
		exempted: number;
		failed: number;
	};
	kept: Record<KeptReason, number>;
	fixed: Fixed[];
	stripped: Stripped[];
	skipped: Skipped[];
	conflicts: Conflict[];
	/** Article artists left out because they are related to a credited one (kept for the audit). */
	exempted: Exempted[];
	failed: { slug: string; reason: string }[];
}

// --- Plan ---

interface FixPlan {
	oldSlug: string;
	newSlug: string;
	type: WorkType;
	node: Obj;
	/** Slugs whose edge to the old slug existed only because of the wrong identity. */
	dropFrom: Set<string>;
	report: Fixed;
}
interface StripPlan {
	slug: string;
	type: WorkType;
	node: Obj;
	dropFrom: Set<string>;
	report: Stripped;
}

const slugsOf = (value: unknown): string[] => edgesOf(value).flatMap((e) => str(e.slug) ?? []);
const singleSlug = (value: unknown): string[] => {
	const slug = isRecord(value) ? str(value.slug) : undefined;
	return slug === undefined ? [] : [slug];
};

/** The neighbours the old node had only through the wrong identity: they must not keep an edge to it. */
function wrongNeighbours(oldNode: Obj, newNode: Obj): Set<string> {
	const keptSlugs = new Set([
		...slugsOf(newNode.artists),
		...slugsOf(newNode.tracklist),
		...singleSlug(newNode.project),
		...singleSlug(newNode.label),
	]);
	return new Set(
		[
			...slugsOf(oldNode.artists),
			...(edgesOf(oldNode.tracklist).every((t) => str(t.mbid) !== undefined)
				? slugsOf(oldNode.tracklist)
				: []),
			...(isRecord(oldNode.project) && str(oldNode.project.mbid) ? singleSlug(oldNode.project) : []),
			...(isRecord(oldNode.label) && str(oldNode.label.mbid) ? singleSlug(oldNode.label) : []),
		].filter((slug) => !keptSlugs.has(slug)),
	);
}

function removeEdgesTo(node: Obj, type: keyof typeof LIST_EDGES_BY_TYPE, targets: ReadonlySet<string>): Obj {
	const next: Obj = { ...node };
	for (const field of LIST_EDGES_BY_TYPE[type]) {
		if (!Array.isArray(node[field])) continue;
		next[field] = (node[field] as unknown[]).filter((e) => !(isRecord(e) && targets.has(str(e.slug) ?? "")));
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[type]) {
		const value = node[field];
		if (isRecord(value) && targets.has(str(value.slug) ?? "")) delete next[field];
	}
	return next;
}

export interface FixOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	/** Where the redirect tables are read and the slug table written (the channel's scratch copy). */
	dataDir?: string | undefined;
	log?: (line: string) => void;
}

export interface FixResult {
	manifest: FixManifest;
	written: string[];
	exitCode: number;
}

async function readTables(dataDir: string | undefined): Promise<{
	slugPath: string;
	slugRaw: Obj;
	slug: Record<string, string>;
	all: ReadonlyMap<string, string>;
}> {
	const dir = dataDir ?? defaultDataDir();
	const slugPath = join(dir, "slug-redirects.json");
	// An explicit directory without its slug table is a refusal, never a guess (as the TRA-602 migration).
	if (dataDir !== undefined) {
		try {
			await stat(slugPath);
		} catch {
			throw new Error(`redirect table not found: ${slugPath}`);
		}
	}
	const genreText = await readTextOrDefault(join(dir, "genre-redirects.json"), '{"redirects":{}}');
	const slugRaw = JSON.parse(await readTextOrDefault(slugPath, '{"redirects":{}}')) as unknown;
	const genre = parseSlugRedirects(JSON.parse(genreText) as unknown);
	const slug = parseSlugRedirects(slugRaw);
	const all = new Map<string, string>(genre);
	for (const [from, to] of slug) {
		if (all.has(from)) throw new Error(`redirect key "${from}" is in both tables`);
		all.set(from, to);
	}
	return { slugPath, slugRaw: isRecord(slugRaw) ? slugRaw : {}, slug: Object.fromEntries(slug), all };
}

export async function runFix(options: FixOptions): Promise<FixResult> {
	const { cacheDir, apply, manifestPath } = options;
	const log = options.log ?? (() => undefined);
	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	const tables = await readTables(options.dataDir);
	const files = new Map(nodes.map((f) => [f.slug, f]));
	const index = buildIndex(new Map(nodes.map((f) => [f.slug, f.node])), tables.all);
	const detection = detectHomonymWorks(index);
	const ctx = buildContext(nodes);
	log(`${detection.suspects.length} suspect work(s) among ${nodes.filter((n) => isWorkSlug(n.slug)).length}`);

	const failed: FixManifest["failed"] = invalid
		.filter((entry) => /[/\\](project|track)[/\\]/.test(entry.path))
		.map((entry) => ({ slug: entry.path, reason: `unreadable node file: ${entry.error}` }));
	const stripped: StripPlan[] = [];
	const fixes: FixPlan[] = [];
	const skipped: Skipped[] = [];
	const conflicts: Conflict[] = [];

	for (const suspect of detection.suspects) {
		const file = files.get(suspect.slug);
		if (!file) continue;
		// Every artist the prose names is tried: exactly one that MusicBrainz confirms settles it.
		const currentMbids = new Set(suspect.credited.flatMap((c) => c.mbid ?? []));
		const rejected: Stripped["reason"][] = [];
		const confirmed: {
			artist: ArticleArtist;
			found: MbReleaseIdentity;
			year: string | null;
			mapped: Extract<ReturnType<typeof mapCredit>, { ok: true }>;
		}[] = [];
		let unavailable = false;
		let consistent = false;
		for (const artist of suspect.articleArtists) {
			const releaseType =
				RELEASE_TYPES.find((t) => t === artist.entry?.releaseType) ??
				(suspect.type === "project" ? releaseTypeFromProse(file.node) : undefined);
			const lookedUp = await lookUp(suspect.type, suspect.name, artist, releaseType);
			if (lookedUp.unavailable) {
				unavailable = true;
				break;
			}
			const found = lookedUp.found;
			if (!found) {
				rejected.push(lookedUp.ambiguous ? "ambiguous-candidates" : "no-match");
				continue;
			}
			// The very identity the node carries, or a credit that already holds one of its artists: not a homonym.
			if (found.mbid === str(file.node.mbid) || found.credit.some((c) => currentMbids.has(c.mbid))) {
				consistent = true;
				break;
			}
			const hint = { name: artist.name, ...(artist.mbid === undefined ? {} : { mbid: artist.mbid }) };
			const year = yearOf(found.firstReleaseDate);
			const mapped = mapCredit(found.credit, ctx);
			if (!creditConfirmsHint(found.credit, hint)) rejected.push("credit-mismatch");
			else if (!yearsAgree(artist.entry?.year, year)) rejected.push("year-mismatch");
			else if (!mapped.ok) rejected.push("unmappable-credit");
			else confirmed.push({ artist, found, year, mapped });
		}
		if (unavailable) {
			failed.push({ slug: suspect.slug, reason: "MusicBrainz search unavailable" });
			continue;
		}
		if (consistent) {
			skipped.push({
				slug: suspect.slug,
				reason: "already-consistent",
				artists: suspect.articleArtists.map((a) => a.slug),
			});
			continue;
		}
		if (confirmed.length > 1) {
			skipped.push({
				slug: suspect.slug,
				reason: "several-article-artists",
				artists: confirmed.map((c) => c.artist.slug),
			});
			continue;
		}
		const [chosen] = confirmed;
		if (chosen === undefined) {
			// No replacement. Removing a credit is destructive: it needs ONE article artist with both links to
			// the work (it lists the work AND the work lists it as a producer, as in both prod cases).
			const [only] = suspect.articleArtists;
			if (
				suspect.articleArtists.length !== 1 ||
				only === undefined ||
				!(only.evidence.includes("lists") && only.evidence.includes("producer"))
			) {
				skipped.push({
					slug: suspect.slug,
					reason: "no-replacement-weak-evidence",
					artists: suspect.articleArtists.map((a) => a.slug),
				});
				continue;
			}
			const node = withoutWrongIdentity(file.node);
			stripped.push({
				slug: suspect.slug,
				type: suspect.type,
				node,
				dropFrom: wrongNeighbours(file.node, node),
				report: {
					slug: suspect.slug,
					artist: only.slug,
					reason: rejected[0] ?? "no-match",
					droppedEdges: 0,
				},
			});
			continue;
		}
		const { artist: only, found, year, mapped } = chosen;
		const fetched =
			suspect.type === "project"
				? await fetchProjectMetaDetailedMb(found.mbid)
				: await fetchTrackMetaDetailedMb(found.mbid);
		if (fetched.unavailable) {
			failed.push({ slug: suspect.slug, reason: `MusicBrainz lookup failed for ${found.mbid}` });
			continue;
		}
		const work: ResolvedWork = {
			mbid: found.mbid,
			credit: [...found.credit],
			title: found.title,
			hint: only.name,
			year,
			release_type: RELEASE_TYPES.find((t) => t === found.primaryType?.toLowerCase()) ?? null,
		};
		const plan = planWrite(
			suspect.type,
			withoutWrongIdentity(file.node),
			work,
			mapped.edges,
			ctx,
			fetched.meta,
		);
		const first = edgesOf(plan.next.artists)[0];
		const scope = pickScopeArtistName([str(first?.name), ...found.credit.map((c) => c.name)]);

		// The slug moves only when it carries the wrong scope: a bare slug names no homonym.
		const wrongScope = suspect.credited.some((c) => scopedOn(suspect.slug, c.slug, c.name));
		let newSlug = suspect.slug;
		if (wrongScope) {
			const derived = scope === null ? null : canonicalScopedSlug(suspect.type, suspect.name, scope);
			if (derived === null) {
				conflicts.push({ slug: suspect.slug, to: "", reason: "no-scoped-slug" });
				continue;
			}
			newSlug = derived;
		}
		const next: Obj = { ...plan.next, slug: newSlug };
		fixes.push({
			oldSlug: suspect.slug,
			newSlug,
			type: suspect.type,
			node: next,
			dropFrom: wrongNeighbours(file.node, next),
			report: {
				slug: suspect.slug,
				to: newSlug,
				artist: only.slug,
				mbid: { from: str(file.node.mbid) ?? null, to: found.mbid },
				credit: { from: suspect.credited.map((c) => c.slug), to: slugsOf(next.artists) },
				merged: false,
				droppedEdges: 0,
			},
		});
	}

	// --- Collisions on the target slug, decided before anything is rewritten ---
	const plans: FixPlan[] = [];
	const claimed = new Map<string, FixPlan[]>();
	for (const fix of fixes) claimed.set(fix.newSlug, [...(claimed.get(fix.newSlug) ?? []), fix]);
	for (const fix of fixes) {
		const conflict = (reason: Conflict["reason"]): void => {
			conflicts.push({ slug: fix.oldSlug, to: fix.newSlug, reason });
		};
		if (fix.newSlug === fix.oldSlug) {
			plans.push(fix);
			continue;
		}
		if ((claimed.get(fix.newSlug) ?? []).length > 1) {
			conflict("target-claimed-twice");
			continue;
		}
		if (tables.all.has(fix.newSlug)) {
			conflict("target-is-a-redirect-key");
			continue;
		}
		const existing = files.get(fix.newSlug);
		if (existing) {
			const sameMbid =
				str(existing.node.mbid) === undefined || str(existing.node.mbid) === str(fix.node.mbid);
			const theirFirst = edgesOf(existing.node.artists)[0];
			const ourFirst = edgesOf(fix.node.artists)[0];
			const sameCredit =
				theirFirst === undefined ||
				(ourFirst !== undefined &&
					sameArtist(
						{ slug: str(theirFirst.slug), mbid: validMbid(theirFirst.mbid) },
						{
							slug: str(ourFirst.slug) ?? "",
							name: "",
							mbid: validMbid(ourFirst.mbid),
						},
					));
			if (!sameMbid || !sameCredit) {
				conflict("target-other-identity");
				continue;
			}
		}
		plans.push(fix);
	}

	// --- Rewrite the cache in memory ---
	const moves: Record<string, string> = {};
	for (const fix of plans) if (fix.newSlug !== fix.oldSlug) moves[fix.oldSlug] = fix.newSlug;
	const wrongTo = new Map<string, string[]>(); // neighbour slug -> old work slugs it must stop pointing at
	for (const plan of [...plans, ...stripped]) {
		const old = "oldSlug" in plan ? plan.oldSlug : plan.slug;
		for (const neighbour of plan.dropFrom) wrongTo.set(neighbour, [...(wrongTo.get(neighbour) ?? []), old]);
	}
	const planned = new Map<string, Obj>(); // slug -> changed node to write
	const renamedNodes = new Map<string, Obj>(); // new slug -> the fixed node of a rename
	const planBySlug = new Map<string, FixPlan | StripPlan>();
	for (const plan of plans) planBySlug.set(plan.oldSlug, plan);
	for (const plan of stripped) planBySlug.set(plan.slug, plan);
	const droppedBy = new Map<string, number>();
	for (const file of nodes) {
		const own = planBySlug.get(file.slug);
		let next: Obj = own ? own.node : file.node;
		const drop = new Set(wrongTo.get(file.slug) ?? []);
		if (drop.size > 0) {
			const before = JSON.stringify(next);
			next = removeEdgesTo(next, file.type, drop);
			if (JSON.stringify(next) !== before) {
				for (const old of drop) droppedBy.set(old, (droppedBy.get(old) ?? 0) + 1);
			}
		}
		if (Object.keys(moves).length > 0) {
			next = rewriteEdges(next, file.type, moves, own && "oldSlug" in own ? own.newSlug : file.slug).node;
		}
		if (own && "oldSlug" in own && own.newSlug !== own.oldSlug) renamedNodes.set(own.newSlug, next);
		else if (JSON.stringify(next) !== JSON.stringify(file.node)) planned.set(file.slug, next);
	}

	// --- A node already at the new slug is merged with the fixed one ---
	const deletions = new Set<string>();
	const fresh = new Set<string>();
	for (const plan of plans) {
		if (plan.newSlug === plan.oldSlug) continue;
		deletions.add(plan.oldSlug);
		const existing = files.get(plan.newSlug);
		const fixedNode = renamedNodes.get(plan.newSlug);
		if (!fixedNode) continue;
		if (!existing) {
			fresh.add(plan.newSlug);
			planned.set(plan.newSlug, fixedNode);
			continue;
		}
		// The node already there, with its own edges rewritten when they were.
		const theirs: CacheNodeFile = { ...existing, node: planned.get(plan.newSlug) ?? existing.node };
		const ours: CacheNodeFile = { ...existing, node: fixedNode };
		const { winner } = elect([ours, theirs], false);
		planned.set(plan.newSlug, mergeNodes(winner, [winner === ours ? theirs : ours], plan.newSlug));
		plan.report.merged = true;
	}

	// --- Redirect table and pending reverses ---
	let mergedRedirects: Record<string, string> = tables.slug;
	try {
		mergedRedirects = mergeRedirects(tables.slug, moves);
	} catch (e) {
		failed.push({ slug: "slug-redirects.json", reason: e instanceof Error ? e.message : String(e) });
	}
	const pendingPath = join(cacheDir, "pending-reverses.json");
	let pending: ReturnType<typeof rewritePendingReverses> = { result: {}, changed: false };
	try {
		const raw = JSON.parse(await readTextOrDefault(pendingPath, "{}")) as Record<string, PendingReverse[]>;
		pending = rewritePendingReverses(raw, new Map(Object.entries(moves)));
	} catch (e) {
		failed.push({ slug: "pending-reverses.json", reason: e instanceof Error ? e.message : String(e) });
	}

	// --- Validate everything that would be written ---
	const toWrite: { slug: string; data: unknown }[] = [];
	for (const [slug, node] of [...planned].sort(([a], [b]) => compareLex(a, b))) {
		const parsed = nodePayloadSchema.safeParse(node);
		if (!parsed.success) {
			failed.push({ slug, reason: `refusing to write an invalid node: ${parsed.error.message}` });
		} else if (!onlyAddsSchemaDefaults(node, parsed.data)) {
			failed.push({ slug, reason: "refusing to write: validation would alter fields the node carries" });
		} else {
			toWrite.push({ slug, data: parsed.data });
		}
	}

	for (const plan of plans) plan.report.droppedEdges = droppedBy.get(plan.oldSlug) ?? 0;
	for (const plan of stripped) plan.report.droppedEdges = droppedBy.get(plan.slug) ?? 0;

	const written: string[] = [];
	const pathOf = (slug: string): string => {
		const { type, body } = parseSlug(slug);
		return join(cacheDir, "nodes", type, `${body}.json`);
	};
	if (apply && failed.length === 0) {
		const write = async (path: string, data: unknown): Promise<void> => {
			await mkdir(dirname(path), { recursive: true });
			await atomicWriteJson(path, data);
			written.push(path);
		};
		for (const { slug, data } of toWrite) if (fresh.has(slug)) await write(pathOf(slug), data);
		if (Object.keys(moves).length > 0) {
			await write(tables.slugPath, {
				...tables.slugRaw,
				generated_at: new Date().toISOString(),
				redirects: mergedRedirects,
			});
		}
		for (const { slug, data } of toWrite) if (!fresh.has(slug)) await write(pathOf(slug), data);
		if (pending.changed) await write(pendingPath, pending.result);
		for (const slug of [...deletions].sort(compareLex)) await rm(pathOf(slug));
	}

	const redirectsChanged = Object.fromEntries(
		Object.entries(mergedRedirects).filter(([from, to]) => tables.slug[from] !== to),
	);
	const sortRecord = (o: Record<string, string>): Record<string, string> =>
		Object.fromEntries(Object.entries(o).sort(([a], [b]) => compareLex(a, b)));
	const bySlug = <T extends { slug: string }>(a: T, b: T): number => compareLex(a.slug, b.slug);
	const manifest: FixManifest = {
		migration: MIGRATION_NAME,
		removed: [],
		renamed: sortRecord(moves),
		redirects: sortRecord(Object.keys(moves).length > 0 ? redirectsChanged : {}),
		summary: {
			works: nodes.filter((n) => isWorkSlug(n.slug)).length,
			suspects: detection.suspects.length,
			fixed: plans.length,
			stripped: stripped.length,
			skipped: skipped.length,
			conflicts: conflicts.length,
			exempted: detection.exempted.length,
			failed: failed.length,
		},
		kept: detection.kept,
		fixed: plans.map((p) => p.report).sort(bySlug),
		stripped: stripped.map((p) => p.report).sort(bySlug),
		skipped: skipped.sort(bySlug),
		conflicts: conflicts.sort((a, b) => compareLex(a.slug, b.slug)),
		exempted: detection.exempted,
		failed: failed.sort(bySlug),
	};
	await mkdir(dirname(manifestPath), { recursive: true });
	await atomicWriteJson(manifestPath, manifest);
	return { manifest, written, exitCode: failed.length > 0 ? 1 : 0 };
}

export function formatSummary(result: FixResult, apply: boolean, manifestPath: string): string {
	const { manifest, written } = result;
	const s = manifest.summary;
	const lines = [
		`${s.works} work(s): ${s.suspects} suspect, ${s.fixed} fixed, ${s.stripped} stripped, ${s.skipped} skipped, ${s.conflicts} conflict(s), ${s.exempted} article artist(s) exempted as relatives, ${s.failed} failed`,
		apply ? `${written.length} file(s) written` : "dry-run: nothing written",
		`manifest: ${manifestPath}`,
	];
	for (const f of manifest.fixed)
		lines.push(`fixed ${f.slug} -> ${f.to} (${f.credit.from.join(",")} -> ${f.credit.to.join(",")})`);
	for (const x of manifest.stripped)
		lines.push(`stripped ${x.slug} (${x.reason}, article artist ${x.artist})`);
	for (const x of manifest.skipped) lines.push(`skipped ${x.slug} (${x.reason}: ${x.artists.join(",")})`);
	for (const x of manifest.conflicts) lines.push(`conflict ${x.slug} -> ${x.to} (${x.reason})`);
	for (const x of manifest.failed) lines.push(`failed ${x.slug}: ${x.reason}`);
	return lines.join("\n");
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	dataDir?: string | undefined;
}

/** `<cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]`; null (exit 2) on anything else. */
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
			"usage: 2026-10-20-fix-homonym-work-identity.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runFix({ ...args, log: (line) => process.stdout.write(`${line}\n`) });
	console.log(formatSummary(result, args.apply, args.manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
