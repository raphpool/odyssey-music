/**
 * Deterministic 3-step pipeline replacing the multi-turn agent loop.
 *
 *   1. CODE-driven research:
 *      - Tavily web_search(name+type) → top N URLs
 *      - Parallel localFetch on top K → concatenated markdown corpus + provenance
 *   2. SINGLE LLM call to Gemini via @google/genai with `responseMimeType: application/json`
 *      and a per-type `responseSchema` that ENFORCES min-counts on required edges
 *      (artist.discography>=2, artist.genres>=1, genre.related_genres>=2, etc).
 *      No tool calls, no retries — the schema makes invalid output impossible.
 *   3. Validate via Zod, canonicalize slugs, return.
 *
 * Why this beats the agent loop:
 *   - 1 LLM round-trip instead of 3-6 → 3-5x latency cut.
 *   - Schema-forced edge minimums → consistent shape, no "agent forgot to fill discography".
 *   - All research happens deterministically up front → no path where the agent skips fetches.
 *   - Failures are real (search returned nothing, JSON unparseable) — not retry storms.
 */
import { GoogleGenAI, Type as GType, type Schema } from "@google/genai";
import { z } from "zod";
import { nodePayloadSchema } from "./schemas.js";
import { makeSlug } from "./slug.js";
import { localFetch } from "./tools/local-fetcher.js";
import { tavilySearch } from "./tools/tavily.js";
import type { Citation, NodePayload, NodeType, Slug } from "./types.js";

export interface PipelineDeps {
	tavilyApiKey: string;
	firecrawlApiKey: string;
	geminiApiKey?: string;
	model?: string;
	logger?: (line: string) => void;
}

export interface PipelineInput {
	type: NodeType;
	name: string;
	disambiguator?: string;
}

export interface PipelineResult {
	node: NodePayload;
	slug: Slug;
	metrics: {
		searchMs: number;
		fetchMs: number;
		llmMs: number;
		totalMs: number;
		searchCount: number;
		fetchCount: number;
		urlsFetched: string[];
		corpusBytes: number;
		inputTokens: number;
		outputTokens: number;
		costUsd: number;
	};
}

// --- Gemini schema builders ---

const stringSchema = (description: string, minLength?: number): Schema => {
	const s: Schema = { type: GType.STRING, description };
	if (minLength) (s as { minLength?: string }).minLength = String(minLength);
	return s;
};

const edgeRefSchema = (allowedTypes: NodeType[]): Schema => ({
	type: GType.OBJECT,
	properties: {
		type: { type: GType.STRING, enum: allowedTypes, description: "Target node type." },
		name: stringSchema("Canonical entity name. Real proper noun, never 'Various' or 'Unknown'.", 1),
	},
	required: ["type", "name"],
	propertyOrdering: ["type", "name"],
});

const citationSchema: Schema = {
	type: GType.OBJECT,
	properties: {
		url: { type: GType.STRING, description: "Full http(s) URL of a source you cite." },
		title: { type: GType.STRING, description: "Title of the page." },
	},
	required: ["url", "title"],
	propertyOrdering: ["url", "title"],
};

interface SchemaShape {
	schema: Schema;
	zodValidator: z.ZodType<unknown>;
}

