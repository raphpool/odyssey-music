import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { nodePayloadSchema } from "./schemas.js";
import { makeSlug } from "./slug.js";
import { makeFirecrawlTool } from "./tools/firecrawl.js";
import { makeTavilyTool } from "./tools/tavily.js";
import {
	type EdgeRef,
	LIST_EDGES_BY_TYPE,
	NODE_TYPES,
	type NodePayload,
	type NodeType,
	SINGULAR_EDGES_BY_TYPE,
	type Slug,
} from "./types.js";

export interface AgentDeps {
	tavilyApiKey: string;
	firecrawlApiKey: string;
	/** Override the pi model. Defaults to Gemini 3.1 Flash Lite. */
	modelId?: string;
	/** Hard wall-clock cap per agent run, ms. Default 60_000. */
	timeoutMs?: number;
	/** Max number of emit_node attempts (incl. rejections). Default 3. On the Nth, accept best-effort. */
	maxEmitAttempts?: number;
	/** Optional diagnostic logger called with structured info per run. */
	logger?: (line: string) => void;
}

export interface AgentInput {
	/** Free-text hint, e.g. "jan jelinek tendency" or { type:"track", name:"Tendency"} via the structured form. */
	text?: string;
	type?: NodeType;
	name?: string;
	disambiguator?: string;
}

export interface AgentRunResult {
	node: NodePayload;
	/** Slug computed by us (overrides whatever the agent emitted, ensures canonicalization). */
	slug: Slug;
	turns: number;
}

const SYSTEM_PROMPT = buildSystemPrompt();

/**
 * Run the agent for a single node materialization. Returns a fully validated NodePayload.
 *
 * Strategy:
 *   1. The system prompt tells the agent how the schema works and which fields to fill.
 *   2. The agent is given web_search + fetch_page tools to research.
 *   3. The agent must call emit_node exactly once with the structured payload.
 *   4. We capture, Zod-validate, canonicalize slugs, return.
 */
