import { pricingForModel, translationConfig } from "../config.js";
import type { ContentLocale } from "../node-spec.js";
import type { NodePayload, NodeTranslation } from "../types.js";
import { translationSourceHash, translationSourceOf } from "./source.js";
import { normalizeFrenchText } from "./typography.js";
import {
	type TranslationCandidate,
	type TranslationIssue,
	type TranslationSource,
	validateTranslation,
} from "./validate.js";

// Translates one node's text through an injected provider, judges the answer with the validator and retries
// once (TRA-806). The provider (Gemini, TRA-807) is the only thing that touches the network; this module
// writes no node and holds no state.

export interface GenerateJsonRequest {
	model: string;
	systemInstruction: string;
	prompt: string;
	responseSchema: unknown;
	temperature: number;
}

/**
 * Why the provider refused, kept for the operator (TRA-837, 2026-11-26). Without it, the pilot's 404 "model no
 * longer available" only read `provider_unavailable`, which means "wait and retry": no wait could fix it.
 * The provider has already removed the API key and the request text from `message`, and truncated it.
 */
export interface ProviderFailureDetail {
	/** HTTP status, absent for a failure that never got an answer (network, timeout). */
	status?: number;
	message: string;
}

/**
 * - `provider_rejected`: a refusal that holds for the whole batch (404 model not found, 401, 403). Retrying
 *   cannot succeed, unlike `quota_exhausted` and `provider_unavailable`, which are worth waiting out.
 * - `bad_request`: a 400. It often depends on this one request (a prompt the API refuses), so it fails this
 *   node only; the batch stops on it only when it repeats (a setting the model refuses for every node).
 *   Review of #742, 2026-11-26: treating a lone 400 as permanent froze every run on the same node.
 */
export type ProviderFailureReason =
	| "quota_exhausted"
	| "provider_unavailable"
	| "provider_rejected"
	| "bad_request";

export type GenerateJsonResult =
	| { ok: true; text: string; inputTokens: number; outputTokens: number }
	| { ok: false; reason: ProviderFailureReason; detail?: ProviderFailureDetail };

/** The provider boundary: the only thing tests replace. Never throws for a provider error. */
export type GenerateJson = (request: GenerateJsonRequest) => Promise<GenerateJsonResult>;

export interface TranslationUsage {
	inputTokens: number;
	outputTokens: number;
	/** null when the model has no known tariff: an unknown cost, not a free one. */
	costUsd: number | null;
}

export type TranslationFailure = ProviderFailureReason | "invalid_output";

export type TranslateOutcome =
	| { ok: true; translation: NodeTranslation; attempts: 1 | 2; usage: TranslationUsage }
	| {
			ok: false;
			reason: TranslationFailure;
			issues: TranslationIssue[];
			attempts: number;
			usage: TranslationUsage;
			/** Only on a provider failure that came with one. */
			detail?: ProviderFailureDetail;
	  };

export interface NodeTranslatorDeps {
	generate: GenerateJson;
	model?: string;
	now?: () => Date;
}

export type NodeTranslator = (node: NodePayload, locale: ContentLocale) => Promise<TranslateOutcome>;

const MAX_ATTEMPTS = 2;
/** The retry is deterministic: the first answer already showed what the model does when left free. */
const RETRY_TEMPERATURE = 0;

const SYSTEM_PROMPT = [
	"You translate the text of a music-culture encyclopedia entry from English into French.",
	"Write neutral editorial French and never address the reader. Add nothing and remove nothing.",
	"Keep identical the names of people, groups and labels, the titles of albums and tracks, and genre names.",
	"Translate the quotations of critics. Keep years and numbers.",
	"Keep the paragraphs: separate them with a blank line, as the source does.",
	"Use French quotation marks (« ») for what the source puts between quotation marks.",
	"Use no markup of any kind. Answer with a single JSON object and nothing else.",
].join("\n");

/** Plain-object schema in the provider's dialect (OpenAPI types in capitals), so the provider can pass it on. */
function responseSchemaFor(source: TranslationSource): unknown {
	const factKeys = Object.keys(source.facts);
	const properties: Record<string, unknown> = {
		teaser: { type: "STRING" },
		article: { type: "STRING" },
	};
	if (factKeys.length > 0) {
		properties.facts = {
			type: "OBJECT",
			properties: Object.fromEntries(factKeys.map((key) => [key, { type: "STRING" }])),
			required: factKeys,
		};
	}
	return { type: "OBJECT", properties, required: ["teaser", "article"] };
}

