/**
 * Flagship album and reference track backfill (TRA-491, plan docs/plans/graph-integrity.md, part 5): give
 * every artist that has none a `landmark_project` and a `reference_track`, chosen WITHOUT an LLM and
 * offline among the edges the artist already carries (decision 7: re-calling Gemini for 581 nodes was
 * rejected). The rule is readable in the manifest, entry by entry.
 *
 * RULE v2 (TRA-601, 2026-10-17). The first rule (PR #520: genre landmark / imaged / cached, a tie goes to
 * the first of the list) was measured on a copy of the cache on 2026-10-17 and gave four bad PRODUCT choices,
 * while a choice, once written, is final (idempotence) and this script had not been applied anywhere. The
 * rule is therefore changed in place, the migration keeps its name. Each signal exists for one symptom:
 *   - `first` was the MOST RECENT release (discographies are sorted by year, newest first): 342 choices had
 *     no signal, 76 of them in 2024-2026, and in 78 cases a single although the list holds an album (Daft
 *     Punk -> "Veridis Quo", a 2024 single; Dr. Dre -> a 2025 single). Hence `album` and the OLDEST year.
 *   - a title quoted in the artist's own article is the strongest editorial signal the cache has about what
 *     the artist is known for (`mentioned`): Selected Ambient Works 85-92 for Aphex Twin, Imagine for
 *     Lennon, Zombie for Fela, instead of whatever came first.
 *   - multi-artist compilations became an artist's flagship (Artificial Intelligence for Aphex Twin, Richie
 *     Hawtin and B12; Saturday Night Fever for Kool & the Gang; Techno! The New Dance Sound of Detroit for
 *     Juan Atkins), and a sideman got the leader's record (Kind of Blue, imaged, for Coltrane). Hence the
 *     `compilation` exclusion: the dispatcher's decision of 2026-10-17, reversible by Raphael (journal of
 *     docs/plans/graph-integrity.md).
 *   - works named after an artist (project:the-beatles and track:the-beatles, two nodes that describe the
 *     group) became the album AND the reference track of the 4 Beatles: such an entry gets no signal.
 *
 * For each artist WITHOUT `landmark_project` and with a non-empty `discography`, the entries are first
 * filtered by the identity rules below, then every eligible entry is scored:
 *   +100 per genre of the cache whose `landmark_projects` lists the entry's slug  (reason `genreLandmark`)
 *   +50  when the entry's title is quoted in the artist's article                   (reason `mentioned`)
 *   +20  when the edge (or the cached target) is an `album`                         (reason `album`)
 *   +10  when the target is in the cache and has an `image_url`                    (reason `imaged`)
 *   +1   when the target is in the cache                                           (reason `cached`)
 * The highest score wins; a tie goes to the OLDEST year (an entry without a year comes after those with
 * one), then to the first of the list. The reason is the strongest signal the winner has, in the order
 * above, `first` when it has none. Same rule for `reference_track` over `notable_tracks` and the genres'
 * `landmark_tracks`, without `album`, without the compilation exclusion, and a tie goes to the first of the
 * list. The chosen edge is copied as is (slug, name, mbid, artist, ...) from the artist's OWN list: nothing
 * is invented and no other node is read for its edges.
 * `mentioned`: title and text are normalized the same way (NFKD, ASCII only, lowercase, punctuation becomes
 * a space, spaces collapsed; see normalizeText) and the title must appear as a WHOLE expression,
 * bounded by spaces, in the normalized text ("homework" is not found in "homeworkers"). A title of fewer
 * than 3 characters, made only of 4 digits (a year), or equal to the name of an artist or of a genre of the
 * cache, never counts. Before the lookup the article loses the artist's name, its aliases and the genres'
 * names (whole expressions, except those the title itself contains), found by the review of 2026-10-17:
 * "Chuck Berry" quoted the title Chuck, "argentine tango" Tango (Carlos Gardel), "acid house" Acid
 * (Dougal), "released in 2010" the title 2010 (Earl Sweatshirt). The article comes from an LLM, so it is
 * untrusted: it only feeds a score, nothing taken from it is ever written.
 * Name downgrade: an entry whose normalized title equals the normalized name of an artist of the cache
 * (any artist: a self-titled work is a work named after an artist too) receives NO signal (score 0) and
 * comes after every other entry on a tie. Not when its resolved slug is scoped on THE artist
 * (project:skream--skream, project:inside--paul-horn): that work is the artist's own, the name collision is
 * only apparent (review of 2026-10-17).
 *
 * RULE v3 (TRA-601, 2026-10-17, after the review of the repository run, #528, which found 13 bad choices
 * among 976; a choice is final, so the rule is tightened once more BEFORE any run). Three changes:
 *   1. `non-canonical` exclusion, both fields, after the identity and compilation rules: a title that
 *      contains as a whole expression a remix, a mix, a best-of or a bootleg (NON_CANONICAL_PHRASES), a
 *      "the best of" / "the very best of" at its head (NON_CANONICAL_LEADING_PHRASES), or a soundtrack
 *      marker in parentheses or at the end of the title (NON_CANONICAL_TRAILING_PHRASES), is not the
 *      artist's canonical work. Live recordings are NOT excluded. Symptom: Bee Gees ->
 *      "Saturday Night Fever (soundtrack)", a duplicate of the excluded compilation outside the cache;
 *      Suprême NTM -> "Anthologie"; Stuart Sutcliffe -> "Anthology 1"; Beppe Loda -> "... Rmx"; Nazira ->
 *      "... DJ set"; Plaid -> "Maru (Skee Mask Remix)". `mix` alone is not in the list: "Mix-Up" (Cabaret
 *      Voltaire) is a studio album.
 *   2. A sole option without support is no choice, in two cases only: when exactly one eligible entry is
 *      left, its score is 0 and (a) it is downgraded as named after an artist (both fields: Emperor's
 *      track:emperor), or (b) for `landmark_project` only, its edge is a `single` (Killer Kau's one single
 *      of 2021: a lone single is not a flagship album). Nothing is chosen, the artist goes to `skipped` for
 *      that field and the manifest lists it in `soleUnsupported`. A sole entry without a signal that is
 *      none of these stays chosen (Juan Atkins' Enter, Richie Hawtin's Plasticity: legitimate, only
 *      unverifiable). A first draft refused every sole entry without a signal: 66 fields instead of a
 *      handful, so it was narrowed (coordinator, 2026-10-17). This replaces v2's "chosen when it is the
 *      only one" for an entry named after an artist.
 *   3. A verified self-titled record is not downgraded: when the title is the name (or an alias) of THE
 *      artist and the resolved target is in the cache and credits it, the name downgrade does not apply
 *      (project:supreme-ntm, 1998, lost to a best-of). It stays for the name of ANOTHER artist (The Beatles
 *      for Lennon) and for a self-titled record that cannot be verified.
 *
 * Identity, safety before rate (2026-10-17, same family of defect as the homonyms of TRA-570 / TRA-561): an
 * artist's `discography` / `notable_tracks` can list a work that belongs to somebody else with the same
 * name. A flagship that points at another artist's album is worse than none, so:
 *   - an entry whose target is in the cache and does NOT credit the artist (`artists` holds neither the
 *     artist's slug nor an artist edge with the same non-empty mbid, the rule of `reciprocates`,
 *     src/images/reciprocity.ts) is EXCLUDED from the choice, whatever its score, and listed in
 *     `excluded`; so is a target whose file cannot be read (it cannot be shown to credit anyone);
 *     EXCEPTION (TRA-601, 2026-10-17): a cached target whose `artists` is EMPTY is an absence of proof, not a
 *     proof of a foreign credit, so it stays eligible when ALL of these hold: (1) its title is `mentioned` in
 *     the artist's article; (2) its resolved slug is not scoped on somebody else (a `--bob-dylan` scope IS a
 *     foreign credit: the Byrds -> Dylan case); (3) its OWN text (`editorial_article`, `editorial_pitch` or
 *     `editorial_teaser`) names the artist or an alias, as a whole expression. Symptom: the rule above
 *     excluded project:selected-ambient-works-85-92 (`artists: []`, no mbid) and Aphex Twin fell back to
 *     Windowlicker; but with (1) alone the review of the same day brought back homonyms, whose title is
 *     identical by definition: DFRNT's Fading for Pole, the rapper Germ's Every Dog Has Its Day for
 *     Millsart, the Baltimore punk trio The Wayward for Harry Partch. A target that credits ANOTHER artist
 *     stays excluded, quoted or not (Moderat -> "II" of Boyz II Men, Juan Atkins -> "Clear"). A kept
 *     target never gets the `cached` point (it was not shown to credit the artist), keeps the other
 *     signals (the identity is attested on both sides), and its pick carries `emptyCredit: true`.
 *   - the "referenced by a genre" and "imaged" signals only count for a target that credits the artist
 *     (or is kept by the exception above);
 *   - a target that is not in the cache and is not redirected cannot be checked: it stays eligible, with no
 *     identity signal (it can still be `mentioned` or an `album`: both come from the artist's own data, so
 *     an entry that could not be checked can outrank a verified one: accepted by TRA-601, the reason is in
 *     the manifest, and Homework for Daft Punk is such a case).
 * COMPILATION (TRA-601, `landmark_project` only, AFTER the identity rules): a resolved target that is in the
 * cache, credits 3 artists or more (distinct slugs) and whose slug is NOT scoped on the artist is excluded
 * (`compilation`). Kind of Blue stays for Miles Davis (project:kind-of-blue--miles-davis), not for Coltrane.
 * REDIRECTS (2026-10-17, deep review of PR #520): every candidate is resolved the way the reads resolve it
 * (`resolveReadSlug`: a live cache node wins, otherwise one hop of data/genre-redirects.json +
 * data/slug-redirects.json). A redirected target that is absent from the cache is NOT "unknown": the front
 * and GET /node open the work it redirects to, which may belong to a homonym (artist:the-byrds ->
 * track:mr-tambourine-man -> track:mr-tambourine-man--bob-dylan). So: when the resolved node is in the
 * cache, the credit rule applies to THAT node (and the genre / image signals are read on it); when it is
 * not, the entry is excluded (`redirected`), unless the redirect lands on a slug scoped on the artist
 * itself (`--<artist slug body or name>`), which stays eligible with a score of 0. The tables are read
 * from `--data-dir` (the channel's scratch copy) or else the repo's data/; an unreadable or invalid
 * table, or a missing slug table when `--data-dir` is given, refuses the run before any write (fail
 * closed). The edge copied keeps the slug of the artist's own list, NOT the resolved one: the pipeline
 * requires the pick to be a member of its list compared by slug (enforceArtistChoices, TRA-470: a pick
 * that is not becomes the list's first entry), and the scope migration moves a list entry and the pick
 * together (CREDITED_FIELDS, 2026-10-16-scope-release-slugs.ts) so that they stay equal. Rewriting only
 * the pick would break both.
 * When every entry is excluded the artist goes to `skipped` for that field, like an empty list.
 * ORDER (precondition): the credit is read on the target's `artists`, which the identity migrations
 * (artist and release identity, scope) and the reverse-edge backfill (2026-10-17) fill in. Run on a cache
 * where those are not applied, a work that really belongs to the artist can look "not credited" and be
 * excluded; that costs rate, never safety. But a pick, once written, is final (idempotence: an artist that
 * has the field is never revisited), so run this AFTER those migrations, not before.
 *
 * An artist that already has the field is never touched; the node's other fields are not either (only
 * `landmark_project` and `reference_track` are added, plus the schema's own default `similar_artists: []`
 * on a node that did not carry it, which validation adds to every artist it writes: onlyAddsSchemaDefaults
 * lets that one through and nothing else), so a second run changes nothing. Writes go through
 * atomicWriteJson after nodePayloadSchema validation, never NodeCache.write (which would emit reverse
 * edges); a write that validation would alter is refused and the artist listed in `failed` (exit 1).
 * Pure and offline: no network call, no clock.
 *
 * Manifest: deterministic (sorted, no timestamp), the same in a dry-run, an apply and a re-run on a copy.
 * It carries the migration channel's constants (`migration`, `removed: []`, `renamed: {}`,
 * `redirects: {}`). Counters are per field because the two choices are independent (an artist can get a
 * flagship but no reference track). A re-run on an already filled cache has an empty `picks`: the manifest
 * is the same only for the same input. Migration channel (deploy/sync-genre-cache.sh): `--apply`,
 * `--manifest` and `--data-dir` are the flags it passes; `--data-dir` is where the redirect tables are read.
 *
 * Usage: tsx scripts/migrations/2026-10-19-backfill-landmark-highlights.ts <cache-dir> [--apply]
 *        [--manifest out/landmark.json] [--data-dir <dir>]
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, NodeCache } from "../../src/cache.js";
import { loadRedirects, resolveReadSlug } from "../../src/genre-registry.js";
import { reciprocity, type Work } from "../../src/images/reciprocity.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { parseSlug, scopeMatchesArtist, scopeOf } from "../../src/slug.js";
import type { NodePayload, Slug } from "../../src/types.js";
import {
	isRecord,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./2026-10-15-backfill-artist-identity.js";

export const MIGRATION_NAME = "2026-10-19-backfill-landmark-highlights";
export const DEFAULT_MANIFEST_PATH = "out/landmark.json";

/**
 * RULE v3 (TRA-601, 2026-10-17): releases that are not the artist's canonical work, recognised by their TITLE
 * (the artist's own edge). A normalized title that contains one of these as a WHOLE expression is excluded
 * (`non-canonical`), for both fields, after the identity and compilation rules. Symptom (review of the
 * repository run, #528): Bee Gees -> "Saturday Night Fever (soundtrack)", Suprême NTM -> "Anthologie",
 * Stuart Sutcliffe -> "Anthology 1", Beppe Loda -> "... Rmx", Nazira -> "Nazira DJ set - Miller Mix",
 * Plaid -> "Maru (Skee Mask Remix)". The list is deliberately short and exact: `mix` alone is NOT in it
 * (Cabaret Voltaire's "Mix-Up" is a studio album), nor `live`, `best`, `collection`. `live at` was in the
 * first draft and was taken out (coordinator, 2026-10-17): Live at the Apollo (James Brown) and Live at
 * the Paradise Garage (Larry Levan) are the real landmarks of their artists.
 */