export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentRunResult> {
	const timeoutMs = deps.timeoutMs ?? 60_000;
	const maxEmitAttempts = deps.maxEmitAttempts ?? 3;
	const log = deps.logger ?? ((): void => undefined);

	const state = {
		researchToolCalls: 0,
		emitAttempts: 0,
		captured: undefined as unknown,
		lastRejectedPayload: undefined as unknown,
		lastRejectionReasons: [] as string[],
	};

	const emitTool: AgentTool = {
		name: "emit_node",
		label: "Emit node payload",
		description:
			"Emit the final structured node payload. Call this exactly once at the end. " +
			"The payload must follow the schema described in the system prompt. " +
			"This call may FAIL on the first attempts if: you have not called web_search AND fetch_page at least once each; " +
			"OR citations is empty; OR fewer than 3 edge references total across applicable fields; " +
			"OR editorial_article is shorter than 400 characters. Fix the listed reasons and retry. After 3 attempts the best payload is accepted as-is.",
		parameters: Type.Object({
			payload: Type.Any({
				description: "The full node payload object as described in the system prompt.",
			}),
		}),
		executionMode: "sequential",
		execute: async (_id, params) => {
			const args = params as { payload: unknown };
			state.emitAttempts++;
			const reasons = validateForEmit(args.payload, state.researchToolCalls);
			const isFinalAttempt = state.emitAttempts >= maxEmitAttempts;
			if (reasons.length > 0 && !isFinalAttempt) {
				state.lastRejectedPayload = args.payload;
				state.lastRejectionReasons = reasons;
				log(
					`  emit_node attempt ${state.emitAttempts} rejected: ${reasons[0] ?? "?"}` +
						(reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""),
				);
				throw new Error(
					`emit_node rejected (attempt ${state.emitAttempts}/${maxEmitAttempts}). Fix and retry. Reasons:\n- ${reasons.join("\n- ")}`,
				);
			}
			state.captured = args.payload;
			if (reasons.length > 0) {
				log(`  emit_node attempt ${state.emitAttempts} accepted best-effort despite: ${reasons.join("; ")}`);
			}
			return {
				content: [{ type: "text", text: "Captured. Run will terminate." }],
				details: { captured: true, attempts: state.emitAttempts, bestEffort: reasons.length > 0 },
				terminate: true,
			};
		},
	};

	const tools: AgentTool[] = [
		makeTavilyTool(deps.tavilyApiKey),
		makeFirecrawlTool(deps.firecrawlApiKey),
		emitTool,
	];

	const modelId = deps.modelId ?? "gemini-3.1-flash-lite-preview";
	// pi-ai 0.74.0 only ships the "preview" type id, so we widen the call to accept any string.
	const model = getModel("google", modelId as "gemini-3.1-flash-lite-preview");

	const userPrompt = formatUserPrompt(input);
	const agent = new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			tools,
		},
	});

	let turns = 0;
	const unsub = agent.subscribe((event) => {
		if (event.type === "turn_end") turns++;
		if (event.type === "tool_execution_end") {
			const name = event.toolName;
			if (name === "web_search" || name === "fetch_page") state.researchToolCalls++;
		}
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			agent.abort();
		} catch {
			// ignore
		}
	}, timeoutMs);

	try {
		await agent.prompt(userPrompt);
	} catch (e) {
		if (!timedOut) throw e;
	} finally {
		clearTimeout(timer);
		unsub();
	}

	// If the agent timed out or finished without a clean emit, fall back to the last rejected payload.
	if (state.captured === undefined) {
		if (state.lastRejectedPayload !== undefined) {
			log(
				`  agent exit without clean emit (${timedOut ? "timeout" : "no-more-turns"}); ` +
					`accepting last rejected payload (attempts=${state.emitAttempts}, turns=${turns}). ` +
					`Reasons were: ${state.lastRejectionReasons.join("; ")}`,
			);
			state.captured = state.lastRejectedPayload;
		} else {
			throw new Error(
				`Agent finished without any emit_node call (timedOut=${timedOut}, turns=${turns}, research=${state.researchToolCalls})`,
			);
		}
	}

	const fallbackName = input.name ?? input.text ?? "Unknown";
	const fbObj: { fallbackName: string; fallbackType?: NodeType } = { fallbackName };
	if (input.type) fbObj.fallbackType = input.type;
	const node = canonicalize(state.captured, fbObj);
	const parsed = nodePayloadSchema.parse(node) as NodePayload;
	return { node: parsed, slug: parsed.slug, turns };
}

function validateForEmit(payload: unknown, researchToolCalls: number): string[] {
	const reasons: string[] = [];
	if (researchToolCalls < 2) {
		reasons.push(
			`You have only made ${researchToolCalls} research tool calls so far. ` +
				"Call web_search at least once AND fetch_page at least once on an authoritative result before emitting.",
		);
	}
	if (!payload || typeof payload !== "object") {
		reasons.push("payload must be an object");
		return reasons;
	}
	const p = payload as Record<string, unknown>;
	const article = p.editorial_article;
	if (typeof article !== "string" || article.length < 400) {
		reasons.push(
			`editorial_article must be a string of at least 400 characters (got ${
				typeof article === "string" ? article.length : "missing"
			}).`,
		);
	}
	const citations = p.citations;
	if (!Array.isArray(citations) || citations.length < 1) {
		reasons.push("citations must be a non-empty array of {url, title} objects.");
	} else {
		const hasUrl = citations.some(
			(c) => c && typeof c === "object" && typeof (c as Record<string, unknown>).url === "string",
		);
		if (!hasUrl) reasons.push('At least one citation must have a "url" string field.');
	}
	const edgeCount = countPayloadEdges(p);
	if (edgeCount < 3) {
		reasons.push(
			`Only ${edgeCount} edge references found. The README schema for type=${String(
				p.type,
			)} requires you to populate the obvious edges (artists/genres/labels/etc.). Aim for >=3.`,
		);
	}
	return reasons;
}

