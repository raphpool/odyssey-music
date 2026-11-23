import { normalizeEditorialText } from "../editorial-text.js";

const NBSP = " ";

// An ordinary space after an opening guillemet, or none at all before a word. Never matches a space already
// non-breaking, nor a line break: `\S` excludes both.
const AFTER_OPENING_GUILLEMET = /«(?: |(?=\S))/g;
// An ordinary space before a closing guillemet, or none after a word. The lookbehind refuses a line start
// and an existing NBSP, so a guillemet opening a line or already spaced is left alone.
const BEFORE_CLOSING_GUILLEMET = /(?<=[^\n ]) ?»/g;
// Only an existing ordinary space is promoted. A missing one is never added: "12:30" and "https://x" stay.
const SPACE_BEFORE_HIGH_PUNCTUATION = / (?=[;:!?])/g;

/**
 * normalizeEditorialText, then French spacing: a no-break space inside « », and before ; : ! ?.
 * Idempotent.
 *
 * Straight quotes are left alone on purpose: `12"` is a record format, not a quotation (TRA-805).
 */
export function normalizeFrenchText(text: string): string {
	return normalizeEditorialText(text)
		.replace(AFTER_OPENING_GUILLEMET, `«${NBSP}`)
		.replace(BEFORE_CLOSING_GUILLEMET, `${NBSP}»`)
		.replace(SPACE_BEFORE_HIGH_PUNCTUATION, NBSP);
}