export const NON_CANONICAL_PHRASES = [
	// a remix
	"remix",
	"remixes",
	"remixed",
	"rmx",
	// a mix
	"dj set",
	"dj mix",
	"mixed by",
	"megamix",
	"medley",
	// a best-of
	"anthology",
	"anthologie",
	"greatest hits",
	// a bootleg
	"bootleg",
] as const;

/**
 * "Best of" markers, which only count at the HEAD of the title: "The Best of ..." and "The Very Best of ..."
 * are compilations. A "best of" elsewhere is not: Opolopo's "Best Of Both Worlds" is a studio album. Accepted
 * and documented false positive: João Gilberto's "The Best of Two Worlds", a studio album, is excluded.
 */
export const NON_CANONICAL_LEADING_PHRASES = ["the best of", "the very best of"] as const;

/**
 * Soundtrack markers, which only count between parentheses / brackets or at the END of the title: "Dune
 * (Original Motion Picture Soundtrack)" and "Saturday Night Fever: The Original Movie Soundtrack" are
 * soundtracks, "Soundtrack to My Life" and "Ostrich" are not.
 */
export const NON_CANONICAL_TRAILING_PHRASES = ["soundtrack", "original motion picture", "ost"] as const;

/** The two fields this migration may add, the artist list each is chosen in, and the genre list that signals it. */
export const HIGHLIGHT_FIELDS = [
	{ field: "landmark_project", list: "discography", genreList: "landmark_projects" },
	{ field: "reference_track", list: "notable_tracks", genreList: "landmark_tracks" },
] as const;
export type HighlightField = (typeof HIGHLIGHT_FIELDS)[number]["field"];

