import type { NodeType } from "../node-spec.js";

// Form judge for model-produced translations (TRA-803). The model output is untrusted data, so every
// check here is a cheap, deterministic structural test: no network, no model, no cache access.
// Fidelity rules (proper nouns, titles, years: TRA-804) check that what the source field names survives.

export interface TranslationSource {
	type: NodeType;
	name: string;
	teaser: string;
	article: string;
	/** Translatable facts only, non-blank. */
	facts: Record<string, string>;
	/**
	 * Names that must survive verbatim. May hold names the text never cites (edge names): only those present
	 * in the source field are enforced.
	 */
	properNouns: readonly string[];
}

export interface TranslationCandidate {
	teaser: string;
	article: string;
	facts?: Record<string, string>;
}

export type TranslationIssueCode =
	| "empty"
	| "too_short"
	| "length_ratio"
	| "paragraph_count"
	| "missing_proper_noun"
	| "missing_title"
	| "missing_year"
	| "not_french"
	| "markup"
	| "escape_leftover"
	| "url_added"
	| "fact_keys"
	| "fact_untranslated";

export interface TranslationIssue {
	code: TranslationIssueCode;
	/** "teaser", "article" or "facts.<name>". */
	field: string;
	/** A short excerpt, never the whole text. */
	detail?: string;
}

type ProseField = "teaser" | "article";

interface RatioBounds {
	min: number;
	max: number;
}

// Thresholds are decided in the plan (D3); do not tune them without measuring on the pilot (TRA-2.5).
export const MIN_ARTICLE_LENGTH = 80;
const RATIO_BOUNDS: Record<ProseField, RatioBounds> = {
	article: { min: 0.7, max: 1.7 },
	teaser: { min: 0.6, max: 2.0 },
};
const FACT_RATIO_FACTOR = 3;
const FACT_RATIO_SLACK = 20;
const TEASER_MIN_WORDS_FOR_LANGUAGE_CHECK = 12;
const MIN_FRENCH_SHARE = 0.1;
const MAX_ENGLISH_SHARE = 0.08;
/** Hard cap so an issue never echoes a whole (possibly huge, possibly hostile) text back. */
const MAX_DETAIL_LENGTH = 120;
const EXCERPT_RADIUS = 30;

const FRENCH_STOPWORDS: ReadonlySet<string> = new Set(
	"le la les des du de un une et est dans en que qui pour avec sur par au aux".split(" "),
);
const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set("the and of with is was by from which".split(" "));

/**
 * Words that mark a fact value as English when it comes back untouched (TRA-845). A closed list, not a
 * language detector: facts are a few words long ("Germany and Japan"), too short for the stopword shares of
 * checkLanguage. Each entry is a word the French value spells differently: a connector or period word
 * ("and", "present", "early", "century") or a country the batch actually left in English ("Germany" is
 * « Allemagne »). Names spelled alike in both languages (Europe, France, Detroit) are deliberately absent:
 * an unchanged value made of them is a correct translation. So are the words that sit inside place names
 * French keeps as they are (compass words in "East Lansing", "in" and "of" in "Barrow-in-Furness" and
 * "Isle of Wight", "the" in "The Hague", "mid" in "Mid-City"): WORD splits a hyphenated name, so such a
 * word would refuse a correct value twice (review of TRA-845). A miss costs one English fact; a false hit
 * would refuse a valid node twice, so the list stays short. Compared lowercase, whole words.
 */
