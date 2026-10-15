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
	let s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
	// Strip trailing disambiguating parentheticals: "Aphex Twin (musician)" -> "Aphex Twin"
	s = s.replace(/\s*\([^)]*\)\s*$/u, "");
	// Strip trailing bracket disambiguators too
	s = s.replace(/\s*\[[^\]]*\]\s*$/u, "");
	s = s.toLowerCase();
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
 * Normalization of a work TITLE (project/track) for identity comparison.
 *
 * Same flattening as normalizeSlugBody (NFKD, lowercase, "&" -> "and", non-alphanumeric run ->
 * "-") with two differences, because a title's parentheses are often part of what it names:
 * - a trailing "(...)" / "[...]" is KEPT: "Booty La La (Loefah remix)", "Fitna (Live)" and
 *   "aisatsana [102]" are not the same work as the bare title;
 * - groups that are pure edition noise are dropped first, anywhere in the title: remaster(ed),
 *   "<year> remaster", deluxe (edition), expanded/anniversary/special/collector's/bonus track
 *   edition, bonus track(s), explicit, clean, original mix, feat./ft./featuring ...
 *   "Kid A (Deluxe Edition)" and "Kid A" are the same work.
 */
export function normalizeTitleBody(title: string): string {
	let s = title.normalize("NFKD").replace(/[̀-ͯ]/g, "");
	s = s.replace(/\(([^()]*)\)|\[([^[\]]*)\]/gu, (group, round?: string, square?: string) =>
		EDITION_NOISE.test((round ?? square ?? "").trim()) ? " " : group,
	);
	s = s.toLowerCase().replace(/&/g, " and ");
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

/**
 * Identity of a work (project/track) is `<title>--<primary artist>` (graph-integrity plan, decision 1):
 * two works sharing a title stay distinct, and the artist is part of the slug rather than a
 * best-effort disambiguator. Unlike makeSlug, an empty scope is an error, not a silent fallback to an
 * unscoped slug -- that fallback is exactly how colliding titles got merged.
 */
export function makeScopedSlug(type: "project" | "track", title: string, artistName: string): Slug {
	const titleBody = normalizeSlugBody(title);
	const artistBody = normalizeSlugBody(artistName);
	if (!titleBody || !artistBody) {
		throw new Error(
			`Cannot build a scoped slug for ${type} from title "${title}" and artist "${artistName}"`,
		);
	}
	return `${type}:${titleBody}--${artistBody}` as Slug;
}

// normalizeSlugBody collapses every non-alphanumeric run to a single dash, so "--" can only come from
// a scope separator, never from the name itself.
const SCOPE_SEPARATOR = "--";

export function isScopedSlug(slug: Slug): boolean {
	return scopeOf(slug) !== null;
}

/** The normalized primary-artist part of a scoped slug, or null when the slug is unscoped. */
export function scopeOf(slug: Slug): string | null {
	const body = slug.slice(slug.indexOf(":") + 1);
	const idx = body.indexOf(SCOPE_SEPARATOR);
	return idx < 0 ? null : body.slice(idx + SCOPE_SEPARATOR.length);
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

export function isValidSlug(s: string): s is Slug {
	try {
		parseSlug(s);
		return true;
	} catch {
		return false;
	}
}