export const REASONS = ["genreLandmark", "mentioned", "album", "imaged", "cached", "first"] as const;
export type Reason = (typeof REASONS)[number];

export const EXCLUSION_REASONS = [
	"not-credited",
	"redirected",
	"unreadable",
	"compilation",
	"non-canonical",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface HighlightPick {
	artist: string;
	field: HighlightField;
	target: string;
	reason: Reason;
	score: number;
	/** Present (true) only when the target has an empty credit and was kept because the article quotes it. */
	emptyCredit?: true;
}

export interface Exclusion {
	artist: string;
	field: HighlightField;
	target: string;
	reason: ExclusionReason;
}

export interface LandmarkManifest {
	/** The channel's manifest contract (TRA-568): this migration deletes and renames nothing. */
	migration: string;
	removed: string[];
	renamed: Record<string, string>;
	redirects: Record<string, string>;
	/** Edges chosen (and written by an apply), per field. */
	written: Record<HighlightField, number>;
	byReason: Record<HighlightField, Record<Reason, number>>;
	/** Artists left without the field: an empty list, or every entry excluded. */
	skipped: Record<HighlightField, string[]>;
	/**
	 * Artists whose only eligible entry had no signal at all: nothing chosen (rule v3). They are also in
	 * `skipped` for that field.
	 */
	soleUnsupported: { artist: string; field: HighlightField; target: string }[];
	/** Entries kept out of the choice: not credited, unreadable, redirected, a compilation or non-canonical. */
	excluded: Exclusion[];
	/** Every choice, with the score that decided it. */
	picks: HighlightPick[];
	/** Artists left untouched because they could not be read, validated or written safely. */
	failed: { slug: string; reason: string }[];
}

// --- Pure choice ---

/** What the cache says about the target of an entry, as far as the artist's identity is concerned. */
export type TargetState =
	| { kind: "absent" }
	| { kind: "unreadable" }
	| { kind: "uncredited" }
	/** Redirected to a node absent from the cache and not scoped on the artist: the reads open somebody's work. */
	| { kind: "redirected" }
	/** Credits 3 artists or more and is not scoped on this one (landmark_project only, after the identity rules). */
	| { kind: "compilation" }
	/** The title says it is a remix, a mix, a soundtrack, a best-of or a bootleg (rule v3). */
	| { kind: "non-canonical" }
	| { kind: "credited"; imaged: boolean };

export interface Candidate {
	/** The artist's own edge, copied as is when chosen. */
	edge: Record<string, unknown>;
	slug: string;
	state: TargetState;
	/** How many genres of the cache list this slug in their landmark list. */
	genres: number;
	/** The title is quoted in the artist's article (see mentionedIn): a signal of the artist's own data. */
	mentioned: boolean;
	/** The edge, or the cached target, is an `album`. Never set for a track. */
	album: boolean;
	/** The title is the name of an artist of the cache: no signal at all, and last on a tie. */
	namedAfterArtist: boolean;
	/** The target has an empty credit and is kept only because the artist's article quotes its title. */
	emptyCredit: boolean;
	/** Release year of the edge; null when it has none that reads as a year. */
	year: number | null;
	/** The edge says this is a `single` (landmark_project only: a lone single is not a flagship album). */
	single: boolean;
}

export type Choice =
	| { kind: "empty" }
	| { kind: "all-excluded"; excluded: { slug: string; reason: ExclusionReason }[] }
	/** One eligible entry is left and it has no signal at all (score 0): nothing is chosen (rule v3). */
	| { kind: "sole-unsupported"; slug: string; excluded: { slug: string; reason: ExclusionReason }[] }
	| {
			kind: "chosen";
			edge: Record<string, unknown>;
			slug: string;
			reason: Reason;
			score: number;
			emptyCredit: boolean;
			excluded: { slug: string; reason: ExclusionReason }[];
	  };

/**
 * Score and reason of an ELIGIBLE candidate (absent or credited). The genre, image and cache signals count
 * only for a target that credits the artist; `mentioned` and `album` come from the artist's own data and
 * also count for a target that is not in the cache. An entry named after an artist has no signal at all.
 */
export function scoreOf(c: Candidate): { score: number; reason: Reason } {
	if (c.namedAfterArtist) return { score: 0, reason: "first" };
	const credited = c.state.kind === "credited";
	const genres = credited ? c.genres : 0;
	const imaged = c.state.kind === "credited" && c.state.imaged;
	// A target kept by the empty-credit gate was never shown to credit the artist: it is not "cached" for it.
	const cached = credited && !c.emptyCredit;
	const score =
		genres * 100 + (c.mentioned ? 50 : 0) + (c.album ? 20 : 0) + (imaged ? 10 : 0) + (cached ? 1 : 0);
	// The strongest signal, in the order of the weights.
	const reason: Reason =
		genres > 0
			? "genreLandmark"
			: c.mentioned
				? "mentioned"
				: c.album
					? "album"
					: imaged
						? "imaged"
						: cached
							? "cached"
							: "first";
	return { score, reason };
}

export interface ChooseOptions {
	/** Tie on the OLDEST year first (landmark_project); the list order alone otherwise (reference_track). */
	oldestFirst: boolean;
	/** A sole eligible `single` without signal is no choice (landmark_project); a sole track is not concerned. */
	soleSingleUnsupported: boolean;
}

/** Is `a` strictly better than `b`? Score, then not named after an artist, then the year; else `b` stays. */
function beats(a: Candidate, scoreA: number, b: Candidate, scoreB: number, options: ChooseOptions): boolean {
	if (scoreA !== scoreB) return scoreA > scoreB;
	if (a.namedAfterArtist !== b.namedAfterArtist) return b.namedAfterArtist;
	if (options.oldestFirst && a.year !== b.year) {
		if (a.year === null) return false; // no year: after every entry that has one
		return b.year === null || a.year < b.year;
	}
	return false;
}

/** The best eligible candidate (highest score, then oldest year, then list order), or why there is none. */
export function choose(candidates: readonly Candidate[], options: ChooseOptions): Choice {
	if (candidates.length === 0) return { kind: "empty" };
	const excluded: { slug: string; reason: ExclusionReason }[] = [];
	let best: { candidate: Candidate; score: number; reason: Reason } | null = null;
	let eligible = 0;
	for (const candidate of candidates) {
		const kind = candidate.state.kind;
		if (
			kind === "uncredited" ||
			kind === "unreadable" ||
			kind === "redirected" ||
			kind === "compilation" ||
			kind === "non-canonical"
		) {
			excluded.push({ slug: candidate.slug, reason: kind === "uncredited" ? "not-credited" : kind });
			continue;
		}
		eligible++;
		const { score, reason } = scoreOf(candidate);
		if (best === null || beats(candidate, score, best.candidate, best.score, options)) {
			best = { candidate, score, reason };
		}
	}
	if (best === null) return { kind: "all-excluded", excluded };
	// Better no choice than a final one without any support: the only option left, with nothing behind it,
	// when it is downgraded as named after an artist, or a lone single for a flagship album. Any other sole
	// entry without a signal is legitimate, only unverifiable: it stays chosen.
	if (
		eligible === 1 &&
		best.score === 0 &&
		(best.candidate.namedAfterArtist || (options.soleSingleUnsupported && best.candidate.single))
	) {
		return { kind: "sole-unsupported", slug: best.candidate.slug, excluded };
	}
	return {
		kind: "chosen",
		edge: best.candidate.edge,
		slug: best.candidate.slug,
		reason: best.reason,
		score: best.score,
		emptyCredit: best.candidate.emptyCredit,
		excluded,
	};
}

/**
 * Text normalized for the title match: NFKD, ASCII only, lowercase, every run of punctuation or spaces
 * becomes one space. Accents first decompose and their marks are dropped ("é" gives "e"); a non-ASCII
 * LETTER with no decomposition ("ø", "ß", "日") is dropped; a non-ASCII PUNCTUATION, symbol or space (curly
 * apostrophe, en / em dash, no-break space) becomes a space like its ASCII sibling. Without that last rule
 * a curly apostrophe in the article ("Don’t Stop") would give "dont stop" against "don t stop" for the
 * title typed with ', and "Blue—the" would glue two words (found by the review, 2026-10-17). Applied to the
 * titles AND to the article, so both sides agree on every character.
 */
export function normalizeText(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\P{ASCII}/gu, (char) => (/[\p{P}\p{S}\p{Z}]/u.test(char) ? " " : ""))
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** The shortest normalized title that can count as quoted in a text. */
export const MIN_MENTION_LENGTH = 3;

/**
 * Is the normalized `title` a WHOLE expression, bounded by spaces, of one of the normalized `texts`? A title
 * of fewer than 3 characters, or made only of 4 digits (a year: "released in 2010"), never counts.
 */
export function mentionedIn(title: string, texts: readonly string[]): boolean {
	if (title.length < MIN_MENTION_LENGTH || /^\d{4}$/.test(title)) return false;
	const needle = ` ${title} `;
	return texts.some((text) => ` ${text} `.includes(needle));
}

/**
 * The normalized `text` without the given normalized phrases, each removed as a WHOLE expression (a phrase
 * is replaced by one space, longest first). Used to take the artist's own name, aliases and the genres'
 * names out of the article before a title is looked up: "Chuck Berry" must not quote the title Chuck,
 * "argentine tango" the title Tango, "acid house" the title Acid.
 */
export function stripPhrases(text: string, phrases: readonly string[]): string {
	let padded = ` ${text} `;
	for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
		const needle = ` ${phrase} `;
		while (padded.includes(needle)) padded = padded.split(needle).join(" ");
	}
	return padded.trim();
}

