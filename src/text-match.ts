/**
 * Shared text matching for external-catalog lookups.
 *
 * Both the YouTube picker and the streaming-link resolver face the same problem:
 * a search API returns a plausible-looking result that is in fact a different
 * entity (a cover, a tribute album, "Volume II" instead of the record we asked
 * for). The gate below is the part that logic has in common — token coverage of
 * the expected name plus a hard requirement on the artist when it is known.
 * Domain-specific ranking (YouTube's "official"/"topic" bonuses) stays with the
 * caller; this module only decides "is this the same thing at all".
 */

/**
 * Normalize a string for token matching: NFD-decompose to strip accents,
 * lowercase, drop bracketed/parenthesized content, then keep alphanumerics
 * and split into >=2-char tokens. Mononyms like "40" and "ye" survive.
 */
export function normalizeTokens(s: string): string[] {
	const cleaned = s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[[({][^\])}]*[\])}]/g, " ")
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return cleaned.split(/\s+/).filter((t) => t.length >= 2);
}

const STOP = new Set([
	"the",
	"a",
	"an",
	"of",
	"and",
	"feat",
	"ft",
	"featuring",
	"with",
	"prod",
	"by",
	"vs",
	"remix",
	"version",
	"edit",
	"remastered",
	"remaster",
	"official",
	"audio",
	"video",
	"hd",
	"lyrics",
	"lyric",
]);

export function significantTokens(tokens: string[]): string[] {
	return tokens.filter((t) => !STOP.has(t));
}

/**
 * Score how well `candidateTitle` matches an expected name (+ artist when known).
 * Returns null when the candidate fails a hard requirement — no overlap with the
 * expected name, or the artist is known and entirely absent — and a 0..200 score
 * otherwise (name coverage + artist coverage, each worth up to 100).
 */
export function nameMatchScore(
	candidateTitle: string,
	expectedName: string,
	expectedArtist: string | undefined,
): number | null {
	const titleTokens = new Set(normalizeTokens(candidateTitle));
	const nameTokens = significantTokens(normalizeTokens(expectedName));
	const artistTokens = expectedArtist ? significantTokens(normalizeTokens(expectedArtist)) : [];

	if (nameTokens.length === 0) return null;
	const nameHits = nameTokens.filter((t) => titleTokens.has(t)).length;
	const nameCoverage = nameHits / nameTokens.length;
	// Require at least one significant name token AND either full coverage
	// or >=2 hits (covers multi-word titles where one token may be paraphrased).
	if (nameHits === 0) return null;
	if (nameTokens.length >= 2 && nameHits < 2 && nameCoverage < 1) return null;

	let artistScore = 0;
	if (artistTokens.length > 0) {
		const artistHits = artistTokens.filter((t) => titleTokens.has(t)).length;
		// Artist known: at least one artist token must appear, else this is the
		// wrong entity entirely (Daft Punk -> Stanley Black, Booba -> Corbillard).
		if (artistHits === 0) return null;
		artistScore = artistHits / artistTokens.length;
	}

	return nameCoverage * 100 + artistScore * 100;
}