function countPayloadEdges(p: Record<string, unknown>): number {
	let n = 0;
	for (const v of Object.values(p)) {
		if (Array.isArray(v)) {
			for (const item of v) {
				if (item && typeof item === "object" && "type" in item && "name" in item) n++;
			}
		} else if (v && typeof v === "object" && "type" in v && "name" in v) {
			n++;
		}
	}
	return n;
}

function formatUserPrompt(input: AgentInput): string {
	if (input.text && !input.type && !input.name) {
		return (
			`Materialize a Culture Graph node from this free-text input: ${JSON.stringify(input.text)}\n\n` +
			"Step 1: decide which of the five node types this most likely refers to.\n" +
			"Step 2: research the entity using web_search and fetch_page.\n" +
			"Step 3: emit_node with the full validated payload.\n"
		);
	}
	const parts: string[] = [];
	if (input.type) parts.push(`type=${input.type}`);
	if (input.name) parts.push(`name=${JSON.stringify(input.name)}`);
	if (input.disambiguator) parts.push(`disambiguator=${JSON.stringify(input.disambiguator)}`);
	if (input.text) parts.push(`hint=${JSON.stringify(input.text)}`);
	return `Materialize a Culture Graph node. Target: ${parts.join(", ")}.\nResearch, then emit_node.`;
}

interface RawEdge {
	type?: unknown;
	name?: unknown;
}

interface RawPayload {
	type?: unknown;
	name?: unknown;
	[key: string]: unknown;
}

/**
 * Take whatever the agent emitted and:
 *   - validate `type` is a NodeType
 *   - recompute slug = makeSlug(type, name)
 *   - recompute every edge ref's slug from its declared (type, name)
 *   - default missing edge arrays to []
 *   - default citations/materialized_at if missing
 */
const TYPE_TEASER_FIELD: Record<NodeType, string> = {
	genre: "editorial_definition",
	label: "editorial_description",
	artist: "editorial_bio",
	project: "editorial_pitch",
	track: "editorial_teaser",
};

const OPTIONAL_TEXT_FIELDS: Record<NodeType, readonly string[]> = {
	genre: ["era", "origin", "sonic_markers"],
	label: ["founded", "location", "founders", "active_years"],
	artist: ["photo_url", "origin", "active_years"],
	project: ["cover_url", "year"],
	track: ["cover_url", "year", "duration"],
};

interface CanonicalizeFallbacks {
	fallbackName: string;
	fallbackType?: NodeType;
}