/** The year of an edge ("1997", "1997-05-01"), null when it does not start with four digits. */
export function yearOf(year: unknown): number | null {
	if (typeof year !== "string") return null;
	const match = /^\d{4}/.exec(year.trim());
	return match ? Number(match[0]) : null;
}

const hasPhrase = (text: string, phrase: string): boolean => ` ${text} `.includes(` ${phrase} `);

/** Is this raw title a remix, a mix, a soundtrack, a best-of or a bootleg (rule v3)? Live recordings are not. */
export function isNonCanonical(rawTitle: string): boolean {
	const title = normalizeText(rawTitle);
	if (title === "") return false;
	if (NON_CANONICAL_PHRASES.some((phrase) => hasPhrase(title, phrase))) return true;
	// "The best of ..." at the head of the title only.
	if (NON_CANONICAL_LEADING_PHRASES.some((phrase) => title === phrase || title.startsWith(`${phrase} `)))
		return true;
	// Soundtrack markers: at the end of the title...
	if (NON_CANONICAL_TRAILING_PHRASES.some((phrase) => title === phrase || title.endsWith(` ${phrase}`)))
		return true;
	// ... or inside parentheses / brackets.
	for (const group of rawTitle.matchAll(/[([]([^)\]]*)[)\]]/g)) {
		const inner = normalizeText(group[1] ?? "");
		if (NON_CANONICAL_TRAILING_PHRASES.some((phrase) => hasPhrase(inner, phrase))) return true;
	}
	return false;
}

