/**
 * Identity guard for seed crawls (TRA-XXX, 2026-09-17).
 *
 * Symptom: `crawlGenreSeeds` materializes a target by slug+MBID, but the web search that
 * feeds the LLM draft is keyed on the requested *name* alone (researchTarget in
 * src/pipeline.ts), and canonicalizeDraft lets the LLM-authored name overwrite the
 * requested one while keeping the requested slug. When the name is ambiguous (a DJ alias
 * that collides with a country singer, a genre name that collides with its parent), the
 * pipeline can silently materialize the wrong real-world entity under the right slug — e.g.
 * `artist:tracy-onne` (a Spanish makina DJ) got written with the biography of Tracy
 * Lawrence, the American country singer. This module gives the crawler a cheap, local check
 * to catch that drift before writing the node.
 *
 * `isSameEntityName` is intentionally permissive rather than an exact match: MusicBrainz,
 * Wikipedia and the LLM draft disagree constantly on stylization ("Hip Hop" vs "Hip-Hop",
 * diacritics, "&" vs "and", a dropped leading "The") without actually disagreeing on which
 * entity is meant. It only needs to catch the case where the drafted name refers to a
 * *different* entity than the one requested, not to enforce byte-for-byte equality.
 */

/** Strips diacritics, punctuation and stylization noise down to a comparable token string. */
function normalize(name: string): string {
	let s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
	s = s.toLowerCase();
	s = s.replace(/&/g, " and ");
	// Trailing disambiguator, e.g. "Genesis (band)" -> "Genesis" — noise the guard should
	// ignore rather than treat as a token mismatch.
	s = s.replace(/\s*\([^)]*\)\s*$/, "");
	// Remaining punctuation (apostrophes, hyphens, commas, ...) collapses to whitespace.
	s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
	s = s.replace(/\s+/g, " ").trim();
	// A leading article never carries identity ("The Beatles" vs "Beatles").
	s = s.replace(/^the\s+/, "");
	return s;
}

function tokenSet(normalized: string): Set<string> {
	return new Set(normalized.length > 0 ? normalized.split(" ") : []);
}

/**
 * True when `requested` and `drafted` plausibly name the same real-world entity: their
 * normalized forms are equal, or one's token set is fully contained in the other's (covers
 * "Tyree" / "Tyree Cooper", "House music" / "House"). False for genuine homonyms that share
 * at most a partial token overlap ("Afrobeats" / "Afrobeat", "Towdee Mac" / "Mac Davis").
 */
export function isSameEntityName(requested: string, drafted: string): boolean {
	const a = normalize(requested);
	const b = normalize(drafted);
	if (a === b) return true;

	const tokensA = tokenSet(a);
	const tokensB = tokenSet(b);
	if (tokensA.size === 0 || tokensB.size === 0) return false;

	const aSubsetOfB = [...tokensA].every((t) => tokensB.has(t));
	const bSubsetOfA = [...tokensB].every((t) => tokensA.has(t));
	return aSubsetOfB || bSubsetOfA;
}
