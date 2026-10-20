/**
 * Which MusicBrainz release groups belong in an artist's discography, and in what order (graph-integrity
 * plan, part 8, decision 8-D1). Pure module: no I/O, no network. The pipeline (8.3) and the backfills
 * (8.5, 8.6) must all apply this one rule, so it lives here and nowhere else.
 *
 * Why it exists (measured 2026-10-18 on the repo cache): 218 remix / edit / mix / bootleg / megamix /
 * sampler titles, most of them with an mbid ("Control Your Body (Hardwell edit)", "Megamix", "The Remix
 * Album"), and 16 lists stuck at the old cap of 80 where singles drowned the albums (A$AP Rocky: 5 albums,
 * 75 singles).
 */
import { VARIOUS_ARTISTS_MBID } from "./musicbrainz.js";
import { makeScopedSlug, normalizeTitleBody, stripEditionNoise } from "./slug.js";
import type { EdgeRef, Slug } from "./types.js";

// Re-exported so callers keep one import site for the policy; the constant itself lives with the MusicBrainz client.
export { VARIOUS_ARTISTS_MBID };

export interface ReleaseGroupCandidate {
	mbid: string;
	title: string;
	firstReleaseDate: string; // "" when MusicBrainz has none
	primaryType: string; // "Album" | "EP" | "Single" | other
	secondaryTypes: string[];
	artistCredits: { mbid: string; name: string }[]; // MusicBrainz order
	ratingVotes: number; // MusicBrainz `rating["votes-count"]`, 0 when none: the cap's priority signal (TRA-625)
}

export interface DiscographyPolicy {
	artistMbid: string;
	artistName: string;
	cap: number;
	// Calendar year "now", given by the caller (never read from the clock here, so tests and migrations stay
	// deterministic). Only the unrated cut uses it: a release of this year or last has had no time to be voted.
	currentYear: number;
}

export const DEFAULT_DISCOGRAPHY_CAP = 40;

/**
 * Bump it whenever the selection or the merge rules change what they decide for the same MusicBrainz answers
 * (TRA-618): the discography backfill's `--resume` carries a decision only if it was made under this version.
 * 2026-10-19: 2, the policy changed with TRA-625 (Soundtrack and Mixtape/Street admitted, cap order by MusicBrainz
 * votes, an untyped entry facing one album and singles gets the album): a manifest of version 1 is not replayed.
 * 2026-10-19: 3, the policy changed with TRA-628 (unvoted release groups cut once an artist has
 * MIN_VOTED_FOR_UNRATED_CUT voted ones, except recent releases; an album is posed ignoring its Live / Compilation
 * namesakes): a manifest of version 2 is not replayed.
 * 2026-10-19: 4, the policy changed with TRA-629 (an entry that differs from a release group only by a trailing
 * "(1979)" / "[1979]" year or an "EP" suffix is posed its mbid instead of getting a twin added): a manifest of
 * version 3 is not replayed.
 * 2026-10-20: 5, the policy changed with TRA-647 (an entry with neither releaseType nor year is no longer posed
 * the mbid of a lone same-title release group when its project node holds another mbid, nor when the artist has
 * MIN_VOTED_FOR_UNRATED_CUT voted release groups and that one has no vote and is not recent; the cache PR #562 had
 * posed 5 reference entries with the identity of a minor single or a reissue): a manifest of version 4 is not
 * replayed.
 */
export const DISCOGRAPHY_POLICY_VERSION = 5;

// TRA-628 (measured 2026-10-19 on MusicBrainz): John Lennon has 69 eligible release groups, 14 voted and 55
// not (The Lost Lennon Tapes, Archives, outtakes), and the cap used to fill with the oldest of them. From this
// many voted candidates on, an unvoted one no longer qualifies. Below it nothing is cut: Kode9 has 24 eligible
// and 0 voted, and cutting there would leave him no discography at all.
export const MIN_VOTED_FOR_UNRATED_CUT = 10;

export type ExclusionReason =
	| "secondary-type"
	| "primary-type"
	| "credit"
	| "various-artists"
	| "non-canonical"
	| "unrated";

type KeptPrimaryType = "Album" | "EP" | "Single";

const KEPT_PRIMARY_TYPES: readonly KeptPrimaryType[] = ["Album", "EP", "Single"];
// A release credited to more than this many artists is a collaboration compilation, not the artist's own.
const MAX_CREDITS = 2;

// Whole words only, so "remixed" or "mixtape" do not match "remix" / "mix" by accident.
const WORD_EDGE_BEFORE = "(?<![\\p{L}\\p{N}])";
const WORD_EDGE_AFTER = "(?![\\p{L}\\p{N}])";

