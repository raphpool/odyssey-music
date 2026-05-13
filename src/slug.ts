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
	return s === "genre" || s === "label" || s === "artist" || s === "project" || s === "track";
}

export function isValidSlug(s: string): s is Slug {
	try {
		parseSlug(s);
		return true;
	} catch {
		return false;
	}
}
