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
import { makeScopedSlug, pickScopeArtistName } from "./slug.js";
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
// Optional plural ("Club Mixes", "Radio Edits"); a whole-word match keeps "(Deluxe Edition)" out, since
// "edit" is only a substring of "edition".
const VARIANT_MARKER = new RegExp(
	`${WORD_EDGE_BEFORE}(?:edit|mix|dub|version|instrumental|acapella|remix)(?:e?s)?${WORD_EDGE_AFTER}`,
	"u",
);

function normalizeTitle(title: string): string {
	return title.normalize("NFKD").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * True for titles that name a variant or a repackaging rather than a work of the artist: remix / mashup /
 * bootleg / sampler / karaoke / best-of words anywhere, "The (Very) Best of" prefixes, or a trailing
 * "(... edit)" / "[... mix]" style qualifier.
 */
export function isNonCanonicalReleaseTitle(title: string): boolean {
	const normalized = normalizeTitle(title);
	if (NON_CANONICAL_WORDS.test(normalized)) return true;
	if (NON_CANONICAL_PREFIX.test(normalized)) return true;
	const trailing = TRAILING_BRACKET.exec(normalized);
	return trailing !== null && VARIANT_MARKER.test(trailing[1] ?? "");
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

/**
 * Filters with classifyRelease, then applies the cap: all albums first (newest first, up to the cap), then
 * EPs, then singles. `kept` comes back ordered newest first across types. `excluded` lists policy
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

	const kept: ReleaseGroupCandidate[] = [];
	for (const primaryType of KEPT_PRIMARY_TYPES) {
		const room = policy.cap - kept.length;
		if (room <= 0) break;
		const ofType = eligible.filter((c) => c.primaryType === primaryType).sort(byNewestFirst);
		kept.push(...ofType.slice(0, room));
	}
	return { kept: kept.sort(byNewestFirst), excluded };
}

/** The project edge for a kept release group, or null when no scoped slug can be built from its title. */
export function toDiscographyEdge(c: ReleaseGroupCandidate, policy: DiscographyPolicy): EdgeRef | null {
	const scopeArtist = pickScopeArtistName([policy.artistName]) ?? policy.artistName;
	const slug = makeScopedSlug("project", c.title, scopeArtist);
	if (!slug.ok) return null;
	const edge: EdgeRef = { slug: slug.slug, type: "project", name: c.title, mbid: c.mbid };
	if (c.firstReleaseDate !== "") edge.year = c.firstReleaseDate.slice(0, 4);
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
