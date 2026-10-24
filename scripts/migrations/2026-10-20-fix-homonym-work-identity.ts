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
 * TRA-610 (the latent defects the review of #535 found; none touched the 13 works of the prod run): a list entry
 * never gives the article artist an mbid (it is the work's); a merge never targets a node that is itself renamed
 * or itself a suspect (`target-is-renamed`, `target-is-suspect`); the index reads a redirect to a slug with no
 * node yet as the live node it comes from, so the preview and the apply (after the pairs were committed) find
 * the same suspects; the redirect keys of a moved work (its bare slug) are re-pointed and dropped like the
 * slug itself, so no label lists the album twice; the reverse edges waiting under a new slug are applied to
 * the node now there (those the runtime does not emit stay queued) and a pending key the cleaning empties is
 * removed; edges that collide with two mbids are kept and listed in `edgeConflicts`; a prose that calls the
 * work a compilation does not ask for the plain studio release.
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
import { dirname, join, relative } from "node:path";
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
import { IMAGE_SOURCES } from "../../src/types.js";
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
import { elect, isSafePendingEntry, mergeNodes, rewriteEdges } from "./2026-10-16-scope-release-slugs.js";
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
	/**
	 * Named in the lead of the prose (pitch, teaser, first 300 characters of the article): the work is ABOUT
	 * this artist. An artist only mentioned further down (the bassist of the band the article is about) is not
	 * one the fix may re-credit the work to.
	 */
	inLead: boolean;
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
	// A live node whose redirect leads to a slug with no node (the pair the preview lists, committed before the
	// apply: `old -> new`, `new` not written yet): what resolves to `new` is still `old`'s. Without it the preview
	// finds the suspect through a bare slug and the apply, one commit later, finds nothing (TRA-610, 2026-10-23).
	const stillThere = new Map<string, string[]>();
	for (const [from, to] of redirects) {
		if (isWorkSlug(from) && nodes.has(from) && !nodes.has(to))
			stillThere.set(to, [...(stillThere.get(to) ?? []), from]);
	}
	for (const [artist, node] of [...artists].sort(([a], [b]) => compareLex(a, b))) {
		for (const field of ["discography", "notable_tracks"] as const) {
			for (const edge of edgesOf(node[field])) {
				const slug = str(edge.slug);
				if (slug === undefined) continue;
				// A live node wins over a redirect, as in resolveReadSlug.
				const target = nodes.has(slug) ? slug : (redirects.get(slug) ?? slug);
				for (const key of [target, ...(nodes.has(slug) ? [] : (stillThere.get(target) ?? []))]) {
					listers.set(key, [...(listers.get(key) ?? []), { artist, edge }]);
				}
				if (isWorkSlug(slug) && scopedOn(slug, artist, str(node.name) ?? artist)) {
					const key = titleKey(slug);
					siblings.set(key, [...(siblings.get(key) ?? []), { artist, edge }]);
				}
			}
		}
	}
	return { nodes, artists, relations: indexRelations(artists), listers, siblings };
}

/** How much of the article counts as its lead. */
const LEAD_LENGTH = 300;

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
		const lead = withoutNames(
			normalizeForPhrase(
				`${str(node.editorial_pitch) ?? ""} . ${str(node.editorial_teaser) ?? ""} . ${(str(node.editorial_article) ?? "").slice(0, LEAD_LENGTH)}`,
			),
			[title],
		);
		const candidates = new Map<string, ArticleArtist>();
		const consider = (artistSlug: string, evidence: "lists" | "producer", edge: Obj): void => {
			const artistNode = index.artists.get(artistSlug);
			const name = str(artistNode?.name) ?? str(edge.name) ?? artistSlug;
			// An artist's list entry carries the WORK's mbid: taken for the artist's, the credit never matched and
			// the work was stripped instead of fixed (TRA-610, 2026-10-23). Only a producer edge names the artist.
			const mbid =
				validMbid(artistNode?.mbid) ?? (evidence === "producer" ? validMbid(edge.mbid) : undefined);
			const previous = candidates.get(artistSlug);
			if (previous) {
				if (!previous.evidence.includes(evidence)) previous.evidence.push(evidence);
				// Seen by its list first: the producer edge still names the artist (TRA-610 review, 2026-10-24).
				if (evidence === "producer") previous.mbid ??= validMbid(edge.mbid);
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
				inLead: false,
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
			remaining.push({ ...candidate, inLead: named(lead, candidateForms, MIN_NAMED_LENGTH) });
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
		const withoutMembers = remaining.filter((x) => !remaining.some((y) => y !== x && isMemberOf(x, y)));
		// Mutual member / group edges in the cache would leave nobody: then every candidate stays.
		const collapsed = withoutMembers.length > 0 ? withoutMembers : remaining;
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
	// The backfill only fills these when absent, so a value the node's own prose states is the node's.
	const prose = proseOf(node, WORK_PROSE);
	const year = str(node.year);
	if (year === undefined || !/^\d{4}$/.test(year) || !` ${prose} `.includes(` ${year} `)) delete next.year;
	const releaseType = str(node.release_type)?.toLowerCase();
	if (releaseType === undefined || releaseTypeFromProse(node) !== releaseType) delete next.release_type;
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
	plainRelease = true,
): Promise<{ found: MbReleaseIdentity | null; ambiguous: boolean; unavailable: boolean }> {
	const resolve = type === "project" ? resolveReleaseGroupDetailed : resolveRecordingDetailed;
	// A known type also asks for the plain release over its compilations, lives and remixes (TRA-604), unless the
	// work's own prose says it IS a compilation: the studio album of the same title is then the wrong answer, and
	// "ambiguous" the honest one (TRA-610, review of #535, 2026-10-23: a compilation read as its studio album).
	const typed =
		type === "project" && releaseType !== undefined
			? { releaseType, ...(plainRelease ? { preferPlainRelease: true } : {}) }
			: {};
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
	const text = `${str(node.editorial_pitch) ?? ""} . ${(str(node.editorial_article) ?? "").slice(0, LEAD_LENGTH)}`;
	// Whole words only: "single-minded" names no single. "EP" is read as written, "ep" is not a word.
	const words = new Set([
		...(text.match(/(?<![\p{L}\p{N}-])(album|single)(?![\p{L}\p{N}-])/giu) ?? []).map((w) => w.toLowerCase()),
		...(text.match(/(?<![\p{L}\p{N}-])EP(?![\p{L}\p{N}-])/gu) ?? []).map(() => "ep"),
	]);
	const [only] = words;
	return words.size === 1 && RELEASE_TYPES.some((t) => t === only)
		? (only as (typeof RELEASE_TYPES)[number])
		: undefined;
}

/** The prose (pitch and opening of the article) calls the work a compilation: no studio album is its answer. */
export function proseSaysCompilation(node: Obj): boolean {
	const text = `${str(node.editorial_pitch) ?? ""} . ${(str(node.editorial_article) ?? "").slice(0, LEAD_LENGTH)}`;
	return /(?<![\p{L}\p{N}-])compilations?(?![\p{L}\p{N}-])/iu.test(text);
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
	mbid: { from: string | null; to: string | null };
	credit: { from: string[]; to: string[] };
	/** Settled from a closed list (`ForcedFix`), not found by the detector and MusicBrainz. */
	forced?: true;
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
	reason:
		| "several-article-artists"
		| "already-consistent"
		| "no-replacement-weak-evidence"
		| "article-artist-not-in-lead"
		| "compilation-unsettled"
		| "forced-target-absent";
	artists: string[];
}
export interface Conflict {
	slug: string;
	to: string;
	reason:
		| "no-scoped-slug"
		| "target-is-a-redirect-key"
		| "target-claimed-twice"
		| "target-is-renamed"
		| "target-is-suspect"
		| "target-other-identity"
		| "target-unreadable";
}

/** Edges that collided on one slug with different mbids in a rewrite or a merge: both are kept (TRA-610). */
export interface EdgeConflict {
	/** `<node>.<field>` */
	at: string;
	slug: string;
	reason: string;
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
		edgeConflicts: number;
		exempted: number;
		failed: number;
	};
	kept: Record<KeptReason, number>;
	fixed: Fixed[];
	stripped: Stripped[];
	skipped: Skipped[];
	conflicts: Conflict[];
	edgeConflicts: EdgeConflict[];
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
	/** Merged into an existing node: that node, not the fixed one, wins the election. */
	keepTarget?: boolean;
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

/** The node with the reverse edges that waited for it: a list gets the edge when it lacks it, a single when empty. */
function withReverses(node: Obj, entries: readonly PendingReverse[], own: string): Obj {
	const next: Obj = { ...node };
	for (const { field, cardinality, edge } of entries) {
		if (edge.slug === own) continue;
		if (cardinality === "list") {
			const list = edgesOf(next[field]);
			if (!list.some((e) => e.slug === edge.slug)) next[field] = [...list, edge];
		} else if (next[field] == null) {
			next[field] = edge;
		}
	}
	return next;
}

/** Every image a lookup derived from the identity (a Wikidata one belongs to an artist, not to a work). */
const DERIVED_IMAGES: readonly string[] = IMAGE_SOURCES.filter((source) => !source.startsWith("wikidata"));

/** The node without the homonym's leftovers (see `ForcedFix`). */
function withoutLeftovers(node: Obj, forced: ForcedFix, identityChanges: boolean): Obj {
	const wrong = new Set([...forced.wrongArtists, ...(forced.wrongEdges ?? [])]);
	const next: Obj = { ...node };
	for (const field of ["personnel", "producers", "related_projects"] as const) {
		if (Array.isArray(node[field]))
			next[field] = edgesOf(node[field]).filter((e) => !wrong.has(str(e.slug) ?? ""));
	}
	const homonyms = (url: unknown): boolean => {
		const value = str(url);
		return (
			value !== undefined && (identityChanges || (forced.wrongCovers ?? []).some((c) => value.includes(c)))
		);
	};
	if (homonyms(next.cover_url)) delete next.cover_url;
	if (homonyms(next.image_url) && (!identityChanges || DERIVED_IMAGES.includes(String(next.image_source)))) {
		delete next.image_url;
		delete next.image_source;
	}
	// The duration is the wrong recording's (2:54 for Stanley Black's Around the World).
	if (identityChanges) delete next.duration;
	return next;
}

/**
 * A work settled by hand, from a closed list (TRA-610, PR 2): what the detector and MusicBrainz could not settle
 * (a credit named by prose that only mentions members of the band, an artist with no node yet), or what the
 * first run left behind. The work is looked up by slug; absent from the cache (the repo run), it is left alone.
 * - `credit`: re-credit the work to this artist (the cache artist's name and mbid when it has a node) and move its
 *   slug to the right scope; everything the wrong identity gave goes, as in the detected path;
 * - `into`: merge the work into this existing node, which wins (the work is a duplicate of it);
 * - neither: the identity stays and only the leftovers go.
 * In every case the edges to `wrongArtists` in `personnel` / `producers` are removed, and so is the homonym's
 * cover: any `cover_url` and derived image when the identity changes, else the ones containing a `wrongCovers`.
 */
export interface ForcedFix {
	slug: string;
	wrongArtists: readonly string[];
	wrongCovers?: readonly string[];
	/** Other slugs (a related project, a producer) the work lists only because of the wrong prose: removed too. */
	wrongEdges?: readonly string[];
	/**
	 * Artist fields (`reference_track`, `landmark_project`) that name this work and must not: cleared, but only when
	 * the field still holds exactly this work (a pick the pipeline or a human changed since is not ours to undo,
	 * the rule of 2026-10-24-fix-weak-landmarks, TRA-605).
	 */
	detach?: readonly { artist: string; field: "reference_track" | "landmark_project" }[];
	credit?: { slug: string; name: string };
	into?: string;
}

export interface FixOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	/** Where the redirect tables are read and the slug table written (the channel's scratch copy). */
	dataDir?: string | undefined;
	log?: (line: string) => void;
	forced?: readonly ForcedFix[];
	/** Settle the `forced` works only: no detection, hence no MusicBrainz request (the closed-list migration). */
	onlyForced?: boolean;
	/**
	 * Live works whose redirect keys (the bare slug, the slug of the homonym) are rewritten to them in every edge,
	 * although they are not moved by this run: a node that names a key AND the work itself ends with one edge.
	 */
	canonicalTargets?: readonly string[];
	/** The name the manifest carries (the channel's constant); default: this migration's. */
	migrationName?: string;
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
	const detection: Detection = options.onlyForced
		? {
				suspects: [],
				kept: Object.fromEntries(KEPT_REASONS.map((r) => [r, 0])) as Record<KeptReason, number>,
				exempted: [],
			}
		: detectHomonymWorks(index);
	const ctx = buildContext(nodes);
	log(`${detection.suspects.length} suspect work(s) among ${nodes.filter((n) => isWorkSlug(n.slug)).length}`);

	const failed: FixManifest["failed"] = invalid
		.filter((entry) => /^(project|track)[/\\]/.test(relative(join(cacheDir, "nodes"), entry.path)))
		.map((entry) => ({ slug: entry.path, reason: `unreadable node file: ${entry.error}` }));
	const stripped: StripPlan[] = [];
	const fixes: FixPlan[] = [];
	const skipped: Skipped[] = [];
	const conflicts: Conflict[] = [];

	const forcedList = options.forced ?? [];
	const forcedSlugs = new Set(forcedList.map((f) => f.slug));
	// artist -> [field, work]: the singular fields to clear, for the works this cache holds.
	const detachments = new Map<string, [string, string][]>();
	for (const forced of forcedList) {
		if (!files.has(forced.slug)) continue;
		for (const { artist, field } of forced.detach ?? []) {
			detachments.set(artist, [...(detachments.get(artist) ?? []), [field, forced.slug]]);
		}
	}
	const absent = forcedList.filter((f) => !files.has(f.slug)).map((f) => f.slug);
	if (forcedList.length > 0) {
		log(`${forcedList.length - absent.length} of ${forcedList.length} listed work(s) in this cache`);
		if (absent.length > 0) log(`not in this cache: ${absent.join(", ")}`);
	}
	for (const forced of forcedList) {
		const file = files.get(forced.slug);
		if (!file || (file.type !== "project" && file.type !== "track")) continue;
		const type = file.type as WorkType;
		const name = str(file.node.name) ?? forced.slug;
		const changes = forced.credit !== undefined || forced.into !== undefined;
		let node = withoutLeftovers(changes ? withoutWrongIdentity(file.node) : file.node, forced, changes);
		let newSlug = forced.slug;
		if (forced.into !== undefined) {
			const target = files.get(forced.into);
			if (!target) {
				skipped.push({ slug: forced.slug, reason: "forced-target-absent", artists: [] });
				continue;
			}
			node = { ...node, artists: edgesOf(target.node.artists) };
			newSlug = forced.into;
		} else if (forced.credit !== undefined) {
			const known = index.artists.get(forced.credit.slug);
			const creditName = str(known?.name) ?? forced.credit.name;
			const creditMbid = validMbid(known?.mbid);
			node = {
				...node,
				artists: [
					{
						slug: forced.credit.slug,
						type: "artist",
						name: creditName,
						...(creditMbid === undefined ? {} : { mbid: creditMbid }),
					},
				],
			};
			const scope = pickScopeArtistName([creditName]);
			const derived = scope === null ? null : canonicalScopedSlug(type, name, scope);
			if (derived === null) {
				conflicts.push({ slug: forced.slug, to: "", reason: "no-scoped-slug" });
				continue;
			}
			newSlug = derived;
		}
		fixes.push({
			oldSlug: forced.slug,
			newSlug,
			type,
			node: { ...node, slug: newSlug },
			dropFrom: new Set([...wrongNeighbours(file.node, node), ...forced.wrongArtists]),
			keepTarget: forced.into !== undefined,
			report: {
				slug: forced.slug,
				to: newSlug,
				artist: slugsOf(node.artists)[0] ?? "",
				mbid: { from: str(file.node.mbid) ?? null, to: str(node.mbid) ?? null },
				credit: { from: slugsOf(file.node.artists), to: slugsOf(node.artists) },
				merged: false,
				droppedEdges: 0,
				forced: true,
			},
		});
	}

	for (const suspect of detection.suspects) {
		const file = files.get(suspect.slug);
		if (!file || forcedSlugs.has(suspect.slug)) continue;
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
		// The prose calls the work a compilation and MusicBrainz cannot tell it from the studio album of the same
		// title: no answer, and nothing destructive on a guess. Projects only: a track has no studio-album rule.
		// This corrects LESS than the plain path (an ambiguous answer is skipped, not stripped, although the
		// ambiguity is about WHICH release of the article artist, not about the credit being wrong), by choice:
		// the migration never removes nor re-credits on a reading of the prose it cannot rely on (review of #607,
		// 2026-10-24).
		let compilationUnsettled = false;
		const compilation = suspect.type === "project" && proseSaysCompilation(file.node);
		const tryable = suspect.articleArtists.filter((a) => a.inLead);
		if (tryable.length === 0) {
			skipped.push({
				slug: suspect.slug,
				reason: "article-artist-not-in-lead",
				artists: suspect.articleArtists.map((a) => a.slug),
			});
			continue;
		}
		for (const artist of tryable) {
			const releaseType =
				RELEASE_TYPES.find((t) => t === artist.entry?.releaseType) ??
				(suspect.type === "project" ? releaseTypeFromProse(file.node) : undefined);
			const lookedUp = await lookUp(suspect.type, suspect.name, artist, releaseType, !compilation);
			if (lookedUp.unavailable) {
				unavailable = true;
				break;
			}
			const found = lookedUp.found;
			if (!found) {
				rejected.push(lookedUp.ambiguous ? "ambiguous-candidates" : "no-match");
				if (lookedUp.ambiguous && compilation) compilationUnsettled = true;
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
		if (chosen === undefined && compilationUnsettled) {
			skipped.push({
				slug: suspect.slug,
				reason: "compilation-unsettled",
				artists: suspect.articleArtists.map((a) => a.slug),
			});
			continue;
		}
		if (chosen === undefined) {
			// No replacement. Removing a credit is destructive: it needs ONE article artist with both links to
			// the work (it lists the work AND the work lists it as a producer, as in both prod cases).
			const [only] = tryable;
			if (
				tryable.length !== 1 ||
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
	// What stops a fix whatever the other fixes do.
	const blockedBy = (fix: FixPlan): Conflict["reason"] | null => {
		if ((claimed.get(fix.newSlug) ?? []).length > 1) return "target-claimed-twice";
		if (tables.all.has(fix.newSlug)) return "target-is-a-redirect-key";
		const existing = files.get(fix.newSlug);
		if (!existing) return null;
		const sameMbid =
			str(existing.node.mbid) === undefined ||
			(fix.keepTarget === true && str(fix.node.mbid) === undefined) ||
			str(existing.node.mbid) === str(fix.node.mbid);
		const theirFirst = edgesOf(existing.node.artists)[0];
		const ourFirst = edgesOf(fix.node.artists)[0];
		const sameCredit =
			theirFirst === undefined ||
			(ourFirst !== undefined &&
				sameArtist(
					{ slug: str(theirFirst.slug), mbid: validMbid(theirFirst.mbid) },
					{ slug: str(ourFirst.slug) ?? "", name: "", mbid: validMbid(ourFirst.mbid) },
				));
		return sameMbid && sameCredit ? null : "target-other-identity";
	};
	// A node that is moving away, or is a suspect, is not one to merge into (2026-10-23, review of #535): a fix
	// merged into a node that is then renamed is deleted with it, and the work is lost. `renamedFrom` holds the
	// fixes that no check above stops; it is not transitive: on a chain A -> T -> U, T can still end as a
	// `target-is-suspect` conflict of its own and count as renamed for A, whose conflict then only carries
	// another label. A suspect that is not moving (skipped, stripped, fixed in place) is a conflict too, as
	// its own identity is not settled.
	const renamedFrom = new Set(
		fixes.filter((f) => f.newSlug !== f.oldSlug && blockedBy(f) === null).map((f) => f.oldSlug),
	);
	const suspectSlugs = new Set(detection.suspects.map((x) => x.slug));
	for (const fix of fixes) {
		if (fix.newSlug === fix.oldSlug) {
			plans.push(fix);
			continue;
		}
		const reason =
			blockedBy(fix) ??
			(renamedFrom.has(fix.newSlug)
				? "target-is-renamed"
				: suspectSlugs.has(fix.newSlug)
					? "target-is-suspect"
					: null);
		if (reason !== null) {
			conflicts.push({ slug: fix.oldSlug, to: fix.newSlug, reason });
			continue;
		}
		plans.push(fix);
	}

	// --- Rewrite the cache in memory ---
	const moves: Record<string, string> = {};
	for (const fix of plans) if (fix.newSlug !== fix.oldSlug) moves[fix.oldSlug] = fix.newSlug;
	// The redirect keys that read as a work (the bare slug of `project:wish-you-were-here--american-hot-wax`) and
	// are no node: an edge that names one names the work, and moves or goes with it. Harvest Records listed the
	// album under its bare slug AND under the scoped one (2026-10-18, prod). Before the pairs of the preview are
	// committed such a key leads to the old slug, after they are (flattened) to the new one: both are the work's.
	const keysTo = new Map<string, string[]>();
	for (const [from, to] of Object.entries(tables.slug)) {
		if (!files.has(from)) keysTo.set(to, [...(keysTo.get(to) ?? []), from]);
	}
	const aliasesOf = (slug: string): string[] => [
		...(keysTo.get(slug) ?? []),
		...(moves[slug] === undefined ? [] : (keysTo.get(moves[slug]) ?? [])),
	];
	const edgeMoves: Record<string, string> = { ...moves };
	for (const [from, to] of Object.entries(moves)) {
		for (const alias of aliasesOf(from)) edgeMoves[alias] = to;
	}
	for (const target of options.canonicalTargets ?? []) {
		// The target need not be a node of THIS cache (the repo holds the label, prod holds the album): the key
		// reads as the target through the committed table everywhere, which is all this rewrites.
		for (const key of keysTo.get(target) ?? []) edgeMoves[key] = target;
	}
	const edgeConflicts: EdgeConflict[] = [];
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
		for (const old of wrongTo.get(file.slug) ?? []) {
			const before = JSON.stringify(next);
			next = removeEdgesTo(next, file.type, new Set([old, ...aliasesOf(old)]));
			if (JSON.stringify(next) !== before) droppedBy.set(old, (droppedBy.get(old) ?? 0) + 1);
		}
		for (const [field, work] of detachments.get(file.slug) ?? []) {
			const held = next[field];
			if (isRecord(held) && str(held.slug) === work) {
				next = { ...next };
				delete next[field];
			}
		}
		if (Object.keys(edgeMoves).length > 0) {
			const rewritten = rewriteEdges(
				next,
				file.type,
				edgeMoves,
				own && "oldSlug" in own ? own.newSlug : file.slug,
			);
			next = rewritten.node;
			for (const c of rewritten.conflicts) {
				edgeConflicts.push({ at: c.slugs[0] ?? file.slug, slug: c.slugs[1] ?? "", reason: c.reason });
			}
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
		const winner = plan.keepTarget ? theirs : elect([ours, theirs], false).winner;
		const merged = mergeNodes(winner, [winner === ours ? theirs : ours], plan.newSlug, (field, edgeSlug) => {
			edgeConflicts.push({
				at: `${plan.newSlug}.${field}`,
				slug: edgeSlug,
				reason: `edges to ${edgeSlug} carry different mbids in the two nodes merged: both kept`,
			});
		});
		// Whoever wins the election, the identity just resolved is the work's: the stub that already stood at the
		// target would otherwise keep (or lack) the year, the release type and the cover of its own.
		// A merge settled by hand (`keepTarget`) is a duplicate of the target: the target keeps all of its own.
		if (!plan.keepTarget) {
			for (const field of ["year", "release_type", "image_url", "image_source"] as const) {
				if (fixedNode[field] !== undefined) merged[field] = fixedNode[field];
			}
		}
		merged.artists = fixedNode.artists;
		planned.set(plan.newSlug, merged);
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
		// A reverse edge awaiting a wrong neighbour's node, pointing at the old work, existed only because of the
		// wrong identity: it is dropped, not re-pointed at the right work.
		// A key this cleaning empties goes with it: an empty list would wait for a write that has nothing to apply.
		const cleaned = Object.fromEntries(
			Object.entries(raw).flatMap(([key, list]) => {
				const wrong = (wrongTo.get(key) ?? []).flatMap((old) => [old, ...aliasesOf(old)]);
				const kept = list.filter((entry) => !wrong.includes(entry.edge.slug));
				return kept.length === 0 && list.length > 0 ? [] : [[key, kept]];
			}),
		);
		// Through `edgeMoves`: a waiting edge that names a bare slug would bring the duplicate back on its write.
		pending = rewritePendingReverses(cleaned, new Map(Object.entries(edgeMoves)));
		if (JSON.stringify(cleaned) !== JSON.stringify(raw)) pending.changed = true;
		// Reverse edges waiting under a new slug are for a node that now exists: they are applied, as the scope
		// migration does for a key that lands on a node (TRA-610). The ones the runtime does not emit stay queued.
		for (const plan of plans) {
			const waiting = plan.newSlug === plan.oldSlug ? undefined : pending.result[plan.newSlug];
			const target = planned.get(plan.newSlug);
			if (!waiting || !target) continue;
			const entries = waiting.filter((entry) => isSafePendingEntry(plan.newSlug, entry));
			if (entries.length === 0) continue;
			planned.set(plan.newSlug, withReverses(target, entries, plan.newSlug));
			const left = waiting.filter((entry) => !entries.includes(entry));
			if (left.length > 0) pending.result[plan.newSlug] = left;
			else delete pending.result[plan.newSlug];
			pending.changed = true;
		}
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
		migration: options.migrationName ?? MIGRATION_NAME,
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
			edgeConflicts: edgeConflicts.length,
			exempted: detection.exempted.length,
			failed: failed.length,
		},
		kept: detection.kept,
		fixed: plans.map((p) => p.report).sort(bySlug),
		stripped: stripped.map((p) => p.report).sort(bySlug),
		skipped: skipped.sort(bySlug),
		conflicts: conflicts.sort((a, b) => compareLex(a.slug, b.slug)),
		edgeConflicts: edgeConflicts.sort((a, b) => compareLex(`${a.at}\n${a.slug}`, `${b.at}\n${b.slug}`)),
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
		`${s.works} work(s): ${s.suspects} suspect, ${s.fixed} fixed, ${s.stripped} stripped, ${s.skipped} skipped, ${s.conflicts} conflict(s), ${s.edgeConflicts} edge conflict(s), ${s.exempted} article artist(s) exempted as relatives, ${s.failed} failed`,
		apply ? `${written.length} file(s) written` : "dry-run: nothing written",
		`manifest: ${manifestPath}`,
	];
	for (const f of manifest.fixed)
		lines.push(`fixed ${f.slug} -> ${f.to} (${f.credit.from.join(",")} -> ${f.credit.to.join(",")})`);
	for (const x of manifest.stripped)
		lines.push(`stripped ${x.slug} (${x.reason}, article artist ${x.artist})`);
	for (const x of manifest.skipped) lines.push(`skipped ${x.slug} (${x.reason}: ${x.artists.join(",")})`);
	for (const x of manifest.conflicts) lines.push(`conflict ${x.slug} -> ${x.to} (${x.reason})`);
	for (const x of manifest.edgeConflicts) lines.push(`edge conflict ${x.at} -> ${x.slug} (${x.reason})`);
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