const NON_CANONICAL_WORDS = new RegExp(
	`${WORD_EDGE_BEFORE}(?:remix|remixes|megamix|mashup|mash-up|bootleg|sampler|karaoke|greatest hits|anthology)${WORD_EDGE_AFTER}`,
	"u",
);
const NON_CANONICAL_PREFIX = /^(?:the best of|the very best of)(?![\p{L}\p{N}])/u;
const TRAILING_BRACKET = /[([]([^()[\]]*)[)\]]$/u;
// " - Radio Edit" style suffix (hyphen, en dash or em dash with spaces around it). Spaces are required so
// "Selected Ambient Works 85-92" is not split. Greedy prefix: the last separator wins.
const TRAILING_DASH_SUFFIX = /^.*\s[-\u2013\u2014]\s+(.+)$/u;
// Optional plural ("Club Mixes", "Radio Edits", "Instrumentals"); whole words keep "(Deluxe Edition)" out,
// since "edit" is only a substring of "edition".
const VARIANT_MARKER = new RegExp(
	`${WORD_EDGE_BEFORE}(?:edit|mix|dub|instrumental|acapella|remix)(?:e?s)?${WORD_EDGE_AFTER}`,
	"u",
);
// "version" alone names a re-recording or reissue ("Fearless (Taylor's Version)"), which is a real album.
// It only marks a variant next to one of these qualifiers ("(Radio Version)", "- Live Version").
const VERSION_WORD = new RegExp(`${WORD_EDGE_BEFORE}versions?${WORD_EDGE_AFTER}`, "u");
const VERSION_QUALIFIER = new RegExp(
	`${WORD_EDGE_BEFORE}(?:extended|radio|club|dub|instrumental|single|edit|remix|mix|alternate|acoustic|live)${WORD_EDGE_AFTER}`,
	"u",
);

function isVariantQualifier(segment: string): boolean {
	if (VARIANT_MARKER.test(segment)) return true;
	return VERSION_WORD.test(segment) && VERSION_QUALIFIER.test(segment);
}