const ENGLISH_FACT_MARKERS: ReadonlySet<string> = new Set(
	(
		"and or to from since until present early late century centuries " +
		"united states kingdom uk usa america england scotland wales ireland " +
		"germany japan spain italy sweden netherlands belgium switzerland denmark norway poland russia " +
		"brazil mexico china australia austria finland greece turkey argentina egypt iceland"
	).split(" "),
);
/** "1990s", "80s": the English decade; French writes « années 1990 ». Not "808s" or "909s": those are gear. */
const ENGLISH_DECADE = /(?<!\d)(?:\d{3}0s|\d0s)\b/i;
/** Case, spacing and punctuation do not make a translation: "United states." is still the source. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

const WORD = /\p{L}+/gu;
const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'«»“”]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
// Quote openers: "…", “…” or «…». Single quotes are not delimiters: an elision ('90s) and a possessive
// (Smiths') would pair up into a fake passage (2026-11-23, TRA-804 review). A straight quote right after
// a digit is an inch mark (12"), not an opening quote: it used to pair with the next straight quote and
// swallow whole paragraphs before the language check (2026-11-24, TRA-824).
const QUOTE_OPENER = /(?<!\d)"|[“«]/g;
const QUOTE_CLOSER: Readonly<Record<string, string>> = { '"': '"', "“": "”", "«": "»" };
const SPACE_BEFORE_PUNCTUATION = /[   ]+(?=[:;!?])/g;
// Case-insensitive (2026-11-24, AI review of #726): « Années 60 » opens sentences and headings.
const SHORT_DECADE = /années\s+(\d0)(?!\d)/giu;
const YEAR = /(?<!\d)(?:1\d{3}|20\d{2})(?!\d)/g;
const TYPOGRAPHIC_APOSTROPHE = /[’ʼ‘]/g;
const THOUSANDS_SPACE = /(?<!\d)(\d{1,3})[   ](?=\d{3}(?!\d))/g;
const LETTER_OR_DIGIT_BEFORE = /[\p{L}\p{N}]$/u;
const LETTER_OR_DIGIT_AFTER = /^[\p{L}\p{N}]/u;
const CAPITAL_OR_DIGIT_START = /^[\p{Lu}\p{N}]/u;
const MAX_TITLE_WORDS = 8;
const MIN_TITLE_CAPITALS = 2;
const BLANK_LINE_SEPARATOR = /\n(?:[^\S\n]*\n)+/;

/** Empty array = accepted. Pure and deterministic. */
export function validateTranslation(
	source: TranslationSource,
	candidate: TranslationCandidate,
): TranslationIssue[] {
	const issues: TranslationIssue[] = [];
	// The candidate comes straight from a model: the types say strings, the runtime may disagree.
	// Treat anything else as absent rather than throwing (typed results at the boundary).
	const { properNouns } = source;
	checkProse("teaser", source.teaser, asText(candidate.teaser), properNouns, issues);
	checkProse("article", source.article, asText(candidate.article), properNouns, issues);
	checkFacts(source.facts, asRecord(candidate.facts), properNouns, issues);
	return issues;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function checkProse(
	field: ProseField,
	sourceText: string,
	candidateText: string,
	properNouns: readonly string[],
	issues: TranslationIssue[],
): void {
	const original = normalizeNewlines(sourceText).trim();
	const text = normalizeNewlines(candidateText).trim();

	// An empty field has nothing else worth reporting: every other rule would only add noise.
	if (text === "") {
		issues.push({ code: "empty", field });
		return;
	}
	if (field === "article" && text.length < MIN_ARTICLE_LENGTH) {
		issues.push({ code: "too_short", field, detail: `${text.length} chars` });
	}
	checkLengthRatio(field, original, text, RATIO_BOUNDS[field], issues);

	if (field === "teaser") {
		if (text.includes("\n")) issues.push({ code: "paragraph_count", field, detail: "line break in teaser" });
	} else {
		const expected = countParagraphs(original);
		const actual = countParagraphs(text);
		if (actual !== expected) {
			issues.push({ code: "paragraph_count", field, detail: `expected ${expected}, got ${actual}` });
		}
	}

	checkSurface(field, original, text, issues);
	checkLanguage(field, text, issues);
	checkFidelity(field, original, text, properNouns, issues);
}

function checkFacts(
	sourceFacts: Record<string, string>,
	candidateFacts: Record<string, unknown>,
	properNouns: readonly string[],
	issues: TranslationIssue[],
): void {
	for (const key of Object.keys(sourceFacts)) {
		const field = `facts.${key}`;
		if (!Object.hasOwn(candidateFacts, key)) {
			issues.push({ code: "fact_keys", field, detail: "missing from candidate" });
			continue;
		}
		const value = asText(candidateFacts[key]).trim();
		if (value === "") {
			issues.push({ code: "fact_keys", field, detail: "empty or non-string value" });
			continue;
		}
		const original = (sourceFacts[key] ?? "").trim();
		if (value.length > FACT_RATIO_FACTOR * original.length + FACT_RATIO_SLACK) {
			issues.push({
				code: "length_ratio",
				field,
				detail: `${value.length} chars for a ${original.length}-char source`,
			});
		}
		checkSurface(field, original, value, issues);
		checkFidelity(field, original, value, properNouns, issues);
		checkUntranslated(field, original, value, properNouns, issues);
	}
	for (const key of Object.keys(candidateFacts)) {
		if (!Object.hasOwn(sourceFacts, key)) {
			issues.push({ code: "fact_keys", field: `facts.${clip(key)}`, detail: "not in source" });
		}
	}
}

/**
 * 2026-11-27 (TRA-845): a fact handed back as the source wrote it, while the source holds an English word.
 * The symptom: on the genre batch (TRA-819) 106 of 314 genres kept `origin` and `era` in English
 * ("United States", "1960s–present") under a French article, and a forced second run changed nothing for
 * 106 of 110: the model returns the whole fact block unchanged and no rule looked at its language.
 * Only an identical value is judged: names and years that must survive (checkFidelity) make a translated
 * value legitimately close to its source, so a partial translation stays out of this rule's reach.
 */
function checkUntranslated(
	field: string,
	rawOriginal: string,
	rawValue: string,
	rawProperNouns: readonly string[],
	issues: TranslationIssue[],
): void {
	const original = normalizeTypography(rawOriginal);
	if (looseForm(rawValue) !== looseForm(original)) return;
	// The names the source asks to keep are not English words, whatever they are made of. A name that is
	// itself a marker is not exempt: a band called "Japan" must not excuse the country left in English.
	let rest = original;
	for (const noun of new Set(rawProperNouns.map(normalizeTypography))) {
		if (noun !== "" && !ENGLISH_FACT_MARKERS.has(noun.toLowerCase())) rest = rest.split(noun).join(" ");
	}
	const marker = (rest.toLowerCase().match(WORD) ?? []).find((word) => ENGLISH_FACT_MARKERS.has(word));
	const found = marker ?? ENGLISH_DECADE.exec(rest)?.[0];
	if (found !== undefined) {
		issues.push({
			code: "fact_untranslated",
			field,
			detail: `identical to the English source ("${found}"): translate it into French`,
		});
	}
}

function looseForm(text: string): string {
	return normalizeTypography(text).toLowerCase().replace(NON_ALPHANUMERIC, " ").trim();
}

function checkLengthRatio(
	field: string,
	original: string,
	text: string,
	bounds: RatioBounds,
	issues: TranslationIssue[],
): void {
	if (original.length === 0) return; // no baseline to compare against
	const ratio = text.length / original.length;
	if (ratio < bounds.min || ratio > bounds.max) {
		issues.push({ code: "length_ratio", field, detail: `ratio ${ratio.toFixed(2)}` });
	}
}

/** Markup, literal escapes and added URLs: shared by prose fields and facts. */
function checkSurface(field: string, original: string, text: string, issues: TranslationIssue[]): void {
	const markup = findMarkup(original, text);
	if (markup)
		issues.push({ code: "markup", field, detail: excerptAround(text, markup.index, markup.length) });

	const escapeIndex = findEscapeLeftover(text);
	if (escapeIndex >= 0) {
		issues.push({ code: "escape_leftover", field, detail: excerptAround(text, escapeIndex, 2) });
	}

	const sourceUrls = new Set(extractUrls(original));
	const added = extractUrls(text).find((url) => !sourceUrls.has(url));
	if (added !== undefined) issues.push({ code: "url_added", field, detail: clip(added) });
}

function findMarkup(original: string, text: string): { index: number; length: number } | undefined {
	// Every marker is only suspicious when the source did not carry it itself: a faithful translation of
	// "#1 in the UK" keeps its leading "#" and must not be refused.
	if (!original.includes("```")) {
		const fence = text.indexOf("```");
		if (fence >= 0) return { index: fence, length: 3 };
	}
	if (!/^#/m.test(original)) {
		const heading = /^#/m.exec(text);
		if (heading) return { index: heading.index, length: 1 };
	}
	for (const marker of ["**", "__"]) {
		if (original.includes(marker)) continue;
		const index = text.indexOf(marker);
		if (index >= 0) return { index, length: 2 };
	}
	return undefined;
}

/** A model that double-escapes its JSON leaves a literal backslash-n or backslash-quote behind. */
function findEscapeLeftover(text: string): number {
	const newline = text.indexOf("\\n");
	const quote = text.indexOf('\\"');
	if (newline < 0) return quote;
	if (quote < 0) return newline;
	return Math.min(newline, quote);
}

function extractUrls(text: string): string[] {
	return (text.match(URL_PATTERN) ?? []).map((url) => url.replace(TRAILING_PUNCTUATION, ""));
}

/** Names, titles and years found in the source field must come back unchanged in the candidate field. */
function checkFidelity(
	field: string,
	rawOriginal: string,
	rawText: string,
	rawProperNouns: readonly string[],
	issues: TranslationIssue[],
): void {
	// Typographic apostrophes and Unicode forms are not a change of name: compare the normalised forms.
	const original = normalizeTypography(rawOriginal);
	const text = normalizeTypography(rawText);
	const properNouns = rawProperNouns.map(normalizeTypography);
	for (const noun of new Set(properNouns)) {
		if (noun !== "" && containsName(original, noun) && !hasName(text, noun)) {
			issues.push({ code: "missing_proper_noun", field, detail: clip(noun) });
		}
	}
	for (const title of extractTitles(original, properNouns)) {
		if (text.includes(title) || (properNouns.includes(title) && hasName(text, title))) continue;
		issues.push({ code: "missing_title", field, detail: clip(title) });
	}
	const present = countYears(text);
	addShortDecades(present, original, text);
	for (const [year, count] of countYears(original)) {
		if ((present.get(year) ?? 0) < count) issues.push({ code: "missing_year", field, detail: year });
	}
}

function normalizeTypography(text: string): string {
	// French puts a (no-break) space before : ; ! ? ("Mezzanine : Live"): it is not part of a name.
	return text.normalize("NFC").replace(TYPOGRAPHIC_APOSTROPHE, "'").replace(SPACE_BEFORE_PUNCTUATION, "");
}

/** A name may lose its leading English article in French: "The Beatles" becomes "les Beatles". */
function hasName(text: string, name: string): boolean {
	return containsName(text, name) || (name.startsWith("The ") && containsName(text, name.slice(4)));
}

/** The source decade "the 1960s" may come back as "années 60": count that as the full year. */
function addShortDecades(present: Map<string, number>, original: string, text: string): void {
	for (const match of text.matchAll(SHORT_DECADE)) {
		for (const year of [`19${match[1]}`, `20${match[1]}`]) {
			if (new RegExp(`(?<!\\d)${year}s`).test(original)) present.set(year, (present.get(year) ?? 0) + 1);
		}
	}
}

/**
 * Splits text into its quoted passages (delimiters included, in order, non-overlapping) and the text
 * outside them. Linear on purpose: it reads model output, and a regex retried from every unclosed opener
 * was quadratic (20,000 unclosed « took 1.4 s, 2026-11-24, TRA-804 deep review). Once a closer is
 * missing, no later opener of that kind can find one, so each closer is searched for until its first miss.
 */
function splitQuotes(text: string): { passages: string[]; outside: string } {
	const passages: string[] = [];
	const outside: string[] = [];
	const exhausted = new Set<string>();
	let copied = 0;
	QUOTE_OPENER.lastIndex = 0;
	for (let open = QUOTE_OPENER.exec(text); open !== null; open = QUOTE_OPENER.exec(text)) {
		const closer = QUOTE_CLOSER[open[0]] as string;
		if (exhausted.has(closer)) continue;
		const close = text.indexOf(closer, open.index + 1);
		if (close < 0) {
			exhausted.add(closer);
			continue;
		}
		outside.push(text.slice(copied, open.index));
		passages.push(text.slice(open.index, close + 1));
		copied = close + 1;
		QUOTE_OPENER.lastIndex = copied;
	}
	outside.push(text.slice(copied));
	return { passages, outside: outside.join(" ") };
}

/** Exact, case-sensitive match that neither starts nor ends in the middle of a word ("Air" vs "Airplay"). */
function containsName(text: string, name: string): boolean {
	for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
		const glued =
			LETTER_OR_DIGIT_BEFORE.test(text.slice(0, at)) ||
			LETTER_OR_DIGIT_AFTER.test(text.slice(at + name.length));
		if (!glued) return true;
	}
	return false;
}