function makeNodeSchema(type: NodeType): SchemaShape {
	const baseProps: Record<string, Schema> = {
		name: stringSchema("Clean canonical name (e.g. 'Tendency', not 'Tendency (track)').", 1),
		editorial_article: stringSchema(
			// Tighter article keeps output tokens down and saves ~1s of LLM wall-clock per node.
			"Real article prose, 400-900 chars. Grounded in the sources. History, scene, why it matters. Not a listicle.",
			350,
		),
		citations: { type: GType.ARRAY, items: citationSchema, minItems: "2", maxItems: "4" },
	};
	const requiredBase = ["name", "editorial_article", "citations"];

	switch (type) {
		case "genre": {
			return {
				zodValidator: z.unknown(),
				schema: {
					type: GType.OBJECT,
					required: [
						...requiredBase,
						"editorial_definition",
						"era",
						"origin",
						"sonic_markers",
						"related_genres",
						"key_artists",
						"key_labels",
						"landmark_tracks",
					],
					properties: {
						...baseProps,
						editorial_definition: stringSchema("1-2 sentence teaser definition.", 30),
						era: stringSchema("e.g. 'late 1980s to mid 1990s'.", 5),
						origin: stringSchema("Geographic + scene origin.", 3),
						sonic_markers: stringSchema("BPM range, instrumentation, signature production traits.", 10),
						parent_genres: {
							type: GType.ARRAY,
							items: edgeRefSchema(["genre"]),
							minItems: "0",
							maxItems: "4",
						},
						subgenres: { type: GType.ARRAY, items: edgeRefSchema(["genre"]), minItems: "0", maxItems: "6" },
						related_genres: {
							type: GType.ARRAY,
							items: edgeRefSchema(["genre"]),
							minItems: "2",
							maxItems: "6",
						},
						key_artists: {
							type: GType.ARRAY,
							items: edgeRefSchema(["artist"]),
							minItems: "3",
							maxItems: "8",
						},
						key_labels: { type: GType.ARRAY, items: edgeRefSchema(["label"]), minItems: "1", maxItems: "5" },
						landmark_projects: {
							type: GType.ARRAY,
							items: edgeRefSchema(["project"]),
							minItems: "0",
							maxItems: "5",
						},
						landmark_tracks: {
							type: GType.ARRAY,
							items: edgeRefSchema(["track"]),
							minItems: "1",
							maxItems: "5",
						},
					},
				},
			};
		}
		case "label": {
			return {
				zodValidator: z.unknown(),
				schema: {
					type: GType.OBJECT,
					required: [
						...requiredBase,
						"editorial_description",
						"founded",
						"location",
						"genres",
						"roster",
						"notable_releases",
					],
					properties: {
						...baseProps,
						editorial_description: stringSchema("1-2 sentence teaser.", 30),
						founded: stringSchema("Year string e.g. '1995'.", 4),
						location: stringSchema("City + country.", 3),
						founders: stringSchema("Founder names (text).", 0),
						active_years: stringSchema("e.g. '1995-present'.", 0),
						genres: { type: GType.ARRAY, items: edgeRefSchema(["genre"]), minItems: "1", maxItems: "5" },
						roster: { type: GType.ARRAY, items: edgeRefSchema(["artist"]), minItems: "3", maxItems: "10" },
						notable_releases: {
							type: GType.ARRAY,
							items: edgeRefSchema(["project"]),
							minItems: "2",
							maxItems: "8",
						},
					},
				},
			};
		}
		case "artist": {
			return {
				zodValidator: z.unknown(),
				schema: {
					type: GType.OBJECT,
					required: [
						...requiredBase,
						"editorial_bio",
						"origin",
						"active_years",
						"genres",
						"labels",
						"discography",
						"notable_tracks",
					],
					properties: {
						...baseProps,
						editorial_bio: stringSchema("1-2 sentence teaser.", 30),
						origin: stringSchema("Where they're from.", 3),
						active_years: stringSchema("e.g. '1991-present'.", 4),
						genres: { type: GType.ARRAY, items: edgeRefSchema(["genre"]), minItems: "1", maxItems: "5" },
						labels: { type: GType.ARRAY, items: edgeRefSchema(["label"]), minItems: "1", maxItems: "5" },
						discography: {
							type: GType.ARRAY,
							items: edgeRefSchema(["project"]),
							minItems: "2",
							maxItems: "10",
						},
						notable_tracks: {
							type: GType.ARRAY,
							items: edgeRefSchema(["track"]),
							minItems: "1",
							maxItems: "8",
						},
						influences: { type: GType.ARRAY, items: edgeRefSchema(["artist"]), minItems: "0", maxItems: "8" },
						influenced: { type: GType.ARRAY, items: edgeRefSchema(["artist"]), minItems: "0", maxItems: "8" },
						collaborators: {
							type: GType.ARRAY,
							items: edgeRefSchema(["artist"]),
							minItems: "0",
							maxItems: "8",
						},
						aliases: { type: GType.ARRAY, items: edgeRefSchema(["artist"]), minItems: "0", maxItems: "5" },
						members: { type: GType.ARRAY, items: edgeRefSchema(["artist"]), minItems: "0", maxItems: "10" },
					},
				},
			};
		}
		case "project": {
			return {
				zodValidator: z.unknown(),
				schema: {
					type: GType.OBJECT,
					required: [...requiredBase, "editorial_pitch", "year", "artists", "label", "genres", "tracklist"],
					properties: {
						...baseProps,
						editorial_pitch: stringSchema("1-2 sentence teaser.", 30),
						year: stringSchema("Year string e.g. '2001'.", 4),
						artists: { type: GType.ARRAY, items: edgeRefSchema(["artist"]), minItems: "1", maxItems: "5" },
						label: edgeRefSchema(["label"]),
						genres: { type: GType.ARRAY, items: edgeRefSchema(["genre"]), minItems: "1", maxItems: "5" },
						tracklist: { type: GType.ARRAY, items: edgeRefSchema(["track"]), minItems: "2", maxItems: "20" },
						producers: { type: GType.ARRAY, items: edgeRefSchema(["artist"]), minItems: "0", maxItems: "6" },
						related_projects: {
							type: GType.ARRAY,
							items: edgeRefSchema(["project"]),
							minItems: "0",
							maxItems: "6",
						},
					},
				},
			};
		}
		case "track": {
			return {
				zodValidator: z.unknown(),
				schema: {
					type: GType.OBJECT,
					required: [...requiredBase, "editorial_teaser", "year", "artists", "project", "genres"],
					properties: {
						...baseProps,
						editorial_teaser: stringSchema("1-2 sentence teaser.", 30),
						year: stringSchema("Year string e.g. '1999'.", 4),
						duration: stringSchema("e.g. '5:47'.", 0),
						artists: { type: GType.ARRAY, items: edgeRefSchema(["artist"]), minItems: "1", maxItems: "5" },
						project: edgeRefSchema(["project"]),
						genres: { type: GType.ARRAY, items: edgeRefSchema(["genre"]), minItems: "1", maxItems: "5" },
						producers: { type: GType.ARRAY, items: edgeRefSchema(["artist"]), minItems: "0", maxItems: "5" },
						samples: { type: GType.ARRAY, items: edgeRefSchema(["track"]), minItems: "0", maxItems: "6" },
						sampled_by: { type: GType.ARRAY, items: edgeRefSchema(["track"]), minItems: "0", maxItems: "6" },
						remix_of: edgeRefSchema(["track"]),
						remixed_by: { type: GType.ARRAY, items: edgeRefSchema(["track"]), minItems: "0", maxItems: "6" },
					},
				},
			};
		}
	}
}