function canonicalize(rawInput: unknown, fb: CanonicalizeFallbacks): unknown {
	// Defensive unwrap: agents sometimes return `{ payload: {...the real thing...} }`.
	let raw = rawInput;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const cand = (raw as Record<string, unknown>).payload;
		if (cand && typeof cand === "object" && "type" in cand) raw = cand;
	}
	if (!raw || typeof raw !== "object") {
		throw new Error("Agent payload is not an object");
	}
	const p = raw as RawPayload;
	let nt: NodeType;
	const typeRaw = p.type;
	if (typeof typeRaw === "string" && (NODE_TYPES as readonly string[]).includes(typeRaw)) {
		nt = typeRaw as NodeType;
	} else if (fb.fallbackType) {
		nt = fb.fallbackType;
	} else {
		throw new Error(`Agent payload has invalid 'type' and no fallback: ${JSON.stringify(typeRaw)}`);
	}
	let nameStr: string;
	const nameRaw = p.name;
	if (typeof nameRaw === "string" && nameRaw.trim()) {
		nameStr = nameRaw.trim();
	} else {
		nameStr = fb.fallbackName;
	}
	const slug = makeSlug(nt, nameStr);
	const next: Record<string, unknown> = { ...p, type: nt, slug, name: nameStr };

	if (typeof next.editorial_article !== "string" && typeof next.article === "string") {
		next.editorial_article = next.article;
	}
	if (typeof next.editorial_article !== "string" || (next.editorial_article as string).length < 1) {
		next.editorial_article = `${nameStr} is a ${nt} in the Culture Graph. (Insufficient public information available at materialization time.)`;
	}

	const teaserField = TYPE_TEASER_FIELD[nt];
	if (typeof next[teaserField] !== "string" || !(next[teaserField] as string).trim()) {
		const article = String(next.editorial_article);
		const firstSentence = article.split(/(?<=[.!?])\s/)[0] ?? article.slice(0, 200);
		next[teaserField] = firstSentence.trim().slice(0, 280) || "(no teaser)";
	}

	for (const f of OPTIONAL_TEXT_FIELDS[nt]) {
		const v = next[f];
		if (typeof v === "number") next[f] = String(v);
		else if (v != null && typeof v !== "string") delete next[f];
	}

	for (const field of LIST_EDGES_BY_TYPE[nt]) {
		const v = next[field];
		const list: unknown[] = Array.isArray(v) ? v : [];
		next[field] = list.flatMap((e) => normalizeEdge(e)).filter((e): e is EdgeRef => e !== null);
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[nt]) {
		const v = next[field];
		if (v == null) {
			delete next[field];
			continue;
		}
		const single = normalizeEdge(v);
		if (single) {
			next[field] = single;
		} else {
			delete next[field];
		}
	}
	next.citations = normalizeCitations(next.citations, next.sources);
	delete next.sources;
	if (typeof next.materialized_at !== "string") {
		next.materialized_at = new Date().toISOString();
	}
	return next;
}

function normalizeCitations(primary: unknown, secondary: unknown): { url: string; title?: string }[] {
	const out: { url: string; title?: string }[] = [];
	const seen = new Set<string>();
	const push = (item: unknown): void => {
		if (typeof item === "string") {
			if (isHttpUrl(item) && !seen.has(item)) {
				seen.add(item);
				out.push({ url: item });
			}
			return;
		}
		if (!item || typeof item !== "object") return;
		const obj = item as Record<string, unknown>;
		const url = obj.url ?? obj.link ?? obj.href;
		if (typeof url !== "string" || !isHttpUrl(url) || seen.has(url)) return;
		seen.add(url);
		const entry: { url: string; title?: string } = { url };
		if (typeof obj.title === "string" && obj.title.trim()) entry.title = obj.title.trim();
		out.push(entry);
	};
	if (Array.isArray(primary)) for (const x of primary) push(x);
	if (Array.isArray(secondary)) for (const x of secondary) push(x);
	return out;
}

function isHttpUrl(s: string): boolean {
	return /^https?:\/\//i.test(s);
}

function normalizeEdge(e: unknown): EdgeRef | null {
	if (!e || typeof e !== "object") return null;
	const r = e as RawEdge;
	if (typeof r.type !== "string" || !(NODE_TYPES as readonly string[]).includes(r.type)) return null;
	if (typeof r.name !== "string" || !r.name.trim()) return null;
	const t = r.type as NodeType;
	return { slug: makeSlug(t, r.name), type: t, name: r.name.trim() };
}

