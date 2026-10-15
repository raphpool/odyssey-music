import { scopedReleaseSlugsEnabled } from "./config.js";
import { NODE_TYPES } from "./node-spec.js";
import type { NodeType, Slug } from "./types.js";

/**
 * Canonical slug normalization.
 *
 * Goal: collapse pure spelling/punctuation variants of the SAME entity to one slug
 * ("Aphex Twin" / "aphex twin" / "Aphex Twin (musician)" -> artist:aphex-twin), while
 * keeping personas/aliases ("AFX", "Polygon Window") as their own distinct slugs.
 *
 * The agent decides identity (is "AFX" the same entity as "Aphex Twin"?). This function
 * only flattens textual variation of whatever name the agent has chosen as canonical.
 *
 * For genuine same-name distinct entities (two tracks called "Tendency"; an artist
 * "Bird" and a band "Bird"), the caller must pass a disambiguator (typically the
 * primary edge: an artist name for a track/project, founding year for a label).
 * The disambiguator is normalized the same way and appended to the slug body
 * separated by `--`. Example: makeSlug("track", "Tendency", "Jan Jelinek") =
 * track:tendency--jan-jelinek.
 */
export function normalizeSlugBody(name: string): string {
	return flattenSlugBody(name, scopedReleaseSlugsEnabled());
}

// Letters NFKD leaves whole (they carry no combining mark), mapped to their ASCII spelling (TRA-528,
// 2026-10-15). Without it they were dropped as non-[a-z0-9]: "MØ" -> artist:m (collides with "M"),
// "Łona" -> artist:ona, "Straße" -> artist:stra-e. Keys are lowercase: the table runs after toLowerCase,
// which also folds Ø Æ Œ Ł Đ Þ and ẞ (U+1E9E -> ß).
//
// BEHIND scopedReleaseSlugsEnabled() (ODYSSEY_SCOPED_RELEASE_SLUGS), not always on: the cache already
// holds edges to these names under their current slugs (artist:lindstr-m, artist:molv-r, artist:ona,
// project:void for "ØØ Void"...), so changing the normalization before the identity migration
// (TRA-478/483/484) would orphan them. TRA-509 flips the flag once for every slug-identity change.
// Flag off = the pre-TRA-528 output, bit for bit.
const TRANSLITERATION: Readonly<Record<string, string>> = {
	"\u00f8": "o", // ø
	"\u00e6": "ae", // æ
	"\u0153": "oe", // œ
	"\u0142": "l", // ł
	"\u00df": "ss", // ß
	"\u0111": "d", // đ
	"\u00fe": "th", // þ
};
// Both regexes are built from the table, so a letter added to it cannot be forgotten in one of them.
// The detector has no g flag: a global regex keeps lastIndex between test() calls.
const TRANSLITERATED_CLASS = `[${Object.keys(TRANSLITERATION).join("")}]`;
const TRANSLITERATED_LETTERS = new RegExp(TRANSLITERATED_CLASS, "gu");
const HAS_TRANSLITERATED_LETTER = new RegExp(TRANSLITERATED_CLASS, "u");

/** True when the text holds a letter the transliteration table rewrites (any case). */
export function hasTransliteratedLetter(text: string): boolean {
	return HAS_TRANSLITERATED_LETTER.test(foldForSlug(text));
}

function foldForSlug(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

function flattenSlugBody(name: string, transliterate: boolean): string {
	let s = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	// Strip trailing disambiguating parentheticals: "Aphex Twin (musician)" -> "Aphex Twin"
	s = s.replace(/\s*\([^)]*\)\s*$/u, "");
	// Strip trailing bracket disambiguators too
	s = s.replace(/\s*\[[^\]]*\]\s*$/u, "");
	s = s.toLowerCase();
	if (transliterate) s = s.replace(TRANSLITERATED_LETTERS, (c) => TRANSLITERATION[c] ?? c);
	// Replace ampersand with " and " for stability
	s = s.replace(/&/g, " and ");
	// Replace any non-alphanumeric run with single dash
	s = s.replace(/[^a-z0-9]+/g, "-");
	s = s.replace(/^-+|-+$/g, "");
	return s;
}

