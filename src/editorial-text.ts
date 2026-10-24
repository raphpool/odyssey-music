/**
 * Normalizes model-generated prose (articles, teasers, short text facts).
 *
 * Why (2026-10, TRA-458): Gemini double-escapes newlines in its JSON, so 760 articles and 8 bios
 * were written with a literal backslash + "n" instead of a line break. The web renders the
 * article with `white-space: pre-wrap` and iOS only splits on real line breaks, so the escape
 * showed up as text. Shared with the cache migration (TRA-6.2), hence a module of its own.
 *
 * Rules: CRLF/CR become LF; literal `\n` and `\r\n` become LF; a literal `\"` becomes a quote (see
 * `unescapeQuotes`); trailing spaces are dropped; runs of 3+ newlines collapse to 2; the result is
 * trimmed. Other backslashes are left alone.
 * Trailing spaces are stripped before the collapse (the ticket lists them after) so a line made
 * only of spaces cannot survive and break idempotence.
 */
export function normalizeEditorialText(text: string): string {
	return unescapeQuotes(text.replace(/\r\n?/g, "\n").replace(/\\r\\n|\\n/g, "\n"))
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * A fenced code block: its backslashes are content, not the model's double escape. Same pattern as the one
 * of `scripts/migrations/2026-10-15-unescape-newlines.ts`. An inline code span is NOT shielded, for the
 * reason given there: stray backticks (an apostrophe) would pair up across paragraphs.
 */
const CODE_FENCE = /```[\s\S]*?```/g;

/**
 * A quote preceded by an UNPAIRED backslash. The lookbehind starts the match at the beginning of the run of
 * backslashes, group 1 keeps the pairs (each pair is one escaped backslash, content), and the last backslash
 * is the escape. An even run therefore never matches: the quote is a plain quote after a real backslash.
 */
const ESCAPED_QUOTE = /(?<!\\)((?:\\\\)*)\\"/g;

/**
 * Replace the literal `\"` (backslash + quote) by a quote.
 *
 * Why (2026-10, TRA-577): the double escaping of TRA-458 also hit quotation marks, so 19 articles printed
 * `\"Seaqz\"`. Same protection as the `\n` migration (TRA-492): a run of backslashes of even length is kept
 * (the quote follows a real backslash, as in a Windows path), and a fenced code block is left verbatim. Only
 * the escaping backslash is removed: nothing is trimmed and no newline is touched, which is what lets the
 * cache migration prove that it changed `\"` and nothing else. Idempotent.
 *
 * Only the quote rule knows about code: the `\n` replacement of `normalizeEditorialText` predates it and
 * converts every escape, fenced or not (the `\n` migration shields code itself).
 */
export function unescapeQuotes(text: string): string {
	if (!text.includes('\\"')) return text;
	let out = "";
	let last = 0;
	for (const fence of text.matchAll(CODE_FENCE)) {
		const start = fence.index ?? 0;
		out += text.slice(last, start).replace(ESCAPED_QUOTE, '$1"') + fence[0];
		last = start + fence[0].length;
	}
	return out + text.slice(last).replace(ESCAPED_QUOTE, '$1"');
}