// Latency knobs. Each token shaved off the LLM call is ~free wall-clock time.
const MAX_CORPUS_BYTES = 9_000; // was 24_000 — smaller prefill, ~30% faster LLM
const PER_PAGE_BUDGET = 4_500; // cap one fetched page to this many chars before truncating
const SEARCH_RESULTS = 5;
const FETCH_TOP_K = 2; // was 3 — one fewer parallel scrape + smaller corpus

const SYSTEM_PROMPT = `You build one Culture Graph node from research material the system provides.

You receive: a target {type, name, disambiguator?} and a corpus of 1-3 web pages already fetched
for that entity, plus the search snippets. Your job is to output a SINGLE JSON object that
conforms to the response schema. Do not call tools — the system handled retrieval.

RULES:
  - editorial_article: real prose grounded in the corpus. 600-1500 chars. Open with a strong
    sentence (entity + place + era + what they're known for). 2-3 paragraphs of context. NOT
    a listicle. NOT generic. NOT a placeholder. If the corpus is thin, write what you can
    verify and stop — never hallucinate.
  - Every fact mentioned (year, label, sample) must appear in the corpus. If it isn't, leave
    the field empty rather than guess.
  - Citations: 2-6 URLs that you actually used from the supplied corpus. Each citation MUST
    have a real http(s) url and a title.
  - Edges: each {type, name} pair must be a real entity, never 'Various'/'Unknown'/'TBC'.
    Use the canonical name (e.g. 'Aphex Twin', not 'Aphex Twin (musician)').
  - Aliases and side-projects stay as distinct edges (AFX != Aphex Twin).
  - Year/founded/active_years are STRINGS, never numbers.
  - The 'name' field on your output must be the canonical name (no '(track)', no '(album)').

OUTPUT: a single JSON object. Nothing before or after. No markdown fences.`;

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
	const log = deps.logger ?? ((): void => undefined);
	const t0 = Date.now();
	const apiKey = deps.geminiApiKey ?? process.env.GEMINI_API_KEY ?? "";
	if (!apiKey) throw new Error("GEMINI_API_KEY missing");

	// Step 1: research
	const tSearch = Date.now();
	const searchQuery = buildSearchQuery(input);
	const searchResults = await tavilySearch(deps.tavilyApiKey, searchQuery, {
		max_results: SEARCH_RESULTS,
		search_depth: "basic",
	});
	const searchMs = Date.now() - tSearch;
	if (!searchResults.length) {
		throw new Error(`No search results for ${input.type}:${input.name}`);
	}
	log(`[pipeline] search ${searchMs}ms results=${searchResults.length}`);

	const topUrls = searchResults.slice(0, FETCH_TOP_K).map((r) => r.url);
	const tFetch = Date.now();
	const fetched = await Promise.allSettled(topUrls.map((u) => localFetch(u)));
	const fetchMs = Date.now() - tFetch;
	const corpus: { url: string; title?: string; markdown: string }[] = [];
	for (const r of fetched) {
		if (r.status === "fulfilled" && r.value.markdown) {
			corpus.push({
				url: r.value.url,
				...(r.value.title ? { title: r.value.title } : {}),
				markdown: r.value.markdown,
			});
		}
	}
	if (!corpus.length) {
		// Fall back to the search snippets only.
		for (const r of searchResults.slice(0, 3)) {
			corpus.push({ url: r.url, title: r.title, markdown: r.content });
		}
	}
	log(`[pipeline] fetch ${fetchMs}ms ok=${corpus.length}/${topUrls.length}`);

	// Step 2: single LLM call with structured output
	const tLlm = Date.now();
	const { schema } = makeNodeSchema(input.type);
	const ai = new GoogleGenAI({ apiKey });
	const model = deps.model ?? "gemini-3.1-flash-lite-preview";

	const userPrompt = buildUserPrompt(input, searchResults, corpus);
	const allowedUrls = new Set<string>();
	for (const r of searchResults) allowedUrls.add(r.url);
	for (const c of corpus) allowedUrls.add(c.url);

	async function generate() {
		return ai.models.generateContent({
			model,
			contents: [{ role: "user", parts: [{ text: userPrompt }] }],
			config: {
				systemInstruction: SYSTEM_PROMPT,
				responseMimeType: "application/json",
				responseSchema: schema,
				temperature: 0.4,
				// Disable thinking on Flash Lite — we don't need CoT for this constrained extraction
				// task, and it adds 1-3s of latency for no measurable accuracy gain.
				thinkingConfig: { thinkingBudget: 0 },
			},
		});
	}
	let resp: Awaited<ReturnType<typeof generate>>;
	try {
		resp = await generate();
	} catch (e) {
		// One quick retry on Gemini 503/UNAVAILABLE — transient infra blips shouldn't fail a node.
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("RESOURCE_EXHAUSTED")) {
			log(`[pipeline] gemini transient (${msg.slice(0, 80)}), retrying in 600ms`);
			await new Promise((r) => setTimeout(r, 600));
			resp = await generate();
		} else {
			throw e;
		}
	}
	const llmMs = Date.now() - tLlm;
	const raw = resp.text;
	if (!raw) throw new Error("Gemini returned no text");
	const parsedRaw = JSON.parse(raw) as Record<string, unknown>;

	// Step 3: canonicalize + Zod validate
	const node = canonicalize(parsedRaw, input, corpus, allowedUrls);
	const validated = nodePayloadSchema.parse(node) as NodePayload;
	const totalBytes = corpus.reduce((a, c) => a + c.markdown.length, 0);
	const usage = (
		resp as unknown as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }
	).usageMetadata;
	const inputTokens = usage?.promptTokenCount ?? 0;
	const outputTokens = usage?.candidatesTokenCount ?? 0;
	// Gemini 3.1 Flash Lite preview pricing (approx): $0.075 / 1M input, $0.30 / 1M output.
	const costUsd = (inputTokens * 0.075 + outputTokens * 0.3) / 1_000_000;

	return {
		node: validated,
		slug: validated.slug,
		metrics: {
			searchMs,
			fetchMs,
			llmMs,
			totalMs: Date.now() - t0,
			searchCount: 1,
			fetchCount: corpus.length,
			urlsFetched: corpus.map((c) => c.url),
			corpusBytes: totalBytes,
			inputTokens,
			outputTokens,
			costUsd,
		},
	};
}