// --- Run ---

export interface BackfillOptions {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	/** Where the redirect tables are read (the channel's scratch copy); the repo's data/ when absent. */
	dataDir?: string | undefined;
	log?: (line: string) => void;
}

/**
 * The redirect table the reads use (genre + slug files). Throws on an unreadable or invalid table, and on
 * a missing slug table when a directory was given explicitly: the run is refused, never run on a guess.
 */
export async function loadRunRedirects(dataDir: string | undefined): Promise<ReadonlyMap<Slug, Slug>> {
	if (dataDir === undefined) return loadRedirects();
	const slugTable = join(dataDir, "slug-redirects.json");
	try {
		await stat(slugTable);
	} catch {
		throw new Error(`redirect table not found: ${slugTable}`);
	}
	return loadRedirects({ genre: join(dataDir, "genre-redirects.json"), slug: slugTable });
}

export interface BackfillResult {
	manifest: LandmarkManifest;
	written: string[];
	exitCode: number;
}

/** Is `work` scoped on the artist itself (`--<artist slug body>` or `--<normalized artist name>`)? */
export function scopedOnArtist(work: string, artistSlug: string, artistName: string): boolean {
	return scopeOf(work) === parseSlug(artistSlug).body || scopeMatchesArtist(work, artistName);
}