/** Quoted passages that are known names or look like titles; quotes and a final punctuation mark removed. */
function extractTitles(text: string, properNouns: readonly string[]): Set<string> {
	const known = new Set(properNouns.map((noun) => noun.toLowerCase()));
	const titles = new Set<string>();
	for (const passage of splitQuotes(text).passages) {
		const inner = passage.slice(1, -1).trim().replace(TRAILING_PUNCTUATION, "").trim();
		if (inner !== "" && (known.has(inner.toLowerCase()) || looksLikeTitle(inner))) titles.add(inner);
	}
	return titles;
}

function looksLikeTitle(inner: string): boolean {
	const words = inner.split(/\s+/);
	const capitalized = words.filter((word) => CAPITAL_OR_DIGIT_START.test(word)).length;
	// At least two capitalised words: a lone capitalised word or phrase is usually a critic's quoted
	// remark ("Pure genius", "Thanks"), which French translates. Lone titles are caught via properNouns.
	return (
		words.length <= MAX_TITLE_WORDS && capitalized >= MIN_TITLE_CAPITALS && capitalized * 2 >= words.length
	);
}

function countYears(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	// French groups thousands with a space ("1 500"): read it as the same quantity as the English "1500".
	for (const match of text.replace(THOUSANDS_SPACE, "$1").matchAll(YEAR)) {
		counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
	}
	return counts;
}

