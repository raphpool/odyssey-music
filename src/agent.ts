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
	const captured: { value?: unknown } = {};

	const emitTool: AgentTool = {
		name: "emit_node",
		label: "Emit node payload",
		description:
			"Emit the final structured node payload. Call this exactly once at the end. " +
			"The payload must follow the schema described in the system prompt. " +
			"After this call, the run terminates.",
		parameters: Type.Object({
			payload: Type.Any({
				description: "The full node payload object as described in the system prompt.",
			}),
		}),
		executionMode: "sequential",
		execute: async (_id, params) => {
			const args = params as { payload: unknown };
			captured.value = args.payload;
			return {
				content: [{ type: "text", text: "Captured. Run will terminate." }],
				details: { captured: true },
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
	// Cast is needed because pi-ai 0.74.0 currently only ships the "preview" type id.
	// We default to the preview id and accept any string here.
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
	});

	try {
		await agent.prompt(userPrompt);
	} finally {
		unsub();
	}

	if (captured.value === undefined) {
		throw new Error("Agent finished without calling emit_node");
	}

	const raw = captured.value;
	const node = canonicalize(raw);
	const parsed = nodePayloadSchema.parse(node) as NodePayload;
	return { node: parsed, slug: parsed.slug, turns };
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
function canonicalize(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") {
		throw new Error("Agent payload is not an object");
	}
	const p = raw as RawPayload;
	const type = p.type;
	if (typeof type !== "string" || !(NODE_TYPES as readonly string[]).includes(type)) {
		throw new Error(`Agent payload has invalid or missing 'type': ${JSON.stringify(type)}`);
	}
	const nt = type as NodeType;
	const name = p.name;
	if (typeof name !== "string" || !name.trim()) {
		throw new Error("Agent payload missing 'name'");
	}
	const slug = makeSlug(nt, name);
	const next: Record<string, unknown> = { ...p, type: nt, slug, name: name.trim() };

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
	if (!Array.isArray(next.citations)) next.citations = [];
	if (typeof next.materialized_at !== "string") {
		next.materialized_at = new Date().toISOString();
	}
	return next;
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
  - citations: array of {url, title} objects pointing to the sources you actually consulted via fetch_page.
  - typed edge fields linking to other nodes. Each edge is {type, name}: { "type":"artist", "name":"Aphex Twin" }.

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

WORKFLOW:
  1. Decide the node type and canonical name from the input. If a track title is ambiguous, prefer the artist+title interpretation.
  2. Use web_search to find 2-4 authoritative pages (Discogs, Wikipedia, RYM, label site, music press, artist's own site).
  3. Use fetch_page on the most authoritative 1-3 results to read content.
  4. Build the payload from grounded facts. NEVER invent labels, years, samples, influences, or collaborators you cannot source.
  5. Aim for >=3 total edge references across applicable fields. Each edge name must be the canonical name of a real entity.
  6. Distinct personas/aliases stay as distinct edges (e.g., "Aphex Twin" and "AFX" are two artist nodes connected via aliases, not one).
  7. Citations: include every URL you actually fetched, with the page title.
  8. Call emit_node EXACTLY ONCE with the full payload object as the 'payload' parameter. After emit_node the run ends.

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