function promptFor(source: TranslationSource): string {
	const sections = [
		`Type: ${source.type}`,
		`Name: ${source.name}`,
		`Keep verbatim:\n${source.properNouns.map((noun) => `- ${noun}`).join("\n") || "- (none)"}`,
		`Teaser:\n${source.teaser}`,
		`Article:\n${source.article}`,
	];
	const facts = Object.entries(source.facts);
	if (facts.length > 0)
		sections.push(`Facts:\n${facts.map(([key, value]) => `- ${key}: ${value}`).join("\n")}`);
	return sections.join("\n\n");
}

function retryPromptFor(prompt: string, issues: readonly TranslationIssue[]): string {
	const lines = issues.map(
		(issue) => `- ${issue.code} (${issue.field})${issue.detail === undefined ? "" : `: ${issue.detail}`}`,
	);
	return `${prompt}\n\nYour previous answer was rejected. Fix these problems:\n${lines.join("\n")}`;
}

const MALFORMED_ANSWER = "response is not a JSON object with teaser and article";

/** Turns the raw model text into a candidate, or the issues that refuse it. Never throws. */
function candidateFrom(text: string): { candidate: TranslationCandidate } | { issues: TranslationIssue[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		const empty = (field: string): TranslationIssue => ({ code: "empty", field, detail: MALFORMED_ANSWER });
		return { issues: [empty("teaser"), empty("article")] };
	}
	const { teaser, article, facts } = parsed as Record<string, unknown>;
	const candidate: TranslationCandidate = { teaser: cleanText(teaser), article: cleanText(article) };
	if (typeof facts === "object" && facts !== null && !Array.isArray(facts)) {
		candidate.facts = Object.fromEntries(
			Object.entries(facts).map(([key, value]) => [key, cleanText(value)]),
		);
	}
	return { candidate };
}

/** A non-string becomes "", which the validator reports as empty. */
function cleanText(value: unknown): string {
	return typeof value === "string" ? normalizeFrenchText(value) : "";
}

export function createNodeTranslator(deps: NodeTranslatorDeps): NodeTranslator {
	const model = deps.model ?? translationConfig.model;
	const now = deps.now ?? (() => new Date());

	// `locale` is "fr" for now (ContentLocale); the prompt and the validator are French-only.
	return async (node, _locale) => {
		const source = translationSourceOf(node);
		const responseSchema = responseSchemaFor(source);
		const basePrompt = promptFor(source);
		let inputTokens = 0;
		let outputTokens = 0;
		let issues: TranslationIssue[] = [];
		// Priced at the tariff of the model actually called (TRA-836); null when it has none.
		const pricing = pricingForModel(model);
		const costUsd = () =>
			pricing === undefined
				? null
				: (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
		const usage = (): TranslationUsage => ({ inputTokens, outputTokens, costUsd: costUsd() });

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const result = await deps.generate({
				model,
				systemInstruction: SYSTEM_PROMPT,
				prompt: attempt === 1 ? basePrompt : retryPromptFor(basePrompt, issues),
				responseSchema,
				temperature: attempt === 1 ? translationConfig.temperature : RETRY_TEMPERATURE,
			});
			// Retrying a provider failure is the provider's job (TRA-807), not this function's.
			if (!result.ok)
				return {
					ok: false,
					reason: result.reason,
					issues: [],
					attempts: attempt,
					usage: usage(),
					...(result.detail === undefined ? {} : { detail: result.detail }),
				};
			inputTokens += result.inputTokens;
			outputTokens += result.outputTokens;

			const parsed = candidateFrom(result.text);
			issues = "issues" in parsed ? parsed.issues : validateTranslation(source, parsed.candidate);
			if (issues.length === 0 && "candidate" in parsed) {
				const { teaser, article, facts } = parsed.candidate;
				const translation: NodeTranslation = {
					teaser,
					article,
					...(facts !== undefined && Object.keys(source.facts).length > 0 ? { facts } : {}),
					source_sha256: translationSourceHash(source),
					model,
					translated_at: now().toISOString(),
				};
				return { ok: true, translation, attempts: attempt === 1 ? 1 : 2, usage: usage() };
			}
		}
		return { ok: false, reason: "invalid_output", issues, attempts: MAX_ATTEMPTS, usage: usage() };
	};
}