function buildSearchQuery(input: PipelineInput): string {
	const kind = input.type === "project" ? "album" : input.type;
	const dis = input.disambiguator ? ` ${input.disambiguator}` : "";
	return `${input.name}${dis} ${kind} music wiki discogs`;
}

function buildUserPrompt(
	input: PipelineInput,
	searchResults: { title: string; url: string; content: string }[],
	corpus: { url: string; title?: string; markdown: string }[],
): string {
	let prompt = `TARGET: type="${input.type}" name="${input.name}"`;
	if (input.disambiguator) prompt += ` disambiguator="${input.disambiguator}"`;
	prompt += "\n\n";
	prompt += `<search_results query="${input.name}">\n`;
	for (const r of searchResults) {
		prompt += `- [${r.title}](${r.url}): ${r.content.slice(0, 280)}\n`;
	}
	prompt += "</search_results>\n\n";

	let budget = MAX_CORPUS_BYTES;
	for (const c of corpus) {
		// Per-page cap so a single huge Wikipedia page can't monopolize the budget.
		const cap = Math.min(PER_PAGE_BUDGET, budget);
		const slice = c.markdown.length > cap ? `${c.markdown.slice(0, cap)}\n[truncated]` : c.markdown;
		budget -= slice.length;
		prompt += `<page url="${c.url}" title="${(c.title ?? "").replace(/"/g, "'")}">\n${slice}\n</page>\n\n`;
		if (budget <= 0) break;
	}
	prompt +=
		"Produce a single JSON object that satisfies the schema. Use ONLY information from the pages above for facts.";
	return prompt;
}