/** A cached work crediting at least this many artists, without a scope on the artist, is a compilation. */
export const COMPILATION_MIN_CREDITS = 3;

/** Does the target's OWN text (article, pitch or teaser) name one of the artist's names, as a whole expression? */
function namesArtist(work: Work, names: readonly string[]): boolean {
	const own = work.type === "project" ? work.editorial_pitch : work.editorial_teaser;
	const texts = [work.editorial_article, own].map(normalizeText);
	return names.some((name) => mentionedIn(name, texts));
}

const compareLex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const hasField = (node: Record<string, unknown>, field: HighlightField): boolean =>
	node[field] !== undefined && node[field] !== null;

export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
	const { cacheDir, apply, manifestPath } = options;
	const log = options.log ?? (() => undefined);
	const cache = new NodeCache(cacheDir);
	// First of all: a table that cannot be read refuses the run before anything is decided or written.
	const redirects = await loadRunRedirects(options.dataDir);

	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	// Relative to nodes/, and without the cache dir in the message: the channel's preview and apply use
	// different scratch directories, and the manifest must not depend on where the cache sits.
	// Only an unreadable ARTIST file fails the run: it is the one thing that cannot be filled. An unreadable
	// genre / label / work file is warned about above, and a work consulted as a target is excluded as
	// `unreadable`; an unrelated corrupt file must not turn a correct apply into a refused one.
	const failed: LandmarkManifest["failed"] = invalid
		.map((entry) => ({ rel: relative(join(cacheDir, "nodes"), entry.path), error: entry.error }))
		.filter(({ rel }) => rel.startsWith("artist:"))
		.map(({ rel, error }) => ({
			slug: rel,
			reason: `unreadable node file: ${error.split(cacheDir).join("<cache>")}`,
		}));

	// Every file on disk, a corrupt one included: a target that exists but cannot be read is `unreadable`,
	// never `absent` (which would keep it eligible).
	const inCache = new Set<string>(await cache.listSlugs());

	// How many genres list each slug as a landmark, per genre list, keyed by the slug the reads resolve to.
	const genreCount: Record<(typeof HIGHLIGHT_FIELDS)[number]["genreList"], Map<string, number>> = {
		landmark_projects: new Map(),
		landmark_tracks: new Map(),
	};
	const hasImage = new Set<string>();
	for (const { slug, type, node } of nodes) {
		if (typeof node.image_url === "string" && node.image_url !== "") hasImage.add(slug);
		if (type !== "genre") continue;
		for (const { genreList } of HIGHLIGHT_FIELDS) {
			const entries = node[genreList];
			if (!Array.isArray(entries)) continue;
			// One genre counts once per target, even when it lists it twice (or under two names).
			const seen = new Set<string>();
			for (const e of entries) {
				if (!isRecord(e) || typeof e.slug !== "string") continue;
				const target = await resolveReadSlug(e.slug as Slug, redirects, cache);
				if (seen.has(target)) continue;
				seen.add(target);
				genreCount[genreList].set(target, (genreCount[genreList].get(target) ?? 0) + 1);
			}
		}
	}

	const workCache = new Map<string, Promise<NodePayload | null>>();
	const readWork = (slug: string): Promise<NodePayload | null> => {
		let hit = workCache.get(slug);
		if (!hit) {
			hit = cache.get(slug as Slug).then(
				(n) => n,
				() => null,
			);
			workCache.set(slug, hit);
		}
		return hit;
	};

	// The normalized name of every artist of the cache: an entry titled like one is "named after an artist".
	const artistNames = new Set<string>();
	for (const { type, node } of nodes) {
		if (type !== "artist" || typeof node.name !== "string") continue;
		// An all non-ASCII name normalizes to "": it would flag every all non-ASCII title (found by the review).
		const name = normalizeText(node.name);
		if (name !== "") artistNames.add(name);
	}
	// Likewise the genres: a title that is a genre's name, or sits inside "argentine tango", is no quotation.
	const genreNames = new Set<string>();
	for (const { type, node } of nodes) {
		if (type !== "genre" || typeof node.name !== "string") continue;
		const name = normalizeText(node.name);
		if (name !== "") genreNames.add(name);
	}

	const written = { landmark_project: 0, reference_track: 0 };
	const zeroReasons = (): Record<Reason, number> => ({
		genreLandmark: 0,
		mentioned: 0,
		album: 0,
		imaged: 0,
		cached: 0,
		first: 0,
	});
	const byReason = { landmark_project: zeroReasons(), reference_track: zeroReasons() };
	const skipped: Record<HighlightField, string[]> = { landmark_project: [], reference_track: [] };
	const excluded: Exclusion[] = [];
	const soleUnsupported: LandmarkManifest["soleUnsupported"] = [];
	const picks: HighlightPick[] = [];
	const writtenPaths: string[] = [];

	const artists = nodes.filter((n) => n.type === "artist");
	log(`${artists.length} artist(s), ${nodes.length - artists.length} other node(s) read`);

	for (const { slug, path, node: raw } of artists) {
		const pending = HIGHLIGHT_FIELDS.filter(({ field }) => !hasField(raw, field));
		if (pending.length === 0) continue;
		const parsed = nodePayloadSchema.safeParse(raw);
		if (!parsed.success || parsed.data.type !== "artist") {
			failed.push({
				slug,
				reason: `refusing to fill an invalid node: ${parsed.success ? "not an artist" : parsed.error.message}`,
			});
			continue;
		}
		// Same cast as the image backfill: the schema's output type differs from NodePayload only by `undefined`
		// on optional fields (exactOptionalPropertyTypes).
		const artist = parsed.data as Extract<NodePayload, { type: "artist" }>;
		// The artist's own texts, normalized once. Artists carry no teaser / pitch (those are on works):
		// `editorial_article` is the text the title is looked up in.
		const article = normalizeText(artist.editorial_article);
		// The artist's own names (name and aliases) and the genres' names are taken out of the article before a
		// title is looked up; only those the article actually contains are worth stripping.
		const ownNames = [artist.name, ...artist.aliases.map((a) => a.name)]
			.map(normalizeText)
			.filter((n) => n !== "");
		const strippable = [...new Set([...ownNames, ...genreNames])].filter((phrase) =>
			` ${article} `.includes(` ${phrase} `),
		);

		const next: Record<string, unknown> = { ...raw };
		const mine: {
			picks: HighlightPick[];
			excluded: Exclusion[];
			skipped: HighlightField[];
			sole: LandmarkManifest["soleUnsupported"];
		} = {
			picks: [],
			excluded: [],
			skipped: [],
			sole: [],
		};
		for (const { field, list, genreList } of pending) {
			const entries = Array.isArray(raw[list]) ? (raw[list] as unknown[]) : [];
			const candidates: Candidate[] = [];
			const seenTargets = new Set<string>();
			for (const edge of entries) {
				// A slug listed twice is one candidate: the first occurrence wins, as the tie rule says.
				if (!isRecord(edge) || typeof edge.slug !== "string" || seenTargets.has(edge.slug)) continue;
				seenTargets.add(edge.slug);
				// What a read of this slug opens: the node itself when it is live, else one redirect hop.
				const target = await resolveReadSlug(edge.slug as Slug, redirects, cache);
				let state: TargetState = { kind: "absent" };
				let cachedAlbum = false;
				let emptyCredit = false;
				const rawTitle = typeof edge.name === "string" ? edge.name : "";
				const title = normalizeText(rawTitle);
				const titleIsArtistName = title !== "" && artistNames.has(title);
				let verifiedCredit = false;
				// Quoted in the article, which first loses the artist's names and the genres' names, except the
				// ones the title itself contains. Never a title that is an artist's or a genre's name.
				const mentioned =
					!titleIsArtistName &&
					!genreNames.has(title) &&
					mentionedIn(title, [
						stripPhrases(
							article,
							strippable.filter((phrase) => !` ${title} `.includes(` ${phrase} `)),
						),
					]);
				if (inCache.has(target)) {
					const work = await readWork(target);
					if (work === null || (work.type !== "project" && work.type !== "track")) {
						state = { kind: "unreadable" };
					} else {
						const credits = (await reciprocity(artist, work as Work, cache, redirects)) !== null;
						verifiedCredit = credits;
						// An EMPTY credit is an absence of proof, not a proof of a foreign credit, so the target is
						// kept (TRA-601) when (1) the artist's article quotes its title, (2) its slug is not scoped
						// on somebody else and (3) its own text names the artist. An identical title is the mark of
						// a homonym: (1) alone brought back DFRNT's Fading for Pole.
						emptyCredit =
							!credits &&
							work.artists.length === 0 &&
							mentioned &&
							(scopeOf(target) === null || scopedOnArtist(target, slug, artist.name)) &&
							namesArtist(work, ownNames);
						if (!credits && !emptyCredit) {
							state = { kind: "uncredited" };
						} else if (
							field === "landmark_project" &&
							new Set(work.artists.map((a) => a.slug)).size >= COMPILATION_MIN_CREDITS &&
							!scopedOnArtist(target, slug, artist.name)
						) {
							// After the identity rules: only a work that credits the artist is judged on its credits.
							state = { kind: "compilation" };
						} else {
							state = { kind: "credited", imaged: hasImage.has(target) };
							cachedAlbum = work.type === "project" && work.release_type === "album";
						}
					}
				} else if (target !== edge.slug && !scopedOnArtist(target, slug, artist.name)) {
					state = { kind: "redirected" };
				}
				// Rule v3: a release that is not canonical by its title leaves the choice (identity rules first).
				if ((state.kind === "absent" || state.kind === "credited") && isNonCanonical(rawTitle)) {
					state = { kind: "non-canonical" };
				}
				// Named after an artist: no signal, last on a tie. Not when the target is scoped on THIS artist
				// (project:skream--skream, project:inside--paul-horn), nor, rule v3, when the title is the name of
				// THIS artist and the target is in the cache and credits it (project:supreme-ntm): a self-titled
				// record that is verified is the artist's own. Still downgraded for another artist's name (The
				// Beatles for Lennon) and for a self-titled record that cannot be verified.
				const verifiedSelfTitled =
					ownNames.includes(title) && state.kind === "credited" && verifiedCredit && !emptyCredit;
				const namedAfterArtist =
					titleIsArtistName && !scopedOnArtist(target, slug, artist.name) && !verifiedSelfTitled;
				candidates.push({
					edge,
					slug: edge.slug,
					state,
					genres: state.kind === "credited" ? (genreCount[genreList].get(target) ?? 0) : 0,
					mentioned,
					emptyCredit,
					album: field === "landmark_project" && (edge.releaseType === "album" || cachedAlbum),
					namedAfterArtist,
					year: yearOf(edge.year),
					single: field === "landmark_project" && edge.releaseType === "single",
				});
			}
			const choice = choose(candidates, {
				oldestFirst: field === "landmark_project",
				soleSingleUnsupported: field === "landmark_project",
			});
			const dropped = choice.kind === "empty" ? [] : choice.excluded;
			for (const d of dropped) mine.excluded.push({ artist: slug, field, target: d.slug, reason: d.reason });
			if (choice.kind === "sole-unsupported") {
				mine.sole.push({ artist: slug, field, target: choice.slug });
			}
			if (choice.kind !== "chosen") {
				mine.skipped.push(field);
				continue;
			}
			next[field] = choice.edge;
			mine.picks.push({
				artist: slug,
				field,
				target: choice.slug,
				reason: choice.reason,
				score: choice.score,
				...(choice.emptyCredit ? { emptyCredit: true as const } : {}),
			});
		}

		// Exclusions and skips are reported even when the artist gets nothing; picks only once the write is safe.
		excluded.push(...mine.excluded);
		soleUnsupported.push(...mine.sole);
		for (const field of mine.skipped) skipped[field].push(slug);
		if (mine.picks.length === 0) continue;

		const valid = nodePayloadSchema.safeParse(next);
		if (!valid.success) {
			failed.push({ slug, reason: `refusing to write an invalid node: ${valid.error.message}` });
			continue;
		}
		if (!onlyAddsSchemaDefaults(next, valid.data)) {
			// The schema strips undeclared fields, edges' included: only the two fields may change.
			failed.push({ slug, reason: "refusing to write: validation would alter fields the node carries" });
			continue;
		}
		if (apply) {
			await atomicWriteJson(path, valid.data);
			writtenPaths.push(path);
		}
		for (const p of mine.picks) {
			picks.push(p);
			written[p.field]++;
			byReason[p.field][p.reason]++;
		}
	}

	const manifest: LandmarkManifest = {
		migration: MIGRATION_NAME,
		removed: [],
		renamed: {},
		redirects: {},
		written,
		byReason,
		skipped: {
			landmark_project: skipped.landmark_project.sort(compareLex),
			reference_track: skipped.reference_track.sort(compareLex),
		},
		soleUnsupported: soleUnsupported.sort(
			(a, b) =>
				compareLex(a.artist, b.artist) || compareLex(a.field, b.field) || compareLex(a.target, b.target),
		),
		excluded: excluded.sort(
			(a, b) =>
				compareLex(a.artist, b.artist) || compareLex(a.field, b.field) || compareLex(a.target, b.target),
		),
		picks: picks.sort((a, b) => compareLex(a.artist, b.artist) || compareLex(a.field, b.field)),
		failed: failed.sort((a, b) => compareLex(a.slug, b.slug)),
	};
	await mkdir(dirname(manifestPath), { recursive: true });
	await atomicWriteJson(manifestPath, manifest);
	return { manifest, written: writtenPaths, exitCode: failed.length > 0 ? 1 : 0 };
}