function checkLanguage(field: ProseField, text: string, issues: TranslationIssue[]): void {
	// Quoted passages are titles or verbatim quotes that legitimately stay in English.
	const words = (splitQuotes(text).outside.toLowerCase().match(WORD) ?? []) as string[];
	if (words.length === 0) return;
	// The short-teaser exemption counts the words actually judged: too few of them make the shares noise.
	if (field === "teaser" && words.length < TEASER_MIN_WORDS_FOR_LANGUAGE_CHECK) return;

	const frenchShare = words.filter((word) => FRENCH_STOPWORDS.has(word)).length / words.length;
	const englishShare = words.filter((word) => ENGLISH_STOPWORDS.has(word)).length / words.length;
	if (frenchShare < MIN_FRENCH_SHARE || englishShare > MAX_ENGLISH_SHARE) {
		issues.push({
			code: "not_french",
			field,
			detail: `french ${percent(frenchShare)}, english ${percent(englishShare)}`,
		});
	}
}

function countParagraphs(text: string): number {
	return text.split(BLANK_LINE_SEPARATOR).filter((part) => part.trim() !== "").length;
}

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function percent(share: number): string {
	return `${Math.round(share * 100)}%`;
}

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= MAX_DETAIL_LENGTH ? flat : `${flat.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

function excerptAround(text: string, index: number, length: number): string {
	const start = Math.max(0, index - EXCERPT_RADIUS);
	return clip(text.slice(start, index + length + EXCERPT_RADIUS));
}