function normalizeTitle(title: string): string {
	return title.normalize("NFKD").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * True for titles that name a variant or a repackaging rather than a work of the artist: remix / mashup /
 * bootleg / sampler / karaoke / best-of words anywhere, "The (Very) Best of" prefixes, or a trailing
 * "(... edit)" / "[... mix]" / " - Radio Edit" style qualifier.
 */
export function isNonCanonicalReleaseTitle(title: string): boolean {
	const normalized = normalizeTitle(title);
	if (NON_CANONICAL_WORDS.test(normalized)) return true;
	if (NON_CANONICAL_PREFIX.test(normalized)) return true;
	const bracket = TRAILING_BRACKET.exec(normalized)?.[1];
	if (bracket !== undefined && isVariantQualifier(bracket)) return true;
	const dashSuffix = TRAILING_DASH_SUFFIX.exec(normalized)?.[1];
	return dashSuffix !== undefined && isVariantQualifier(dashSuffix);
}

// TRA-629 (measured 2026-10-19, full dry-run of the backfill): about 30 of the 50 near duplicates were the same
// work under a different suffix ("Ladies' Night (1979)" vs "Ladies' Night", "Xpander EP" vs "Xpander"). The
// backfill never removes anything, so the twin it added next to such an entry would be permanent.
// A year needs its brackets, so a title that is a year ("1979") keeps it; "EP" needs a space, a dash or a
// bracket before it, so "Deep" and "EPic" are untouched.
const TRAILING_YEAR_SUFFIX = /\s*(?:\(\s*((?:19|20)\d{2})\s*\)|\[\s*((?:19|20)\d{2})\s*\])$/u;
const TRAILING_EP_SUFFIX = /(?:\s+[-\u2013\u2014]\s+ep|\s*\(\s*ep\s*\)|\s*\[\s*ep\s*\]|\s+ep)$/iu;

// The title with its trailing year / EP suffixes peeled off, in any order and as many times as they come; the
// last year written among them; and whether an "EP" was peeled. Each suffix is peeled on its own, and never
// if nothing would be left of the title: "(EP) (1979)" and "EP (1979)" both keep "EP".
function peelSuffixes(title: string): { rest: string; year: number | null; ep: boolean } {
	let rest = stripEditionNoise(title.normalize("NFKD"));
	let year: number | null = null;
	let ep = false;
	const peel = (suffix: RegExp): RegExpExecArray | null => {
		const match = suffix.exec(rest);
		if (match === null) return null;
		const left = rest.slice(0, match.index).trim();
		if (normalizeTitleBody(left) === "") return null;
		rest = left;
		return match;
	};
	for (;;) {
		const before = rest;
		const yearMatch = peel(TRAILING_YEAR_SUFFIX);
		const stated = yearMatch?.[1] ?? yearMatch?.[2];
		if (year === null && stated !== undefined) year = Number(stated);
		if (peel(TRAILING_EP_SUFFIX) !== null) ep = true;
		if (rest === before) break;
	}
	return { rest, year, ep };
}

/**
 * Looser identity than normalizeTitleBody, for reconciling an existing entry with a release group: the title
 * body once a trailing "(1979)" / "[1979]" year (1900 to 2099) and a trailing "EP" ("X EP", "X (EP)", "X [EP]",
 * "X - EP") are removed, in any order and as many times as they come. A suffix is never removed if nothing
 * would be left of the title. Both sides of a comparison go through it.
 */
export function reconciliationKey(title: string): string {
	return normalizeTitleBody(peelSuffixes(title).rest);
}

// MBIDs are UUIDs: case carries no meaning, and a hand-supplied upper-case id must not exclude a whole
// discography as a "credit" mismatch.
function sameMbid(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

// Secondary types that still name the artist's own work (TRA-625, measured 2026-10-19 on The Beatles: Help!,
// A Hard Day's Night, Magical Mystery Tour and Yellow Submarine are "Album + Soundtrack"; "So Far Gone" is
// "Mixtape/Street"). Every other one (Compilation, Live, Remix, DJ-mix, Demo, Spokenword, Interview,
// Audiobook, Audio drama, Field recording) is a repackaging or not music, and one of them anywhere in the
// list excludes the release group: "Soundtrack + Live" stays out.
const ADMITTED_SECONDARY_TYPES: ReadonlySet<string> = new Set(["Soundtrack", "Mixtape/Street"]);

function hasOnlyAdmittedSecondaryTypes(c: ReleaseGroupCandidate): boolean {
	return c.secondaryTypes.every((type) => ADMITTED_SECONDARY_TYPES.has(type));
}

function isKeptPrimaryType(type: string): type is KeptPrimaryType {
	return (KEPT_PRIMARY_TYPES as readonly string[]).includes(type);
}

// The credit rule alone: the artist heads the release (first credit), it has at most MAX_CREDITS credits, and
// Various Artists is not one of them. Various Artists is told apart from a plain "credit" mismatch, which is what
// the exclusion log is read for.
function creditVerdict(
	c: ReleaseGroupCandidate,
	policy: DiscographyPolicy,
): "various-artists" | "credit" | null {
	if (c.artistCredits.some((credit) => sameMbid(credit.mbid, VARIOUS_ARTISTS_MBID))) return "various-artists";
	const firstCredit = c.artistCredits[0];
	if (firstCredit === undefined || !sameMbid(firstCredit.mbid, policy.artistMbid)) return "credit";
	return c.artistCredits.length > MAX_CREDITS ? "credit" : null;
}

/**
 * Checks run in a fixed order and the first failure wins. Various Artists is checked before the credit
 * position: a "Various Artists" release is reported as such rather than as a plain "credit" mismatch,
 * which is what the exclusion log is read for.
 */
export function classifyRelease(
	c: ReleaseGroupCandidate,
	policy: DiscographyPolicy,
): { ok: true } | { ok: false; reason: ExclusionReason } {
	if (!isKeptPrimaryType(c.primaryType)) return { ok: false, reason: "primary-type" };
	if (!hasOnlyAdmittedSecondaryTypes(c)) return { ok: false, reason: "secondary-type" };
	const credit = creditVerdict(c, policy);
	if (credit !== null) return { ok: false, reason: credit };
	if (isNonCanonicalReleaseTitle(c.title)) return { ok: false, reason: "non-canonical" };
	return { ok: true };
}

// Newest first; "" (unknown date) sorts last. Ties break on title then mbid, so which releases survive the
// cap does not depend on the order MusicBrainz pages were fetched in (no spurious cache diffs on re-runs).
function byNewestFirst(a: ReleaseGroupCandidate, b: ReleaseGroupCandidate): number {
	if (a.firstReleaseDate !== b.firstReleaseDate) {
		if (a.firstReleaseDate === "") return 1;
		if (b.firstReleaseDate === "") return -1;
		return a.firstReleaseDate < b.firstReleaseDate ? 1 : -1;
	}
	if (a.title !== b.title) return a.title < b.title ? -1 : 1;
	if (a.mbid === b.mbid) return 0;
	return a.mbid < b.mbid ? -1 : 1;
}

// The one place that says what "voted" means: the cap's priority and the unrated cut must agree on it.
function isVoted(c: ReleaseGroupCandidate): boolean {
	return c.ratingVotes > 0;
}

// Who gets the room when there are more candidates than places (TRA-625). In order:
//  (a) voted (ratingVotes > 0) before unvoted, whatever the type: a voted single ("Hey Jude") beats an
//      unmarked bootleg album;
//  (b) album, then EP, then single;
//  (c) votes descending;
//  (d) the oldest first;
//  (e) title, then mbid, for determinism.
// Why votes: "newest first" gave Beatles' 40 album places to unmarked bootlegs and posthumous archives
// (0 votes) and cut Abbey Road, Revolver, Let It Be; oldest first alone would put the 1964 US editions
// before Abbey Road. Votes rank the canon (Abbey Road 71, Revolver 61, Let It Be 43; pirates 0). An artist
// with no vote at all falls to (b) then (d): albums first, oldest to newest. An unknown date ("") sorts
// last among equals.
function byCapPriority(a: ReleaseGroupCandidate, b: ReleaseGroupCandidate): number {
	const votedA = isVoted(a);
	if (votedA !== isVoted(b)) return votedA ? -1 : 1;
	if (additionRank(a) !== additionRank(b)) return additionRank(a) - additionRank(b);
	if (a.ratingVotes !== b.ratingVotes) return b.ratingVotes - a.ratingVotes;
	if (a.firstReleaseDate !== b.firstReleaseDate) {
		if (a.firstReleaseDate === "") return 1;
		if (b.firstReleaseDate === "") return -1;
		return a.firstReleaseDate < b.firstReleaseDate ? -1 : 1;
	}
	if (a.title !== b.title) return a.title < b.title ? -1 : 1;
	if (a.mbid === b.mbid) return 0;
	return a.mbid < b.mbid ? -1 : 1;
}

function typeRank(c: ReleaseGroupCandidate): number {
	return KEPT_PRIMARY_TYPES.indexOf(c.primaryType as KeptPrimaryType);
}

// Which of two release groups sharing a slug survives: the stronger type (album > EP > single), then the
// earliest known date (an unknown date loses to a known one), then title and mbid for determinism.
function byPreferredDuplicate(a: ReleaseGroupCandidate, b: ReleaseGroupCandidate): number {
	if (typeRank(a) !== typeRank(b)) return typeRank(a) - typeRank(b);
	if (a.firstReleaseDate !== b.firstReleaseDate) {
		if (a.firstReleaseDate === "") return 1;
		if (b.firstReleaseDate === "") return -1;
		return a.firstReleaseDate < b.firstReleaseDate ? -1 : 1;
	}
	if (a.title !== b.title) return a.title < b.title ? -1 : 1;
	if (a.mbid === b.mbid) return 0;
	return a.mbid < b.mbid ? -1 : 1;
}

function projectSlugOf(c: ReleaseGroupCandidate, policy: DiscographyPolicy): string | null {
	const slug = makeScopedSlug("project", c.title.trim(), policy.artistName.trim());
	return slug.ok ? slug.slug : null;
}

// An album and a single sharing a title ("Black Sun" 2011 / "Black Sun" 2010) are one project node. Releases
// whose slug cannot be built are left alone: toDiscographyEdge returns null for them anyway.
function dedupeBySlug(eligible: ReleaseGroupCandidate[], policy: DiscographyPolicy): ReleaseGroupCandidate[] {
	const bySlug = new Map<string, ReleaseGroupCandidate>();
	const unslugged: ReleaseGroupCandidate[] = [];
	for (const candidate of eligible) {
		const slug = projectSlugOf(candidate, policy);
		if (slug === null) {
			unslugged.push(candidate);
			continue;
		}
		const incumbent = bySlug.get(slug);
		if (incumbent === undefined || byPreferredDuplicate(candidate, incumbent) < 0) {
			bySlug.set(slug, candidate);
		}
	}
	return [...bySlug.values(), ...unslugged];
}

// Released last year or this year: exempt from the unrated cut. An unknown date ("") is not recent.
function isRecentRelease(c: ReleaseGroupCandidate, policy: DiscographyPolicy): boolean {
	const year = yearOf(c.firstReleaseDate);
	return year !== null && year >= policy.currentYear - 1;
}

/**
 * Filters with classifyRelease, collapses release groups that share a project slug, then applies the cap
 * in `byCapPriority` order: voted before unvoted, then album / EP / single, then most votes, then oldest.
 * Duplicates are collapsed before the cap so they never use up room. With at least MIN_VOTED_FOR_UNRATED_CUT
 * voted candidates left, the unvoted ones are excluded as `unrated` before the cap, except those released
 * from `currentYear - 1` on (TRA-628). `kept` comes back ordered newest first across types (the display
 * order, unchanged by the priority). `excluded` lists policy rejections only; candidates dropped by the cap
 * are not reported (the cap is not an ExclusionReason).
 */
export function selectReleases(
	candidates: readonly ReleaseGroupCandidate[],
	policy: DiscographyPolicy,
): {
	kept: ReleaseGroupCandidate[];
	excluded: { mbid: string; title: string; reason: ExclusionReason }[];
} {
	const eligible: ReleaseGroupCandidate[] = [];
	const excluded: { mbid: string; title: string; reason: ExclusionReason }[] = [];
	for (const candidate of candidates) {
		const verdict = classifyRelease(candidate, policy);
		if (verdict.ok) eligible.push(candidate);
		else excluded.push({ mbid: candidate.mbid, title: candidate.title, reason: verdict.reason });
	}

	const distinct = dedupeBySlug(eligible, policy);
	const votedCount = distinct.filter(isVoted).length;
	const cutUnrated = votedCount >= MIN_VOTED_FOR_UNRATED_CUT;
	const rated: ReleaseGroupCandidate[] = [];
	for (const candidate of distinct) {
		if (cutUnrated && !isVoted(candidate) && !isRecentRelease(candidate, policy)) {
			excluded.push({ mbid: candidate.mbid, title: candidate.title, reason: "unrated" });
		} else {
			rated.push(candidate);
		}
	}
	const kept = rated.sort(byCapPriority).slice(0, Math.max(0, policy.cap));
	return { kept: kept.sort(byNewestFirst), excluded };
}

/**
 * The project edge for a kept release group, or null when no scoped slug can be built (empty title, or an
 * artist name with no Latin letter or digit). The shape is the one `scopedWorkEdge` (src/pipeline.ts) emits
 * for the MusicBrainz discography override today, `artist` included, so replacing that block (TRA-615)
 * changes no edge. `policy.artistName` is the name the scope is built from; picking it among aliases is the
 * caller's job.
 */
export function toDiscographyEdge(c: ReleaseGroupCandidate, policy: DiscographyPolicy): EdgeRef | null {
	const name = c.title.trim();
	const artist = policy.artistName.trim();
	const slug = makeScopedSlug("project", name, artist);
	if (!slug.ok) return null;
	const edge: EdgeRef = { slug: slug.slug, type: "project", name, artist };
	if (c.mbid) edge.mbid = c.mbid;
	const year = c.firstReleaseDate.slice(0, 4);
	if (year) edge.year = year;
	const releaseType = c.primaryType.toLowerCase();
	if (releaseType === "album" || releaseType === "ep" || releaseType === "single") {
		edge.releaseType = releaseType;
	}
	return edge;
}

/**
 * Newest year first, then name ascending within a year; entries without a year stay at the end in their
 * original relative order. Returns a new array and leaves the entries untouched.
 */
export function orderDiscography(edges: readonly EdgeRef[]): EdgeRef[] {
	const dated: EdgeRef[] = [];
	const undated: EdgeRef[] = [];
	for (const edge of edges) {
		if (edge.year === undefined || edge.year === "") undated.push(edge);
		else dated.push(edge);
	}
	dated.sort((a, b) => {
		const yearA = a.year ?? "";
		const yearB = b.year ?? "";
		if (yearA !== yearB) return yearA < yearB ? 1 : -1;
		if (a.name === b.name) return 0;
		return a.name < b.name ? -1 : 1;
	});
	return [...dated, ...undated];
}

export interface MergeInput {
	existing: readonly EdgeRef[]; // the artist's current discography
	candidates: readonly ReleaseGroupCandidate[]; // selectReleases(...).kept: what may be added
	// Every release group first-credited to the artist, any type: what an mbid may be posed from.
	// An mbid may only be posed from one that passes the credit rule of classifyRelease (TRA-647).
	allCredited: readonly ReleaseGroupCandidate[];
	policy: DiscographyPolicy;
	projectIndex: {
		byMbid: ReadonlyMap<string, Slug>;
		// The mbid a project node holds, by node slug (nodes without an mbid are absent). Read under the slug
		// `resolveSlug` gives for the entry (TRA-647).
		mbidBySlug: ReadonlyMap<Slug, string>;
		resolveSlug: (slug: Slug) => Slug;
	};
}

export type AmbiguousReason = "multiple" | "type" | "year-mismatch" | "node-conflict" | "unrated-pose";

export interface MergeResult {
	edges: EdgeRef[];
	changed: boolean;
	posed: { slug: Slug; mbid: string; filled: ("year" | "releaseType")[] }[];
	added: {
		slug: Slug;
		mbid: string;
		title: string;
		year?: string;
		releaseType: "album" | "ep" | "single";
		nearDuplicateOf?: Slug;
	}[];
	ambiguous: { slug: Slug; reason: AmbiguousReason }[];
	capReached: boolean;
}

// A hand-written year may be off by this much from MusicBrainz's first release date (reissue, delayed release).
const MAX_YEAR_DRIFT = 1;

function yearOf(value: string | undefined): number | null {
	const match = /^\d{4}/.exec(value ?? "");
	return match === null ? null : Number(match[0]);
}

function additionRank(c: ReleaseGroupCandidate): number {
	const rank = typeRank(c);
	return rank < 0 ? KEPT_PRIMARY_TYPES.length : rank;
}

function hasMbid(edge: EdgeRef): boolean {
	return edge.mbid !== undefined && edge.mbid !== "";
}

// Word-boundary prefix on normalized bodies: "sine-of-the-dub" opens "sine-of-the-dub-stalker" but not
// "sine-of-the-dubstep". An empty body (title with no Latin letter or digit) opens nothing.
function opensWith(longer: string, shorter: string): boolean {
	return shorter !== "" && longer.startsWith(`${shorter}-`);
}

type PoseVerdict =
	| { kind: "none" }
	| { kind: "ambiguous"; reason: AmbiguousReason }
	| { kind: "pose"; match: ReleaseGroupCandidate };

function decidePose(
	entry: EdgeRef,
	matches: readonly ReleaseGroupCandidate[],
	titleYear: number | null = null,
): PoseVerdict {
	const [first] = matches;
	if (first === undefined) return { kind: "none" };
	let chosen: ReleaseGroupCandidate | undefined = first;
	if (matches.length > 1) {
		if (entry.releaseType === undefined) {
			// An album must not take its single's mbid (TRA-560): different primary types are not guessed
			// between. One exception (TRA-625, "Giant Steps", "Imagine": MusicBrainz has the album and a
			// single of the same title): exactly one album against only singles / EPs is the album, since an
			// entry that states no type is the work, not its single. releaseType is then completed by poseOnEntry.
			// Only the groups that classifyRelease would not reject on their secondary types compete (TRA-628,
			// measured 2026-10-19: "Blue Train" and "Imagine" stayed ambiguous because of a Live / Compilation
			// album of the same title). Those Live / Compilation ones are not the entry's work and are ignored;
			// a lone Live "Hurt" next to a single "Hurt" then leaves no album to pose, identity comes first.
			const competitors = matches.filter(hasOnlyAdmittedSecondaryTypes);
			const albums = competitors.filter((m) => m.primaryType === "Album");
			const onlySinglesOrEps = competitors.every(
				(m) => m.primaryType === "Album" || m.primaryType === "Single" || m.primaryType === "EP",
			);
			const [onlyAlbum] = albums;
			if (albums.length === 1 && onlyAlbum !== undefined && onlySinglesOrEps) {
				chosen = onlyAlbum;
			} else {
				const distinctTypes = new Set(matches.map((m) => m.primaryType));
				return { kind: "ambiguous", reason: distinctTypes.size > 1 ? "type" : "multiple" };
			}
		} else {
			// An entry that states its type competes only with the release groups of that type that are its work:
			// a Live / Compilation one of the same title and type is not (TRA-629, "Hurt" typed EP next to the
			// album and a Compilation EP would have taken the compilation, for good).
			const statedType = matches.filter((m) => m.primaryType.toLowerCase() === entry.releaseType);
			const ofType = statedType.filter(hasOnlyAdmittedSecondaryTypes);
			// Every release group of the stated type is a Live / Compilation one: nothing is the entry's work.
			if (ofType.length === 0 && statedType.length > 0) return { kind: "none" };
			chosen = ofType.length === 1 ? ofType[0] : undefined;
		}
		if (chosen === undefined) return { kind: "ambiguous", reason: "multiple" };
	}
	// A single match is not enough when the entry already states its type: an "album" must not take its
	// single's mbid (TRA-560, identity first).
	if (entry.releaseType !== undefined && chosen.primaryType.toLowerCase() !== entry.releaseType) {
		return { kind: "ambiguous", reason: "type" };
	}
	const entryYear = yearOf(entry.year) ?? titleYear;
	const matchYear = yearOf(chosen.firstReleaseDate);
	if (entryYear !== null && matchYear !== null && Math.abs(entryYear - matchYear) > MAX_YEAR_DRIFT) {
		return { kind: "ambiguous", reason: "year-mismatch" };
	}
	return { kind: "pose", match: chosen };
}

// What the cautious pose of TRA-647 reads besides the entry and its candidates.
interface PoseCaution {
	// The mbid held by the entry's project node, if it has one.
	nodeMbidOf: (entry: EdgeRef) => string | undefined;
	// The artist has MIN_VOTED_FOR_UNRATED_CUT voted release groups: the same count as the unrated cut.
	ratedArtist: boolean;
	policy: DiscographyPolicy;
}

/**
 * decidePose, with a second look at an entry that states neither releaseType nor year (TRA-647, measured
 * 2026-10-20 on the cache of PR #562: 804 of 809 poses were of that kind, and 5 of them took a minor release of
 * the exact title: Kraftwerk "Trans-Europe Express" a 1999 promo single, Zappa "Joe's Garage" the single while the
 * album is "Joe's Garage Act I", Sakamoto "Vrioon" the 2022 reissue, against the mbid its node already held).
 * With no type and no year, nothing but the title backs the pose. So, in this order:
 *  1. the entry's project node holds an mbid: it is the identity. It is posed if it is among the candidates,
 *     even where several compete; otherwise nothing is posed, `node-conflict`;
 *  2. the artist is rated and the release group to pose has no vote and is not recent: nothing is posed,
 *     `unrated-pose`. A minor release rarely has votes where the real album has them; below the threshold
 *     (Kode9, 4hero) nobody has votes and the rule stays out.
 * A year or a type on the entry (or a year in its title) keeps the guards of decidePose.
 */
function decideCautiously(
	entry: EdgeRef,
	matches: readonly ReleaseGroupCandidate[],
	titleYear: number | null,
	caution: PoseCaution,
): PoseVerdict {
	const unstated = entry.releaseType === undefined && yearOf(entry.year) === null && titleYear === null;
	if (!unstated || matches.length === 0) return decidePose(entry, matches, titleYear);
	const nodeMbid = caution.nodeMbidOf(entry);
	if (nodeMbid !== undefined) {
		const held = matches.find((m) => sameMbid(m.mbid, nodeMbid));
		return held === undefined
			? { kind: "ambiguous", reason: "node-conflict" }
			: { kind: "pose", match: held };
	}
	const verdict = decidePose(entry, matches, titleYear);
	if (
		verdict.kind === "pose" &&
		caution.ratedArtist &&
		!isVoted(verdict.match) &&
		!isRecentRelease(verdict.match, caution.policy)
	) {
		return { kind: "ambiguous", reason: "unrated-pose" };
	}
	return verdict;
}

// A copy of the entry with the mbid set, and year / releaseType completed only where they were absent.
function poseOnEntry(
	entry: EdgeRef,
	match: ReleaseGroupCandidate,
): { edge: EdgeRef; filled: ("year" | "releaseType")[] } {
	const edge: EdgeRef = { ...entry, mbid: match.mbid };
	const filled: ("year" | "releaseType")[] = [];
	const year = match.firstReleaseDate.slice(0, 4);
	if ((entry.year === undefined || entry.year === "") && year !== "") {
		edge.year = year;
		filled.push("year");
	}
	const releaseType = match.primaryType.toLowerCase();
	if (
		entry.releaseType === undefined &&
		(releaseType === "album" || releaseType === "ep" || releaseType === "single")
	) {
		edge.releaseType = releaseType;
		filled.push("releaseType");
	}
	return { edge, filled };
}

// Release groups by identity key, one per mbid in a group; a title with an empty key is left out.
function groupCredited(
	credited: readonly ReleaseGroupCandidate[],
	keyOf: (title: string) => string,
): Map<string, ReleaseGroupCandidate[]> {
	const groups = new Map<string, ReleaseGroupCandidate[]>();
	for (const candidate of credited) {
		const key = keyOf(candidate.title);
		if (key === "") continue;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [candidate]);
		else if (!group.some((other) => sameMbid(other.mbid, candidate.mbid))) group.push(candidate);
	}
	return groups;
}

/**
 * Pure merge of MusicBrainz release groups into an artist's existing discography (graph-integrity plan,
 * part 8, 8-D3). It adds and poses, it never removes: an existing entry keeps its `name`, `slug` and
 * `artist` and only gains an `mbid` (exact normalized-title match, else the same title up to a trailing year or
 * "EP", see reconciliationKey and decidePose) plus a `year` / `releaseType` it lacked. An entry that states
 * neither a year nor a releaseType is posed more carefully (decideCautiously, TRA-647). Release groups missing
 * from the list are appended up to `policy.cap`, as the very edge `toDiscographyEdge` builds; only the slug
 * is replaced when a project node already exists for the mbid (or a redirect leads to one). A candidate whose title extends, or is extended by, that of an
 * entry still without mbid is added anyway but flagged `nearDuplicateOf`: we measure, we do not reconcile.
 * Candidates without an mbid or outside Album / EP / Single are not added. An untouched list comes back
 * as the same array, with `changed: false`.
 */
export function mergeDiscography(input: MergeInput): MergeResult {
	const { existing, candidates, policy, projectIndex } = input;
	// TRA-647 (measured 2026-10-20: Ellington's "Black, Brown and Beige" took the mbid of a 2013 recording credited to
	// three artists): a release group the artist does not head is somebody else's work, whatever its title, and its
	// mbid never becomes the identity of an entry. Only the credit filters here: the secondary types keep the
	// treatment they have in decidePose (a Live release group is still posed on its entry).
	const allCredited = input.allCredited.filter((c) => creditVerdict(c, policy) === null);

	const creditedByTitle = groupCredited(allCredited, normalizeTitleBody);
	// TRA-629: the same release groups under the looser key. It is only consulted when the exact title finds
	// nothing, so what posed before keeps posing the same way.
	const creditedByKey = groupCredited(allCredited, reconciliationKey);
	// The looser key never gives an mbid that another title already holds: the ones on existing entries, then the
	// ones the exact-title pass posed (a v3 run may have added "Ladies' Night" next to a legacy "Ladies' Night
	// (1979)"). Entries of the very same title are not affected: each of them is posed, none is removed.
	const heldMbids = new Set(existing.flatMap((e) => (hasMbid(e) ? [(e.mbid ?? "").toLowerCase()] : [])));
	const caution: PoseCaution = {
		nodeMbidOf: (entry) => {
			const mbid = projectIndex.mbidBySlug.get(projectIndex.resolveSlug(entry.slug));
			return mbid === undefined || mbid === "" ? undefined : mbid;
		},
		// Counted on `candidates`, the kept list of selectReleases, whose cut counts the very same voted release groups.
		ratedArtist:
			new Set(candidates.filter(isVoted).map((c) => c.mbid.toLowerCase())).size >= MIN_VOTED_FOR_UNRATED_CUT,
		policy,
	};

	// Two passes, so that the pose does not depend on the order of `existing`: every exact-title pose first, over
	// all the entries, then the looser ones among what is left.
	const verdicts: (PoseVerdict | undefined)[] = existing.map(() => undefined);
	existing.forEach((entry, index) => {
		if (hasMbid(entry)) return;
		const group = creditedByTitle.get(normalizeTitleBody(entry.name)) ?? [];
		if (group.length === 0) return;
		const verdict = decideCautiously(entry, group, null, caution);
		verdicts[index] = verdict;
		if (verdict.kind === "pose") heldMbids.add(verdict.match.mbid.toLowerCase());
	});

	// The looser pass judges each entry on its own, with the very resolution of the exact pass (TRA-625 / 628:
	// one album admitted against singles and EPs, Live and Compilation ignored), against the whole group of
	// release groups sharing its key, held mbids included: removing a held one first would turn "two release
	// groups" into a confident pose on the other (TRA-629, "Ladies' Night (1979)" next to a twin holding the
	// album and a "Ladies' Night EP"). A pose on a release group whose mbid is held leaves the entry as it is.
	// An entry whose title ended with "EP" (the suffix the key removed) can only be an EP: its candidates are the
	// admitted EPs of the group (Live / Compilation ones are not its work, TRA-628), and never the album or the
	// single of the same title. One is posed, several are `multiple`, none leaves the entry as it is. No
	// releaseType is forced on the entry: the typed branch of decidePose does not filter secondary types.
	const looserVerdicts = new Map<number, PoseVerdict>();
	existing.forEach((entry, index) => {
		if (hasMbid(entry) || verdicts[index] !== undefined) return;
		const peeled = peelSuffixes(entry.name);
		const group = creditedByKey.get(normalizeTitleBody(peeled.rest)) ?? [];
		let verdict: PoseVerdict;
		if (peeled.ep) {
			const eps = group.filter((c) => c.primaryType === "EP" && hasOnlyAdmittedSecondaryTypes(c));
			verdict = decideCautiously(entry, eps, peeled.year, caution);
		} else {
			verdict = decideCautiously(entry, group, peeled.year, caution);
		}
		const held = verdict.kind === "pose" && heldMbids.has(verdict.match.mbid.toLowerCase());
		looserVerdicts.set(index, held ? { kind: "none" } : verdict);
	});
	// Two entries that the looser key sends to the same release group have no better claim than each other:
	// neither is posed, both are reported, whatever their order in `existing`.
	const claims = new Map<string, number>();
	for (const verdict of looserVerdicts.values()) {
		if (verdict.kind !== "pose") continue;
		const mbid = verdict.match.mbid.toLowerCase();
		claims.set(mbid, (claims.get(mbid) ?? 0) + 1);
	}
	for (const [index, verdict] of looserVerdicts) {
		const contested = verdict.kind === "pose" && (claims.get(verdict.match.mbid.toLowerCase()) ?? 0) > 1;
		verdicts[index] = contested ? { kind: "ambiguous", reason: "multiple" } : verdict;
	}

	const posed: MergeResult["posed"] = [];
	const ambiguous: MergeResult["ambiguous"] = [];
	const afterPose = existing.map((entry, index) => {
		const verdict = verdicts[index];
		if (verdict === undefined) return entry;
		if (verdict.kind === "ambiguous") ambiguous.push({ slug: entry.slug, reason: verdict.reason });
		if (verdict.kind !== "pose") return entry;
		const { edge, filled } = poseOnEntry(entry, verdict.match);
		posed.push({ slug: entry.slug, mbid: verdict.match.mbid, filled });
		return edge;
	});

	const takenMbids = new Set(afterPose.flatMap((e) => (e.mbid ? [e.mbid.toLowerCase()] : [])));
	const takenBodies = new Set(existing.map((e) => normalizeTitleBody(e.name)).filter((body) => body !== ""));
	const takenSlugs = new Set<Slug>(existing.map((e) => e.slug));
	const unmatched = afterPose
		.filter((e) => !hasMbid(e))
		.map((e) => ({ slug: e.slug, body: normalizeTitleBody(e.name) }));
	// An entry reported ambiguous is not settled: a release group that only its suffix tells apart from it is not
	// added next to it, the twin would be permanent (TRA-629). Every other entry is settled, posed or not: one
	// whose mbid is held by its twin is the twin's duplicate, and "Mirage EP" next to a posed "Mirage" is
	// another release group.
	const takenKeys = new Set(
		afterPose.flatMap((e, index) =>
			verdicts[index]?.kind === "ambiguous" ? [reconciliationKey(e.name)] : [],
		),
	);
	takenKeys.delete("");

	const additions: EdgeRef[] = [];
	const added: MergeResult["added"] = [];
	let capReached = false;
	// selectReleases(...).kept comes back newest first across types, which would let recent singles and
	// bootlegs use up the last slots before older albums (the A$AP Rocky failure the policy exists for): the
	// additions take the same priority as the cap of selectReleases (voted first, then album / EP / single,
	// votes, oldest), the sort is deterministic (TRA-625).
	const byPriority = [...candidates].sort(byCapPriority);
	for (const candidate of byPriority) {
		if (candidate.mbid === "" || takenMbids.has(candidate.mbid.toLowerCase())) continue;
		const body = normalizeTitleBody(candidate.title);
		if (takenBodies.has(body)) continue;
		if (takenKeys.has(reconciliationKey(candidate.title))) continue;
		const base = toDiscographyEdge(candidate, policy);
		if (base === null || base.releaseType === undefined) continue;
		const slug =
			projectIndex.byMbid.get(candidate.mbid) ??
			projectIndex.byMbid.get(candidate.mbid.toLowerCase()) ??
			projectIndex.resolveSlug(base.slug);
		// An album and a single of the same title are one project node: two entries must never share a slug.
		if (takenSlugs.has(slug)) continue;
		if (existing.length + additions.length >= policy.cap) {
			capReached = true;
			break;
		}
		additions.push({ ...base, slug });
		takenMbids.add(candidate.mbid.toLowerCase());
		takenSlugs.add(slug);
		if (body !== "") takenBodies.add(body);
		const near = unmatched.find((u) => opensWith(body, u.body) || opensWith(u.body, body));
		added.push({
			slug,
			mbid: candidate.mbid,
			title: base.name,
			...(base.year === undefined ? {} : { year: base.year }),
			releaseType: base.releaseType,
			...(near === undefined ? {} : { nearDuplicateOf: near.slug }),
		});
	}

	if (posed.length === 0 && added.length === 0) {
		return { edges: existing as EdgeRef[], changed: false, posed, added, ambiguous, capReached };
	}
	const edges = orderDiscography([...afterPose, ...additions]);
	return { edges, changed: true, posed, added, ambiguous, capReached };
}
