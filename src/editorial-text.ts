/**
 * Normalizes model-generated prose (articles, teasers, short text facts).
 *
 * Why (2026-10, TRA-458): Gemini double-escapes newlines in its JSON, so 760 articles and 8 bios
 * were written with a literal backslash + "n" instead of a line break. The web renders the
 * article with `white-space: pre-wrap` and iOS only splits on real line breaks, so the escape
 * showed up as text. Shared with the cache migration (TRA-6.2), hence a module of its own.
 *
 * Rules: CRLF/CR become LF; literal `\n` and `\r\n` become LF; trailing spaces are dropped; runs
 * of 3+ newlines collapse to 2; the result is trimmed. Other backslashes are left alone.
 * Trailing spaces are stripped before the collapse (the ticket lists them after) so a line made
 * only of spaces cannot survive and break idempotence.
 */
export function normalizeEditorialText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\\r\\n|\\n/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