function buildSystemPrompt(): string {
	const trackEdges = describeEdges("track", LIST_EDGES_BY_TYPE.track, SINGULAR_EDGES_BY_TYPE.track);
	const projectEdges = describeEdges("project", LIST_EDGES_BY_TYPE.project, SINGULAR_EDGES_BY_TYPE.project);
	const artistEdges = describeEdges("artist", LIST_EDGES_BY_TYPE.artist, SINGULAR_EDGES_BY_TYPE.artist);
	const labelEdges = describeEdges("label", LIST_EDGES_BY_TYPE.label, SINGULAR_EDGES_BY_TYPE.label);
	const genreEdges = describeEdges("genre", LIST_EDGES_BY_TYPE.genre, SINGULAR_EDGES_BY_TYPE.genre);

	return `You are a music culture researcher building one node of the Culture Graph.

GRAPH SCHEMA. There are five node types: genre, label, artist, project (= album or EP), track. Every node has:
  - type: one of {genre,label,artist,project,track}
  - name: the canonical display name of the entity
  - editorial_article: a long-form article about the entity (>= 400 chars, ideally 600-1500). Real article voice, not a listicle.
  - citations: array of objects, each EXACTLY of shape {"url":"https://...", "title":"page title"}.
    The url field is REQUIRED and must be a full http(s) URL — not an index, not a number.
  - typed edge fields linking to other nodes. Each edge is {type, name}: { "type":"artist", "name":"Aphex Twin" }.
  - year / founded / active_years and other date-ish fields must be STRINGS, never numbers ("1999", not 1999).

EDGE FIELDS PER TYPE:
  genre   -> ${genreEdges}
  label   -> ${labelEdges}
  artist  -> ${artistEdges}
  project -> ${projectEdges}
  track   -> ${trackEdges}

Plus type-specific text fields:
  genre.editorial_definition, genre.era, genre.origin, genre.sonic_markers
  label.editorial_description, label.founded, label.location, label.founders, label.active_years
  artist.editorial_bio, artist.photo_url, artist.origin, artist.active_years
  project.editorial_pitch, project.cover_url, project.year
  track.editorial_teaser, track.cover_url, track.year, track.duration

WORKFLOW (do NOT skip steps):
  1. Decide the node type and canonical name from the input. If a track title is ambiguous, prefer the artist+title interpretation.
  2. REQUIRED: call web_search at least once before emit_node. Find 2-4 authoritative pages (Discogs, Wikipedia, RYM, label site, music press, artist's own site, Bandcamp).
  3. REQUIRED: call fetch_page on at least one authoritative page before emit_node. Read it for ground-truth facts.
  4. Build the payload from grounded facts. NEVER invent labels, years, samples, influences, or collaborators you cannot source. Empty list > guess.
  5. Fill OBVIOUS edges aggressively. For a track: artists, project, genres are almost always knowable from the search results — populate them. For an artist: genres, labels, notable_tracks, discography are core. For a label: roster, genres, notable_releases.
  6. Aim for >=3 total edge references across applicable fields. Each edge name must be the canonical name of a real entity, never "Various" or "Unknown".
  7. The 'name' field must be the CLEAN canonical name (e.g. "Tendency", not "Tendency (track)"). The type is already known from the 'type' field; do not also include it in the name.
  8. Distinct personas/aliases stay as distinct edges (e.g., "Aphex Twin" and "AFX" are two artist nodes connected via aliases, not one).
  9. Citations: include every URL you actually fetched, with the page title. Exact shape {url, title}.
  10. Always include BOTH editorial_article (long) AND the per-type teaser field
      (genre.editorial_definition, label.editorial_description, artist.editorial_bio,
       project.editorial_pitch, track.editorial_teaser). The teaser is a distinct 1-2 sentence hook, not a copy of the article.
  11. Call emit_node EXACTLY ONCE with the full payload object as the 'payload' parameter. After emit_node the run ends.

QUALITY BAR:
  - editorial_article reads like a real article (history, context, why it matters), not boilerplate or filler.
  - Do not include "I", "you", or meta talk in the article.
  - If you genuinely cannot find authoritative info on a field, leave its list empty rather than guessing.
  - If you cannot resolve the entity at all (genuinely obscure, or input is not a music entity), still emit a node with type="track" or your best guess, set name to a clean canonical form, empty edge lists, and a short editorial_article explaining the limited public information. Do not refuse.

You have at most ~12 tool calls. Be efficient: 1-2 searches, 1-3 fetches, then emit.`;
}

function describeEdges(_t: NodeType, list: readonly string[], single: readonly string[]): string {
	const listParts = list.map((f) => `${f}[]`);
	const singleParts = single.map((f) => `${f}?`);
	return [...listParts, ...singleParts].join(", ");
}