// Whole-group contents (after trimming) that are edition noise rather than part of the work's
// identity. Anything not matching in full (remix, live, "pt. 3", "version", a number) is kept.
const EDITION_NOISE =
	/^(?:(?:\d{4}\s+)?remaster(?:ed)?|deluxe(?:\s+edition)?|(?:expanded|anniversary|special|collector['’]?s|bonus\s+track)\s+edition|bonus\s+tracks?|explicit|clean|original\s+mix|(?:feat|ft)\.?\s+.+|featuring\s+.+)$/iu;

/**
 * Remove the edition-noise groups from a title, leaving everything else (casing, diacritics,
 * other groups) untouched and whitespace collapsed. Shared by normalizeTitleBody (identity) and the
 * MusicBrainz search phrase, so both agree on what counts as noise.
 */
export function stripEditionNoise(title: string): string {
	return title
		.replace(/\(([^()]*)\)|\[([^[\]]*)\]/gu, (group, round?: string, square?: string) =>
			EDITION_NOISE.test((round ?? square ?? "").trim()) ? " " : group,
		)
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * Normalization of a work TITLE (project/track) for identity comparison.
 *
 * Same flattening as normalizeSlugBody (NFKD, lowercase, "&" -> "and", non-alphanumeric run ->
 * "-") with two differences, because a title's parentheses are often part of what it names:
 * - a trailing "(...)" / "[...]" is KEPT: "Booty La La (Loefah remix)", "Fitna (Live)" and
 *   "aisatsana [102]" are not the same work as the bare title;
 * - groups that are pure edition noise are dropped first, anywhere in the title (see
 *   stripEditionNoise): remaster(ed), "<year> remaster", deluxe (edition), expanded/anniversary/
 *   special/collector's/bonus track edition, bonus track(s), explicit, clean, original mix,
 *   feat./ft./featuring ... "Kid A (Deluxe Edition)" and "Kid A" are the same work.
 */
export function normalizeTitleBody(title: string): string {
	return flattenTitleBody(title, scopedReleaseSlugsEnabled());
}

function flattenTitleBody(title: string, transliterate: boolean): string {
	// NFKD first (it also turns fullwidth brackets into ASCII ones), then noise removal.
	let s = stripEditionNoise(title.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""));
	s = s.toLowerCase();
	if (transliterate) s = s.replace(TRANSLITERATED_LETTERS, (c) => TRANSLITERATION[c] ?? c);
	s = s.replace(/&/g, " and ");
	s = s.replace(/[^a-z0-9]+/g, "-");
	return s.replace(/^-+|-+$/g, "");
}

export function makeSlug(type: NodeType, name: string, disambiguator?: string): Slug {
	const body = normalizeSlugBody(name);
	if (!body) {
		throw new Error(`Cannot slugify empty name for type ${type}`);
	}
	if (disambiguator) {
		const d = normalizeSlugBody(disambiguator);
		if (d) return `${type}:${body}--${d}` as Slug;
	}
	return `${type}:${body}` as Slug;
}

export type ScopedSlugResult =
	| { ok: true; slug: Slug }
	| { ok: false; reason: "empty-title" | "empty-artist" };

/**
 * Identity of a work (project/track) is `<title>--<primary artist>` (graph-integrity plan, decision 1):
 * two works sharing a title stay distinct, and the artist is part of the slug rather than a
 * best-effort disambiguator. Unlike makeSlug, an empty part is a failure, not a silent fallback to an
 * unscoped slug -- that fallback is exactly how colliding titles got merged.
 *
 * The title goes through normalizeTitleBody, not normalizeSlugBody: the latter drops a trailing
 * "(...)" / "[...]", which made "Booty La La", "Booty La La (Loefah remix)" and "... (Draw the Line
 * remix)" (three MusicBrainz release groups) one slug (TRA-451 deep review, 2026-10-14).
 *
 * A typed result rather than a throw: a non-Latin artist name ("坂本龍一") normalizes to "" and is an
 * expected input at this boundary. Callers resolve it with pickScopeArtistName candidates.
 */
export function makeScopedSlug(
	type: "project" | "track",
	title: string,
	artistName: string,
): ScopedSlugResult {
	const titleBody = normalizeTitleBody(title);
	if (!titleBody) return { ok: false, reason: "empty-title" };
	const artistBody = normalizeSlugBody(artistName);
	if (!artistBody) return { ok: false, reason: "empty-artist" };
	return { ok: true, slug: `${type}:${titleBody}--${artistBody}` as Slug };
}

/**
 * The first candidate whose normalized body is not empty, as given (not normalized), or null.
 * Meant for the artist name a scope is built from (credited name, MB name, "en" alias, sort-name...),
 * in the caller's order of preference. No transliteration: a name with no Latin letter or digit is
 * skipped, not converted.
 */
export function pickScopeArtistName(candidates: ReadonlyArray<string | undefined>): string | null {
	for (const candidate of candidates) {
		if (candidate !== undefined && normalizeSlugBody(candidate)) return candidate;
	}
	return null;
}

// Scope separator inside a project/track body. A title body never contains "--" (every
// non-alphanumeric run collapses to one dash), but makeSlug's older free-text disambiguators share the
// separator: 74 existing work slugs ("track:the-model--song-by-kraftwerk") and
// "artist:pole--stefan-betke". So "--" alone does NOT prove an artist scope.
const SCOPE_SEPARATOR = "--";
const SCOPED_TYPES: readonly string[] = ["project", "track"];

/**
 * True when the slug is a project/track with a non-empty `<title>--<scope>` body. It says nothing
 * about WHAT the scope is (a legacy disambiguator qualifies too); use scopeMatchesArtist for that.
 */
export function isScopedSlug(slug: string): boolean {
	return scopeOf(slug) !== null;
}

/**
 * The text after the separator of a project/track slug, or null (other types, no separator, empty
 * half, malformed input). It is a NORMALIZED body ("roni-size-reprazent"), never a displayable
 * artist name, and for legacy slugs it may be a free-text disambiguator rather than an artist.
 */
export function scopeOf(slug: string): string | null {
	const colon = slug.indexOf(":");
	if (colon < 0 || !SCOPED_TYPES.includes(slug.slice(0, colon))) return null;
	const body = slug.slice(colon + 1);
	const idx = body.indexOf(SCOPE_SEPARATOR);
	if (idx <= 0) return null;
	return body.slice(idx + SCOPE_SEPARATOR.length) || null;
}

/** True when the slug's scope is exactly the normalized form of `artistName`. */
export function scopeMatchesArtist(slug: string, artistName: string): boolean {
	const scope = scopeOf(slug);
	return scope !== null && scope === normalizeSlugBody(artistName);
}

export type TransliteratedSlugResult =
	| { ok: true; slug: Slug }
	| { ok: false; reason: "not-derived-from-name" };

const WORK_TYPES: readonly string[] = ["project", "track"];

/**
 * The slug a node or edge target would get once the TRA-528 transliteration is on, whatever the flag
 * (scopedReleaseSlugsEnabled() is NOT read here: this is the old -> new table the identity migration
 * TRA-478 consumes, computed before the flag flips). Pure.
 *
 * It needs the display name, not just the old slug: the old body is lossy ("artist:m" cannot tell "MØ"
 * from "M"). `artistName` is the primary artist of a project/track (EdgeRef.artist, or artists[0].name
 * on a node), the source of a `--<scope>` suffix.
 *
 * The old slug is re-derived from the name first (pre-TRA-528 rules; a work title through either
 * normalizeTitleBody or the older normalizeSlugBody). If it cannot be reproduced -- a free-text
 * legacy disambiguator ("artist:pole--stefan-betke"), a renamed node -- the answer is
 * "not-derived-from-name": the caller keeps the slug and reviews it by hand, nothing is guessed.
 * An unaffected slug, or one already in its new form, comes back unchanged (`ok: true`, same slug).
 */
export function transliteratedSlug(
	slug: string,
	name: string,
	artistName?: string,
): TransliteratedSlugResult {
	const notDerived: TransliteratedSlugResult = { ok: false, reason: "not-derived-from-name" };
	if (!isReadableSlug(slug)) return notDerived;
	const { type, body } = parseSlug(slug);
	const sep = body.indexOf(SCOPE_SEPARATOR);
	const oldTitle = sep < 0 ? body : body.slice(0, sep);
	const oldScope = sep < 0 ? null : body.slice(sep + SCOPE_SEPARATOR.length);

	const flatteners: Array<(text: string, transliterate: boolean) => string> = WORK_TYPES.includes(type)
		? [flattenTitleBody, flattenSlugBody]
		: [flattenSlugBody];
	// Either spelling is accepted, so a slug already in its new form comes back unchanged (idempotent:
	// a re-run of the migration, or a node minted with the flag on).
	const flatten = flatteners.find((f) => f(name, false) === oldTitle || f(name, true) === oldTitle);
	if (!flatten) return notDerived;
	const newTitle = flatten(name, true);

	let newScope: string | null = null;
	if (oldScope !== null) {
		if (artistName === undefined) return notDerived;
		if (flattenSlugBody(artistName, false) !== oldScope && flattenSlugBody(artistName, true) !== oldScope) {
			return notDerived;
		}
		newScope = flattenSlugBody(artistName, true);
	}
	const next = `${type}:${newTitle}${newScope === null ? "" : `${SCOPE_SEPARATOR}${newScope}`}`;
	return isValidSlug(next) ? { ok: true, slug: next } : notDerived;
}

export function parseSlug(slug: string): { type: NodeType; body: string } {
	const idx = slug.indexOf(":");
	if (idx < 0) {
		throw new Error(`Invalid slug (no colon): ${slug}`);
	}
	const type = slug.slice(0, idx);
	const body = slug.slice(idx + 1);
	if (!body) {
		throw new Error(`Invalid slug (empty body): ${slug}`);
	}
	if (!isNodeType(type)) {
		throw new Error(`Invalid slug type: ${type}`);
	}
	return { type, body };
}

function isNodeType(s: string): s is NodeType {
	return (NODE_TYPES as readonly string[]).includes(s);
}

// Single source of truth for "what a slug can look like" (TRA-501): `<type>:<body>` where the body is
// what normalizeSlugBody / normalizeTitleBody / makeScopedSlug can produce -- lowercase alphanumeric
// runs joined by "-", with at most one "--" separating a work title from its scope. Anything else
// (quotes, "/", "..", spaces, uppercase, a third "--") is not a slug this codebase ever mints, and
// slugs end up in HTML attributes, URLs and cache file paths.
export const CANONICAL_SLUG_PATTERN = new RegExp(
	`^(${NODE_TYPES.join("|")}):[a-z0-9]+(-[a-z0-9]+)*(--[a-z0-9]+(-[a-z0-9]+)*)?$`,
);

/**
 * True for a canonical slug (CANONICAL_SLUG_PATTERN). This is the WRITE-side rule: node schema
 * validation (src/schemas.ts), POST /materialize, redirect tables. Reads of already-cached nodes use
 * isReadableSlug instead, so a legacy slug in a deployed cache cannot take /data.json down.
 */
export function isValidSlug(s: string): s is Slug {
	return CANONICAL_SLUG_PATTERN.test(s);
}

/**
 * The pre-TRA-501 rule: a known type prefix and a non-empty body, nothing else. It is deliberately
 * NOT a safety check -- it admits `artist:x" onmouseover="y`. It exists only for the READ side, where
 * the cache of a deployed server holds nodes this repository has never seen (deploy excludes cache/),
 * and where rejecting one would 500 the whole graph. Every consumer of such a slug must still escape it.
 */
export function isReadableSlug(s: string): s is Slug {
	try {
		parseSlug(s);
		return true;
	} catch {
		return false;
	}
}