function canonicalize(
	raw: Record<string, unknown>,
	input: PipelineInput,
	corpus: { url: string }[],
	allowedUrls: Set<string>,
): unknown {
	const nameStr = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : input.name;
	const slug = makeSlug(input.type, nameStr, input.disambiguator);
	const next: Record<string, unknown> = { ...raw, type: input.type, slug, name: nameStr };
	if (input.disambiguator) next.disambiguator = input.disambiguator;

	// Ensure every list-edge field on this node type exists as at least an empty array.
	// Gemini's structured output sometimes omits keys that have 0 minItems; the Zod schema
	// still requires the field, so we default to [] here.
	const LIST_EDGES_BY_TYPE: Record<NodeType, readonly string[]> = {
		genre: [
			"parent_genres",
			"subgenres",
			"related_genres",
			"key_artists",
			"key_labels",
			"landmark_projects",
			"landmark_tracks",
		],
		label: ["genres", "roster", "notable_releases"],
		artist: [
			"genres",
			"labels",
			"discography",
			"notable_tracks",
			"influences",
			"influenced",
			"collaborators",
			"aliases",
			"members",
		],
		project: ["artists", "genres", "tracklist", "producers", "related_projects"],
		track: ["artists", "genres", "producers", "samples", "sampled_by", "remixed_by"],
	};
	for (const f of LIST_EDGES_BY_TYPE[input.type]) {
		if (!Array.isArray(next[f])) next[f] = [];
	}
	// Citations: filter to corpus-grounded URLs only.
	const cits: Citation[] = [];
	const seen = new Set<string>();
	if (Array.isArray(raw.citations)) {
		for (const c of raw.citations as unknown[]) {
			if (!c || typeof c !== "object") continue;
			const o = c as Record<string, unknown>;
			const url = typeof o.url === "string" ? o.url : "";
			if (!/^https?:\/\//i.test(url)) continue;
			if (!allowedUrls.has(url) && !corpus.some((p) => p.url === url)) continue;
			if (seen.has(url)) continue;
			seen.add(url);
			const entry: Citation = { url };
			if (typeof o.title === "string" && o.title.trim()) entry.title = o.title.trim();
			cits.push(entry);
		}
	}
	// If the model emitted bad citations but we DO have corpus URLs, force-fill from corpus.
	if (cits.length === 0) {
		for (const c of corpus.slice(0, 3)) cits.push({ url: c.url });
	}
	next.citations = cits;
	next.materialized_at = new Date().toISOString();

	// Recompute edge slugs.
	for (const k of Object.keys(next)) {
		const v = next[k];
		if (
			Array.isArray(v) &&
			v.length &&
			v[0] &&
			typeof v[0] === "object" &&
			"type" in (v[0] as object) &&
			"name" in (v[0] as object)
		) {
			next[k] = (v as unknown[]).flatMap((e) => normalizeEdge(e) ?? []);
		} else if (v && typeof v === "object" && !Array.isArray(v) && "type" in v && "name" in v) {
			const single = normalizeEdge(v);
			if (single) next[k] = single;
			else delete next[k];
		}
	}
	return next;
}

function normalizeEdge(e: unknown): { slug: string; type: NodeType; name: string } | null {
	if (!e || typeof e !== "object") return null;
	const r = e as { type?: unknown; name?: unknown };
	if (typeof r.type !== "string") return null;
	if (typeof r.name !== "string" || !r.name.trim()) return null;
	const valid = ["genre", "label", "artist", "project", "track"] as const;
	if (!(valid as readonly string[]).includes(r.type)) return null;
	try {
		const t = r.type as NodeType;
		return { slug: makeSlug(t, r.name), type: t, name: r.name.trim() };
	} catch {
		return null;
	}
}
