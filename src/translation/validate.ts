import type { NodeType } from "../node-spec.js";

// Form judge for model-produced translations (TRA-803). The model output is untrusted data, so every
// check here is a cheap, deterministic structural test: no network, no model, no cache access.
// Rules here: emptiness, length, paragraphs, language. Surface rules (markup, escapes, URLs, fact keys)
// come with TRA-820; fidelity rules (proper nouns, titles, years) belong to TRA-1.3; their codes are declared below so
// that ticket does not have to change an exported type.

export interface TranslationSource {
	type: NodeType;
	name: string;
	teaser: string;
	article: string;
	/** Translatable facts only, non-blank. */
	facts: Record<string, string>;
	/** Names that must survive verbatim. Reserved: enforced by TRA-1.3, not by this ticket's rules. */
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
	| "fact_keys";

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
const MIN_ARTICLE_LENGTH = 80;
const RATIO_BOUNDS: Record<ProseField, RatioBounds> = {
	article: { min: 0.7, max: 1.7 },
	teaser: { min: 0.6, max: 2.0 },
};
const FACT_RATIO_FACTOR = 3;
const FACT_RATIO_SLACK = 20;
const TEASER_MIN_WORDS_FOR_LANGUAGE_CHECK = 12;
const MIN_FRENCH_SHARE = 0.1;
const MAX_ENGLISH_SHARE = 0.08;

const FRENCH_STOPWORDS: ReadonlySet<string> = new Set(
	"le la les des du de un une et est dans en que qui pour avec sur par au aux".split(" "),
);
const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set("the and of with is was by from which".split(" "));

const QUOTED_PASSAGE = /"[^"]*"|“[^”]*”|«[^»]*»/g;
const WORD = /\p{L}+/gu;
const BLANK_LINE_SEPARATOR = /\n(?:[^\S\n]*\n)+/;

/** Empty array = accepted. Pure and deterministic. */
export function validateTranslation(
	source: TranslationSource,
	candidate: TranslationCandidate,
): TranslationIssue[] {
	const issues: TranslationIssue[] = [];
	checkProse("teaser", source.teaser, candidate.teaser, issues);
	checkProse("article", source.article, candidate.article, issues);
	checkFacts(source.facts, candidate.facts ?? {}, issues);
	return issues;
}

function checkProse(
	field: ProseField,
	sourceText: string,
	candidateText: string,
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

	checkLanguage(field, text, issues);
}

/** Key and value rules for facts come with TRA-820; here only the length bound of rule 2 applies. */
function checkFacts(
	sourceFacts: Record<string, string>,
	candidateFacts: Record<string, string>,
	issues: TranslationIssue[],
): void {
	for (const [key, rawValue] of Object.entries(candidateFacts)) {
		if (!Object.hasOwn(sourceFacts, key)) continue;
		const value = rawValue.trim();
		const original = (sourceFacts[key] ?? "").trim();
		if (value.length > FACT_RATIO_FACTOR * original.length + FACT_RATIO_SLACK) {
			issues.push({
				code: "length_ratio",
				field: `facts.${key}`,
				detail: `${value.length} chars for a ${original.length}-char source`,
			});
		}
	}
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

function checkLanguage(field: ProseField, text: string, issues: TranslationIssue[]): void {
	// Quoted passages are titles or verbatim quotes that legitimately stay in English.
	const words = (text.replace(QUOTED_PASSAGE, " ").toLowerCase().match(WORD) ?? []) as string[];
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
