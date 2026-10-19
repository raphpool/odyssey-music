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
import { makeScopedSlug } from "./slug.js";
import type { EdgeRef } from "./types.js";

export interface ReleaseGroupCandidate {
	mbid: string;
	title: string;
	firstReleaseDate: string; // "" when MusicBrainz has none
	primaryType: string; // "Album" | "EP" | "Single" | other
	secondaryTypes: string[];
	artistCredits: { mbid: string; name: string }[]; // MusicBrainz order
}

export interface DiscographyPolicy {
	artistMbid: string;
	artistName: string;
	cap: number;
}

export const DEFAULT_DISCOGRAPHY_CAP = 40;
export const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

export type ExclusionReason =
	| "secondary-type"
	| "primary-type"
	| "credit"
	| "various-artists"
	| "non-canonical";

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

// MBIDs are UUIDs: case carries no meaning, and a hand-supplied upper-case id must not exclude a whole
// discography as a "credit" mismatch.
function sameMbid(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

function isKeptPrimaryType(type: string): type is KeptPrimaryType {
	return (KEPT_PRIMARY_TYPES as readonly string[]).includes(type);
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
	if (c.secondaryTypes.length > 0) return { ok: false, reason: "secondary-type" };
	if (c.artistCredits.some((credit) => sameMbid(credit.mbid, VARIOUS_ARTISTS_MBID))) {
		return { ok: false, reason: "various-artists" };
	}
	const firstCredit = c.artistCredits[0];
	if (firstCredit === undefined || !sameMbid(firstCredit.mbid, policy.artistMbid)) {
		return { ok: false, reason: "credit" };
	}
	if (c.artistCredits.length > MAX_CREDITS) return { ok: false, reason: "credit" };
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

/**
 * Filters with classifyRelease, collapses release groups that share a project slug, then applies the cap: all albums first (newest first, up to the cap), then
 * EPs, then singles. Duplicates are collapsed before the cap so they never use up room. `kept` comes back ordered newest first across types. `excluded` lists policy
 * rejections only; candidates dropped by the cap are not reported (the cap is not an ExclusionReason).
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
	const kept: ReleaseGroupCandidate[] = [];
	for (const primaryType of KEPT_PRIMARY_TYPES) {
		const room = policy.cap - kept.length;
		if (room <= 0) break;
		const ofType = distinct.filter((c) => c.primaryType === primaryType).sort(byNewestFirst);
		kept.push(...ofType.slice(0, room));
	}
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
