import { createHash } from "node:crypto";
import {
	type ContentLocale,
	LIST_EDGES_BY_TYPE,
	SINGULAR_EDGES_BY_TYPE,
	TEASER_FIELD_BY_TYPE,
	TRANSLATABLE_FACT_FIELDS,
} from "../node-spec.js";
import type { NodePayload, NodeTranslation } from "../types.js";
import type { TranslationSource } from "./validate.js";

// The single definition of "what gets translated" for a node, and of the fingerprint that tells later whether
// a stored translation still matches it (TRA-805). Pure: no network, no cache access, no node write.

/** Edge targets whose names are proper nouns of the work. Genre names are common nouns and get translated. */
const PROPER_NOUN_EDGE_TYPES: ReadonlySet<string> = new Set(["artist", "label", "project", "track"]);
const MIN_PROPER_NOUN_LENGTH = 3;

/** What gets translated for this node, and the names that must survive. */
export function translationSourceOf(node: NodePayload): TranslationSource {
	const fields = node as unknown as Record<string, unknown>;
	const teaser = fields[TEASER_FIELD_BY_TYPE[node.type]];

	const facts: Record<string, string> = {};
	for (const field of TRANSLATABLE_FACT_FIELDS[node.type]) {
		const value = fields[field];
		if (typeof value === "string" && value.trim() !== "") facts[field] = value;
	}

	return {
		type: node.type,
		name: node.name,
		teaser: typeof teaser === "string" ? teaser : "",
		article: node.editorial_article,
		facts,
		properNouns: properNounsOf(node, fields),
	};
}

function properNounsOf(node: NodePayload, fields: Record<string, unknown>): string[] {
	const names: string[] = [];
	// A genre's own name ("ambient techno") is a common noun that the translation may legitimately render.
	if (node.type !== "genre") names.push(node.name);
	for (const field of [...LIST_EDGES_BY_TYPE[node.type], ...SINGULAR_EDGES_BY_TYPE[node.type]]) {
		const value = fields[field];
		const refs: unknown[] = Array.isArray(value) ? value : value === undefined ? [] : [value];
		for (const ref of refs) {
			if (typeof ref !== "object" || ref === null) continue;
			const { type, name } = ref as { type?: unknown; name?: unknown };
			if (typeof type === "string" && PROPER_NOUN_EDGE_TYPES.has(type) && typeof name === "string") {
				names.push(name);
			}
		}
	}
	return [...new Set(names)].filter((name) => name.length >= MIN_PROPER_NOUN_LENGTH);
}

/**
 * sha256 hex of JSON.stringify([teaser, article, [[field, value], ...]]), UTF-8.
 *
 * Why it covers text only, not names: the data channel merges edges into a node without changing its text,
 * and the translation must stay current when that happens.
 *
 * The order of `facts` is part of the fingerprint: build it with `translationSourceOf` (declaration order of
 * TRANSLATABLE_FACT_FIELDS), never from a parsed or model-produced object.
 */
export function translationSourceHash(
	source: Pick<TranslationSource, "teaser" | "article" | "facts">,
): string {
	const payload = JSON.stringify([source.teaser, source.article, Object.entries(source.facts)]);
	return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** The node's translation for `locale` when its source_sha256 matches the node's text today. */
export function currentTranslation(node: NodePayload, locale: ContentLocale): NodeTranslation | undefined {
	const translation = node.l10n?.[locale];
	if (translation === undefined) return undefined;
	return translation.source_sha256 === translationSourceHash(translationSourceOf(node))
		? translation
		: undefined;
}
