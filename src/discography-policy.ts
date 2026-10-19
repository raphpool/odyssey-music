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
import { makeScopedSlug, normalizeTitleBody } from "./slug.js";
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
}

export interface DiscographyPolicy {
	artistMbid: string;
	artistName: string;
	cap: number;
}

export const DEFAULT_DISCOGRAPHY_CAP = 40;

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

export interface MergeInput {
	existing: readonly EdgeRef[]; // the artist's current discography
	candidates: readonly ReleaseGroupCandidate[]; // selectReleases(...).kept: what may be added
	// Every release group first-credited to the artist, any type: what an mbid may be posed from.
	allCredited: readonly ReleaseGroupCandidate[];
	policy: DiscographyPolicy;
	projectIndex: { byMbid: ReadonlyMap<string, Slug>; resolveSlug: (slug: Slug) => Slug };
}

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
	ambiguous: { slug: Slug; reason: "multiple" | "type" | "year-mismatch" }[];
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
	| { kind: "ambiguous"; reason: "multiple" | "type" | "year-mismatch" }
	| { kind: "pose"; match: ReleaseGroupCandidate };

function decidePose(entry: EdgeRef, matches: readonly ReleaseGroupCandidate[]): PoseVerdict {
	const [first] = matches;
	if (first === undefined) return { kind: "none" };
	let chosen: ReleaseGroupCandidate | undefined = first;
	if (matches.length > 1) {
		if (entry.releaseType === undefined) {
			// An album must not take its single's mbid (TRA-560): different primary types are not guessed between.
			const distinctTypes = new Set(matches.map((m) => m.primaryType));
			return { kind: "ambiguous", reason: distinctTypes.size > 1 ? "type" : "multiple" };
		}
		const ofType = matches.filter((m) => m.primaryType.toLowerCase() === entry.releaseType);
		chosen = ofType.length === 1 ? ofType[0] : undefined;
		if (chosen === undefined) return { kind: "ambiguous", reason: "multiple" };
	}
	const entryYear = yearOf(entry.year);
	const matchYear = yearOf(chosen.firstReleaseDate);
	if (entryYear !== null && matchYear !== null && Math.abs(entryYear - matchYear) > MAX_YEAR_DRIFT) {
		return { kind: "ambiguous", reason: "year-mismatch" };
	}
	return { kind: "pose", match: chosen };
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

/**
 * Pure merge of MusicBrainz release groups into an artist's existing discography (graph-integrity plan,
 * part 8, 8-D3). It adds and poses, it never removes: an existing entry keeps its `name`, `slug` and
 * `artist` and only gains an `mbid` (exact normalized-title match, see decidePose) plus a `year` /
 * `releaseType` it lacked. Release groups missing from the list are appended up to `policy.cap`, as the
 * very edge `toDiscographyEdge` builds; only the slug is replaced when a project node already exists for
 * the mbid (or a redirect leads to one). A candidate whose title extends, or is extended by, that of an
 * entry still without mbid is added anyway but flagged `nearDuplicateOf`: we measure, we do not reconcile.
 * Candidates without an mbid or outside Album / EP / Single are not added. An untouched list comes back
 * as the same array, with `changed: false`.
 */
export function mergeDiscography(input: MergeInput): MergeResult {
	const { existing, candidates, allCredited, policy, projectIndex } = input;

	const creditedByTitle = new Map<string, ReleaseGroupCandidate[]>();
	for (const credited of allCredited) {
		const body = normalizeTitleBody(credited.title);
		if (body === "") continue;
		const group = creditedByTitle.get(body);
		if (group === undefined) creditedByTitle.set(body, [credited]);
		else if (!group.some((other) => sameMbid(other.mbid, credited.mbid))) group.push(credited);
	}

	const posed: MergeResult["posed"] = [];
	const ambiguous: MergeResult["ambiguous"] = [];
	const afterPose = existing.map((entry) => {
		if (hasMbid(entry)) return entry;
		const verdict = decidePose(entry, creditedByTitle.get(normalizeTitleBody(entry.name)) ?? []);
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

	const additions: EdgeRef[] = [];
	const added: MergeResult["added"] = [];
	let capReached = false;
	// selectReleases(...).kept comes back newest first across types, which would let recent singles use up the
	// last slots before older albums (the A$AP Rocky failure the policy exists for): albums, then EPs, then
	// singles, keeping the given order within a type (the sort is stable).
	const byType = [...candidates].sort((a, b) => additionRank(a) - additionRank(b));
	for (const candidate of byType) {
		if (candidate.mbid === "" || takenMbids.has(candidate.mbid.toLowerCase())) continue;
		const body = normalizeTitleBody(candidate.title);
		if (takenBodies.has(body)) continue;
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