export function formatSummary(result: BackfillResult, apply: boolean, manifestPath: string): string {
	const { manifest, written } = result;
	const lines: string[] = [];
	for (const { field } of HIGHLIGHT_FIELDS) {
		const r = manifest.byReason[field];
		lines.push(
			`${field.padEnd(16)} ${manifest.written[field]} chosen (${REASONS.map((reason) => `${reason} ${r[reason]}`).join(", ")}), ${manifest.skipped[field].length} skipped`,
		);
	}
	lines.push(
		`${manifest.soleUnsupported.length} artist field(s) left empty: a sole entry downgraded or a lone single`,
		`${manifest.excluded.length} entr(ies) excluded (${EXCLUSION_REASONS.map((r) => `${manifest.excluded.filter((e) => e.reason === r).length} ${r}`).join(", ")})`,
		`${manifest.failed.length} failed`,
		apply ? `${written.length} node file(s) written` : "dry-run: no node file written",
		`manifest: ${manifestPath}`,
	);
	for (const f of manifest.failed) lines.push(`failed ${f.slug}: ${f.reason}`);
	return lines.join("\n");
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
	manifestPath: string;
	dataDir?: string | undefined;
}

/**
 * Parses `<cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]`. `--data-dir` is the migration
 * channel's scratch copy of the redirect tables. Null (the CLI exits 2) on a missing cache-dir, a repeated
 * flag, a flag without its value (or with another flag as value) or any token no flag consumes.
 */
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
			"usage: 2026-10-19-backfill-landmark-highlights.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runBackfill({
		cacheDir: args.cacheDir,
		apply: args.apply,
		manifestPath: args.manifestPath,
		dataDir: args.dataDir,
		log: (line) => process.stdout.write(`${line}\n`),
	});
	console.log(formatSummary(result, args.apply, args.manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
