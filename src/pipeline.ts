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
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, Type as GType, type Schema } from "@google/genai";
import { z } from "zod";
import { pipelineConfig, pricingConfig } from "./config.js";
import { type GenreResolver, loadGenreResolver } from "./genre-identity.js";
import type { GenreRegistry } from "./genre-registry.js";
import {
	fetchArtistDiscographyMb,
	fetchEntityGenresMb,
	fetchLabelEntityMb,
	fetchLabelMetaMb,
	fetchProjectMetaMb,
	fetchTrackMetaMb,
	findArtistMbidByName,
	findLabelMbidByName,
	findRecordingMbidByName,
	findReleaseGroupMbidByName,
	type MbGenreTag,
} from "./musicbrainz.js";
import { EDGE_TARGET_TYPES_BY_TYPE, LIST_EDGES_BY_TYPE, NODE_TYPES } from "./node-spec.js";
import { nodePayloadSchema } from "./schemas.js";
import { makeSlug } from "./slug.js";
import { localFetch } from "./tools/local-fetcher.js";

/** Title-case a lowercased genre name for display. Handles "r&b" -> "R&B" and "hip-hop" -> "Hip-Hop". */
function genreDisplayName(s: string): string {
	return s.replace(/(^|[\s&-])([a-z])/g, (_m, sep, ch: string) => `${sep}${ch.toUpperCase()}`);
}

interface WikidataGenreEntry {
	slug: string;
	name: string;
	wikidata_qid: string;
	parents?: string[];
}
let GENRE_CATALOG: Map<string, WikidataGenreEntry> | null = null;
async function loadGenreCatalog(): Promise<Map<string, WikidataGenreEntry>> {
	if (GENRE_CATALOG) return GENRE_CATALOG;
	const here = dirname(fileURLToPath(import.meta.url));
	const path = join(here, "..", "data", "genre-catalog.json");
	const raw = await readFile(path, "utf8");
	const parsed = JSON.parse(raw) as { genres: WikidataGenreEntry[] };
	const map = new Map<string, WikidataGenreEntry>();
	for (const g of parsed.genres) map.set(g.slug, g);
	GENRE_CATALOG = map;
	return map;
}

// 2026-09-10 (TRA-32): a QID that wins the cached-vs-resolved conflict below (see
// enrichFromMusicBrainz) doesn't necessarily match identity.slug/body's OWN catalog entry — using
// that entry for the parent_genres backfill would backfill the WRONG lineage (e.g. genre:trap
// keeping its curated Q47781397 (EDM) while "trap" resolves by name to Q2913982's hip-hop entry).
// Look up the entry by the QID that actually won instead. On a QID shared by multiple catalog
// entries, the first one wins (catalog is sorted by slug) — same collision policy as
// genre-identity.ts's own qidIndex.
let GENRE_CATALOG_BY_QID: Map<string, WikidataGenreEntry> | null = null;
async function loadGenreCatalogByQid(): Promise<Map<string, WikidataGenreEntry>> {
	if (GENRE_CATALOG_BY_QID) return GENRE_CATALOG_BY_QID;
	const catalog = await loadGenreCatalog();
	const byQid = new Map<string, WikidataGenreEntry>();
	for (const entry of catalog.values()) {
		if (!byQid.has(entry.wikidata_qid)) byQid.set(entry.wikidata_qid, entry);
	}
	GENRE_CATALOG_BY_QID = byQid;
	return byQid;
}

import { rankResults, type TavilyResult, tavilySearch } from "./tools/tavily.js";
import type { Citation, NodePayload, NodeType, Slug } from "./types.js";
import { QID_PATTERN } from "./types.js";

export interface PipelineDeps {
	tavilyApiKey: string;
	firecrawlApiKey: string;
	geminiApiKey?: string;
	model?: string;
	logger?: (line: string) => void;
	// OPTIONAL, but omitting it silently disables genre-duplicate prevention: the node's
	// genre edges keep whatever name-derived slug their producer minted instead of being
	// canonicalized against an existing node/redirect/QID (see src/genre-registry.ts, TRA-28).
	// Every caller that persists runPipeline's result via NodeCache.write must pass this,
	// built on that same NodeCache. Callers with no cache (smoke test, bench, live tests)
	// are the only legitimate reason to leave it unset.
	genreRegistry?: GenreRegistry;
}

export interface PipelineInput {
	type: NodeType;
	name: string;
	disambiguator?: string;
	mbid?: string;
	// 2026-09-10 (TRA-28 review, B1/B2): when set, the produced node is written under this
	// EXACT slug instead of one freshly derived from name/type/disambiguator (canonicalizeDraft).
	// `name`/`disambiguator` still drive research and content generation as usual. For a caller
	// that already knows the canonical target for a dangling reference -- e.g. a genre edge
	// GenreRegistry has canonicalized onto an existing node under a different slug than a fresh
	// makeSlug(type, name) would produce -- omitting this re-derives the wrong slug from `name`
	// and mints a second, name-derived duplicate of a target that was never actually missing.
	slug?: Slug;
	// 2026-09-10 (TRA-43): a genre identity hint from the EDGE that produced this request (front
	// chip / crawler frontier) -- wins over a fresh by-name resolve in enrichFromMusicBrainz
	// (decision d'archi 8/9, docs/plans/qid-genre-identity.md).
	qid?: string;
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

type PipelineLog = (line: string) => void;

interface CorpusPage {
	url: string;
	title?: string;
	markdown: string;
}

interface ResearchResult {
	searchResults: TavilyResult[];
	corpus: CorpusPage[];
	allowedUrls: Set<string>;
	searchMs: number;
	fetchMs: number;
}

interface DraftResult {
	raw: Record<string, unknown>;
	llmMs: number;
	inputTokens: number;
	outputTokens: number;
}

// --- Gemini schema builders ---

const stringSchema = (description: string, minLength?: number): Schema => {
	const s: Schema = { type: GType.STRING, description };
	if (minLength) (s as { minLength?: string }).minLength = String(minLength);
	return s;
};

const edgeRefSchema = (allowedTypes: readonly NodeType[]): Schema => ({
	type: GType.OBJECT,
	properties: {
		type: { type: GType.STRING, enum: [...allowedTypes], description: "Target node type." },
		name: stringSchema("Canonical entity name. Real proper noun, never 'Various' or 'Unknown'.", 1),
	},
	required: ["type", "name"],
	propertyOrdering: ["type", "name"],
});

const edgeRefSchemaFor = (type: NodeType, field: string): Schema => {
	const allowed = EDGE_TARGET_TYPES_BY_TYPE[type][field];
	if (!allowed) throw new Error(`No edge target spec for ${type}.${field}`);
	return edgeRefSchema(allowed);
};

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
			// Hard caps + first-sentence rule + slop ban embedded in the schema description because
			// Gemini Flash Lite honors schema descriptions more reliably than narrative system prompts.
			"Real article prose, 350-700 chars. FIRST SENTENCE must contain at least 2 concrete sourced facts (year/date + place/scene + named collaborator OR label OR sample). NEVER open with marketing voice ('emerged as', 'serves as', 'stands as', 'pivots on a foundation of', 'released under the X banner'). Each sentence teaches the reader ONE concrete thing from the corpus (named producer, named sample, real venue, real chart fact, real critic). FORBIDDEN phrases (these are AI tells, instant fail): 'stylistic trajectory', 'sonic identity', 'sonic palette', 'signature blend', 'creative pivot', 'polished production values', 'major label output', 'atmospheric tension', 'high-stakes', 'continues to', 'showcases', 'reinforces', 'standout moment', 'definitive anchor'. SHORTER honest prose beats longer padded prose. If the corpus gives <2 hard musical facts, write 1-2 short sentences only.",
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
							items: edgeRefSchemaFor("genre", "parent_genres"),
							minItems: "0",
							maxItems: "4",
						},
						subgenres: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("genre", "subgenres"),
							minItems: "0",
							maxItems: "6",
						},
						related_genres: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("genre", "related_genres"),
							minItems: "2",
							maxItems: "6",
						},
						key_artists: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("genre", "key_artists"),
							minItems: "3",
							maxItems: "8",
						},
						key_labels: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("genre", "key_labels"),
							minItems: "1",
							maxItems: "5",
						},
						landmark_projects: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("genre", "landmark_projects"),
							minItems: "0",
							maxItems: "5",
						},
						landmark_tracks: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("genre", "landmark_tracks"),
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
						genres: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("label", "genres"),
							minItems: "1",
							maxItems: "5",
						},
						roster: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("label", "roster"),
							minItems: "3",
							maxItems: "10",
						},
						notable_releases: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("label", "notable_releases"),
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
						genres: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("artist", "genres"),
							minItems: "1",
							maxItems: "5",
						},
						labels: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("artist", "labels"),
							minItems: "1",
							maxItems: "5",
						},
						discography: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("artist", "discography"),
							minItems: "2",
							maxItems: "10",
						},
						notable_tracks: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("artist", "notable_tracks"),
							minItems: "1",
							maxItems: "8",
						},
						influences: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("artist", "influences"),
							minItems: "0",
							maxItems: "8",
						},
						influenced: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("artist", "influenced"),
							minItems: "0",
							maxItems: "8",
						},
						collaborators: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("artist", "collaborators"),
							minItems: "0",
							maxItems: "8",
						},
						aliases: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("artist", "aliases"),
							minItems: "0",
							maxItems: "5",
						},
						members: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("artist", "members"),
							minItems: "0",
							maxItems: "10",
						},
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
						bpm: stringSchema(
							"BPM at album scope, e.g. '110 BPM' or '95-120 BPM'. Only if stated in the corpus.",
							0,
						),
						musical_key: stringSchema("Key signature at album scope, e.g. 'C minor'. Only if stated.", 0),
						vocals: stringSchema(
							"Lead/backing vocal credits as free text, e.g. 'lead: Pharrell Williams; backing: Nile Rodgers'.",
							0,
						),
						samples_notes: stringSchema("Notes about samples or interpolations on the record.", 0),
						inspirations: stringSchema(
							"Stated stylistic inspirations, e.g. 'Chic-style disco guitar, late-70s Philadelphia soul'.",
							0,
						),
						artists: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("project", "artists"),
							minItems: "1",
							maxItems: "5",
						},
						label: edgeRefSchemaFor("project", "label"),
						genres: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("project", "genres"),
							minItems: "1",
							maxItems: "5",
						},
						tracklist: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("project", "tracklist"),
							minItems: "2",
							maxItems: "20",
						},
						producers: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("project", "producers"),
							minItems: "0",
							maxItems: "6",
						},
						personnel: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("project", "personnel"),
							minItems: "0",
							maxItems: "20",
						},
						related_projects: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("project", "related_projects"),
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
						bpm: stringSchema("BPM if stated, e.g. '100 BPM'.", 0),
						musical_key: stringSchema("Key signature if stated, e.g. 'D major'.", 0),
						vocals: stringSchema(
							"Vocal credits as free text, e.g. 'lead: Pharrell Williams; backing harmonies: Pharrell Williams, Nile Rodgers'.",
							0,
						),
						samples_notes: stringSchema("Notes about samples or interpolations.", 0),
						inspirations: stringSchema("Stated stylistic inspirations.", 0),
						artists: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("track", "artists"),
							minItems: "1",
							maxItems: "5",
						},
						project: edgeRefSchemaFor("track", "project"),
						label: edgeRefSchemaFor("track", "label"),
						genres: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("track", "genres"),
							minItems: "1",
							maxItems: "5",
						},
						producers: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("track", "producers"),
							minItems: "0",
							maxItems: "5",
						},
						personnel: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("track", "personnel"),
							minItems: "0",
							maxItems: "20",
						},
						samples: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("track", "samples"),
							minItems: "0",
							maxItems: "6",
						},
						sampled_by: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("track", "sampled_by"),
							minItems: "0",
							maxItems: "6",
						},
						remix_of: edgeRefSchemaFor("track", "remix_of"),
						remixed_by: {
							type: GType.ARRAY,
							items: edgeRefSchemaFor("track", "remixed_by"),
							minItems: "0",
							maxItems: "6",
						},
					},
				},
			};
		}
	}
}

// Latency knobs. Each token shaved off the LLM call is ~free wall-clock time.
// Keep enough source text for editorial fields; MB enrichment owns structured release data.
// See ADR 2026-05-19 pipeline-retrieval-and-enrichment.
const MAX_CORPUS_BYTES = pipelineConfig.maxCorpusBytes;
const PER_PAGE_BUDGET = pipelineConfig.perPageBudgetBytes;
const SEARCH_RESULTS = pipelineConfig.searchResults;
// Fetch one strong Wikipedia result, or multiple music outlets when no Wiki result is present.
// See ADR 2026-05-19 pipeline-retrieval-and-enrichment.
const FETCH_TOP_K_WITH_WIKI = pipelineConfig.fetchTopKWithWiki;
const FETCH_TOP_K_NO_WIKI = pipelineConfig.fetchTopKNoWiki;

function safeHost(u: string): string {
	try {
		return new URL(u).hostname;
	} catch {
		return "";
	}
}

const SYSTEM_PROMPT = `You build one Culture Graph node from research material the system provides.

You receive: a target {type, name, disambiguator?} and a corpus of 1-3 web pages already fetched
for that entity, plus the search snippets. Your job is to output a SINGLE JSON object that
conforms to the response schema. Do not call tools — the system handled retrieval.

GENERAL RULES:
  - editorial_article: real prose written for a curious LISTENER who wants to decide whether to
    press play. Every sentence must teach them something concrete about the music. Target
    400-1500 chars when sources support it; SHORTER is acceptable when info is genuinely thin.
    Open with a strong sentence (entity + place + era + what they sound like). NEVER hallucinate.
  - HARD ANTI-SLOP BAN. Phrases FORBIDDEN — they're AI tells, not music information:
    "documented within", "documented in international music databases", "cataloged on Discogs",
    "tracks their vinyl and CD releases", "maintained a presence in the underground music scene",
    "diverse naming conventions", "numerical suffixes", "point of interest for collectors",
    "active entity", "continues to be", "musical project and artist entity",
    "high-stakes atmospheric tension", "creative pivot", "signature blend", "sonic identity",
    "polished production values", "stylistic trajectory", "atmospheric tension", "expected of a
    major label output", "showcases the polished", "underscores a continued collaboration",
    "captures the high-stakes", "reinforcing the distinct sonic", "mid-2010s", "mid-2020s",
    "mid-2030s" (when used as a generic era marker without a concrete date or scene).
    A SHORT honest article (~80 chars) beats a long padded one. If you have <2 concrete
    musical facts (real collaborator, real venue/scene, real release date with label, sourced
    sonic trait), keep the article SHORT.
  - WHEN MULTIPLE NON-WIKIPEDIA SOURCES ARE PROVIDED (corpus has 2-3 articles from Pitchfork /
    Genius / Rolling Stone / Complex / HipHopDX / NME etc), SYNTHESIZE them: cite a specific
    quote or detail from each. Name producers, samples, guest vocalists, lyric themes,
    production techniques, scene context, critic reception — ground every sentence in something
    one of the articles actually says. Vague generic prose is worse than nothing.
  - Every fact mentioned (year, label, sample, personnel name) must appear in the corpus. If it
    isn't there, leave the field empty rather than guess.
  - Citations: 2-6 URLs you actually used FROM THE SUPPLIED CORPUS. Each has a real http(s) url
    and a title.
  - Edges: each {type, name} pair must be a real entity, never 'Various'/'Unknown'/'TBC'.
    Use the canonical name (e.g. 'Aphex Twin', not 'Aphex Twin (musician)').
  - CRITICAL — for short mononym aliases (e.g. '40', 'XL', 'Mike', 'Jay', 'Ye', any 1-3
    char stage name), use the canonical full name as the edge name (e.g. "Noah '40' Shebib"
    not '40'; "Kanye West" not 'Ye'). Short names collide with unrelated artists in MB
    search and route the click to the wrong page (ADR 2026-05-20 credit-slug-normalization).
  - Aliases and side-projects stay as distinct edges (AFX != Aphex Twin).
  - Year/founded/active_years are STRINGS, never numbers.
  - The 'name' field on your output must be the canonical name (no '(track)', no '(album)').

TRACK / PROJECT STRUCTURED FIELDS (CRITICAL — this is the most common failure mode):
  When the corpus contains a Wikipedia page for a track or album, it almost always has a
  "Personnel" / "Credits" section and an infobox with the record label. You MUST extract these
  into the STRUCTURED fields, not merely mention them in the prose article. Specifically:
    - personnel: array of {type:"artist", name:"..."} for EVERY credited session musician,
      featured vocalist, instrumentalist, or engineer the corpus names. Include lead vocalist
      AND backing vocalists AND each named instrumentalist.
    - label: singular {type:"label", name:"..."} for the record label that released the track or
      project (from the infobox / "Released by" / "Label" line).
    - bpm, musical_key, vocals, samples_notes, inspirations: free-text strings extracted from
      the "Composition" / "Music" / "Production" sections when the corpus states them.
  Returning a polished prose article but leaving personnel/label/composition empty when the
  Wikipedia page lists them is a HARD FAILURE.

WORKED EXAMPLE — Track "Lose Yourself to Dance" (Daft Punk, Random Access Memories):
  Wikipedia's "Personnel" section lists: Pharrell Williams (lead vocals, backing harmonies),
  Nile Rodgers (rhythm guitar), Nathan East (bass guitar), Paul Jackson Jr. (rhythm guitar),
  Omar Hakim (drums), Chris Caswell (Wurlitzer electric piano). Label (infobox) = Daft Life /
  Columbia. The right output therefore includes:
    "personnel": [
      {"type":"artist","name":"Pharrell Williams"},
      {"type":"artist","name":"Nile Rodgers"},
      {"type":"artist","name":"Nathan East"},
      {"type":"artist","name":"Paul Jackson Jr."},
      {"type":"artist","name":"Omar Hakim"},
      {"type":"artist","name":"Chris Caswell"}
    ],
    "label": {"type":"label","name":"Daft Life / Columbia"},
    "vocals": "lead: Pharrell Williams; backing harmonies: Pharrell Williams, Nile Rodgers",
    "inspirations": "late-70s disco, Chic-style rhythm guitar"
  Adjust to whatever the actual corpus says for the entity in question — never copy these names
  verbatim onto unrelated tracks.

OUTPUT: a single JSON object. Nothing before or after. No markdown fences.`;

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
	const log = deps.logger ?? ((): void => undefined);
	const t0 = Date.now();
	const research = await researchTarget(input, deps, log);
	const draft = await generateNodeDraft(input, deps, research, log);
	const node = canonicalizeDraft(draft.raw, input, research.corpus, research.allowedUrls);
	await enrichFromMusicBrainz(node, input, log, deps.genreRegistry);
	// 2026-09-09: mbGenreEdges, the parent_genres catalog backfill, and canonicalizeDraft each
	// derive a genre edge's slug from its display name alone, which produced 20 groups of
	// duplicate genre nodes sharing a QID (e.g. "electronic" / "electronic-music"). All three
	// producers have emitted by this point and the node isn't validated yet, so canonicalizing
	// genre edges here once covers every producer, present and future (decision d'archi 7,
	// docs/plans/qid-genre-identity.md).
	await deps.genreRegistry?.canonicalizeNodeEdges(node);
	const validated = validateNode(node);

	return {
		node: validated,
		slug: validated.slug,
		metrics: buildMetrics(t0, research, draft),
	};
}

async function researchTarget(
	input: PipelineInput,
	deps: PipelineDeps,
	log: PipelineLog,
): Promise<ResearchResult> {
	let queryHint = "";
	if (input.mbid && input.type === "track") {
		try {
			const meta = await fetchTrackMetaMb(input.mbid);
			const parts: string[] = [];
			if (meta.artists.length > 0) parts.push(meta.artists.map((a) => a.name).join(" "));
			if (meta.project) parts.push(meta.project.name);
			if (parts.length > 0) queryHint = ` ${parts.join(" ")}`;
		} catch {
			// non-fatal
		}
	}
	// Same enrichment for project nodes (Raph 2026-05-24: clicked "In the Stars" from
	// Rolling Stones page → landed on a 1970 various-artists compilation because Tavily
	// got "in the stars album wiki discogs" with no artist/year context and surfaced the
	// wrong release). With MBID we can pull artist credit + year from MB and pin the
	// search to the exact release-group the user clicked. mbFetch memoizes so the later
	// fetchProjectMetaMb call in the enrichment step costs nothing extra.
	if (input.mbid && input.type === "project") {
		try {
			const meta = await fetchProjectMetaMb(input.mbid);
			const parts: string[] = [];
			if (meta.artists.length > 0) parts.push(meta.artists.map((a) => a.name).join(" "));
			if (meta.year) parts.push(meta.year);
			if (parts.length > 0) queryHint = ` ${parts.join(" ")}`;
		} catch {
			// non-fatal
		}
	}
	// Same disambiguation for label nodes (Raph 2026-05-24 prevention pass): "Decca",
	// "Columbia", "Virgin" etc. collide across decades and continents in MB. With the
	// MBID stamped on the chip we can pin Tavily to the canonical entity by appending
	// country + founded-year + MB disambiguation text. Country alone disambiguates the
	// US/UK Columbia pair; founded-year separates Virgin Records (1972) from later
	// imprints; the disambig string is MB editors' free-text qualifier ("major label
	// founded 1888" etc.) and is usually the highest-signal token.
	if (input.mbid && input.type === "label") {
		try {
			const ent = await fetchLabelEntityMb(input.mbid);
			if (ent) {
				const parts: string[] = [];
				if (ent.country) parts.push(ent.country);
				if (ent.founded) parts.push(ent.founded.slice(0, 4));
				if (ent.disambiguation) parts.push(ent.disambiguation);
				if (parts.length > 0) queryHint = ` ${parts.join(" ")}`;
			}
		} catch {
			// non-fatal
		}
	}
	const tSearch = Date.now();
	const searchQuery = buildSearchQuery(input) + queryHint;
	const searchResultsRaw = await tavilySearch(deps.tavilyApiKey, searchQuery, {
		max_results: SEARCH_RESULTS,
		search_depth: "basic",
	});
	// Source priority: Wikipedia first, fandom/reddit last.
	const searchResults = rankResults(searchResultsRaw);
	const searchMs = Date.now() - tSearch;
	if (!searchResults.length) {
		throw new Error(`No search results for ${input.type}:${input.name}`);
	}
	log(`[pipeline] search ${searchMs}ms results=${searchResults.length}`);

	const hasWiki = searchResults.slice(0, 4).some((r) => /(^|\.)wikipedia\.org/i.test(safeHost(r.url)));
	const fetchK = hasWiki ? FETCH_TOP_K_WITH_WIKI : FETCH_TOP_K_NO_WIKI;
	const topUrls = searchResults.slice(0, fetchK).map((r) => r.url);
	log(`[pipeline] fetch_k=${fetchK} wiki=${hasWiki}`);
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

	const allowedUrls = new Set<string>();
	for (const r of searchResults) allowedUrls.add(r.url);
	for (const c of corpus) allowedUrls.add(c.url);

	return { searchResults, corpus, allowedUrls, searchMs, fetchMs };
}

async function generateNodeDraft(
	input: PipelineInput,
	deps: PipelineDeps,
	research: ResearchResult,
	log: PipelineLog,
): Promise<DraftResult> {
	const apiKey = deps.geminiApiKey ?? pipelineConfig.geminiApiKey;
	if (!apiKey) throw new Error("GEMINI_API_KEY missing");
	const tLlm = Date.now();
	const { schema } = makeNodeSchema(input.type);
	const ai = new GoogleGenAI({ apiKey });
	const model = deps.model ?? pipelineConfig.defaultModel;

	// Variability nonce (goal-2): each call carries a unique session id so that two fresh
	// re-materializations of the same entity produce visibly different prose. The agent is
	// instructed to use this as a writing-angle hint, not to invent facts.
	const sessionNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const userPrompt = `${buildUserPrompt(input, research.searchResults, research.corpus)}\n\n<writing_session id="${sessionNonce}">Pick a fresh narrative angle for this session — open with a different concrete fact than you would by default, vary sentence rhythm and which collaborators/scene markers you foreground. Do NOT invent facts; vary only the grounded angle.</writing_session>`;

	async function generate() {
		return ai.models.generateContent({
			model,
			contents: [{ role: "user", parts: [{ text: userPrompt }] }],
			config: {
				systemInstruction: SYSTEM_PROMPT,
				responseMimeType: "application/json",
				responseSchema: schema,
				// Higher temperature (goal-2 variability rubric): two fresh materializations of
				// the same entity must produce substantially different prose. 0.4 was too tight.
				temperature: pipelineConfig.temperature,
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
			await new Promise((r) => setTimeout(r, pipelineConfig.retryDelayMs));
			resp = await generate();
		} else {
			throw e;
		}
	}
	const llmMs = Date.now() - tLlm;
	const raw = resp.text;
	if (!raw) throw new Error("Gemini returned no text");
	const parsedRaw = JSON.parse(raw) as Record<string, unknown>;
	const usage = (
		resp as unknown as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }
	).usageMetadata;

	return {
		raw: parsedRaw,
		llmMs,
		inputTokens: usage?.promptTokenCount ?? 0,
		outputTokens: usage?.candidatesTokenCount ?? 0,
	};
}

interface GenreEdge {
	type: "genre";
	name: string;
	slug: string;
	qid?: string;
}

// Shared by mbGenreEdges and the parent_genres backfill below (TRA-18): omit the qid key
// entirely rather than set it to undefined (exactOptionalPropertyTypes).
function genreEdge(name: string, slug: string, qid?: string): GenreEdge {
	return qid ? { type: "genre", name, slug, qid } : { type: "genre", name, slug };
}

// Resolves each MB genre tag to its catalog QID (TRA-18); g.name is MB's lowercased name, not
// the display name. Unresolvable genres are kept, just without a qid (per ticket contract).
function mbGenreEdges(genres: readonly MbGenreTag[], resolver: GenreResolver | null): GenreEdge[] {
	return genres.map((g) => {
		const display = genreDisplayName(g.name);
		const identity = resolver?.resolve(g.mbid ? { name: g.name, mbid: g.mbid } : { name: g.name });
		return genreEdge(display, makeSlug("genre", display), identity?.qid);
	});
}

// Exported for test/pipeline-genre-qid.test.ts (TRA-18), which mocks musicbrainz.js.
export { enrichFromMusicBrainz };
async function enrichFromMusicBrainz(
	node: unknown,
	input: PipelineInput,
	log: PipelineLog,
	genreRegistry?: GenreRegistry,
): Promise<void> {
	// MB enrichment owns structured release data (ADR 2026-05-19 pipeline-retrieval-and-enrichment).
	// Genre resolver load is best-effort (TRA-18): a failure just means no qid on genre edges below.
	let genreResolver: GenreResolver | null = null;
	if (input.type === "artist" || input.type === "track" || input.type === "project") {
		try {
			genreResolver = await loadGenreResolver();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`[pipeline] genre resolver unavailable, genre edges will have no qid: ${msg.slice(0, 100)}`);
		}
	}
	if (input.type === "artist") {
		try {
			let mbid = input.mbid;
			if (!mbid) mbid = (await findArtistMbidByName(input.name, input.disambiguator)) ?? undefined;
			if (mbid) {
				// MB tags are more granular than editorial infobox genres.
				const genres = await fetchEntityGenresMb("artist", mbid, { minCount: 2, max: 8 });
				if (genres.length > 0) {
					const obj = node as Record<string, unknown>;
					obj.genres = mbGenreEdges(genres, genreResolver);
				}
				const releases = await fetchArtistDiscographyMb(mbid, { limit: 100 });
				// Keep Album/EP/Single primary types, drop anything with secondary types
				// (Live, Compilation, Soundtrack, Remix, …). Raph 2026-05-24: include EPs and
				// singles in the discography chip list, not just LPs. "In the Stars" (Stones,
				// 2026) ships as Single on MB so it was previously filtered out.
				const PRIMARY_OK = new Set(["Album", "EP", "Single"]);
				const clean = releases.filter((r) => PRIMARY_OK.has(r.primaryType) && r.secondaryTypes.length === 0);
				if (clean.length > 0) {
					// Keep ALL studio albums, then top up with newest EPs/singles up to 80.
					// For canon artists (Stones: ~30 LPs) we keep every album AND get recent
					// EPs/singles like "Sweet Sounds of Heaven" alongside.
					const albums = clean.filter((r) => r.primaryType === "Album");
					const eps = clean.filter((r) => r.primaryType === "EP");
					const singles = clean.filter((r) => r.primaryType === "Single");
					const TARGET = 80;
					const epSingleSlots = Math.max(0, TARGET - albums.length);
					const epSingleBudget = [...eps, ...singles]
						.sort((a, b) => (b.firstReleaseDate || "").localeCompare(a.firstReleaseDate || ""))
						.slice(0, epSingleSlots);
					const merged = [...albums, ...epSingleBudget].sort((a, b) =>
						(b.firstReleaseDate || "").localeCompare(a.firstReleaseDate || ""),
					);
					const obj = node as Record<string, unknown>;
					obj.discography = merged.map((r) => ({
						type: "project",
						name: r.title,
						slug: makeSlug("project", r.title),
						mbid: r.mbid,
						year: (r.firstReleaseDate || "").slice(0, 4) || undefined,
						releaseType: r.primaryType.toLowerCase() as "album" | "ep" | "single",
					}));
					log(
						`[pipeline] artist discography overridden with ${merged.length} MB releases (${albums.length} album, ${epSingleBudget.length} ep+single, out of ${clean.length} clean)`,
					);
				}
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`[pipeline] MB discography enrich skipped: ${msg.slice(0, 100)}`);
		}
	}
	// Same pattern for project nodes: MB knows the canonical tracklist; the LLM tends to
	// confabulate or hallucinate B-side names. We resolve the release-group MBID, take the
	// earliest release in the group, and replace `tracklist` with the actual recordings.
	if (input.type === "label") {
		try {
			let mbid = input.mbid;
			if (!mbid) mbid = (await findLabelMbidByName(input.name, input.disambiguator)) ?? undefined;
			if (mbid) {
				const meta = await fetchLabelMetaMb(mbid);
				const obj = node as Record<string, unknown>;
				if (meta.roster.length > 0) {
					obj.roster = meta.roster.slice(0, 30).map((a) => ({
						type: "artist",
						name: a.name,
						slug: makeSlug("artist", a.name),
						mbid: a.mbid,
					}));
				}
				if (meta.notableReleases.length > 0) {
					obj.notable_releases = meta.notableReleases.slice(0, 30).map((r) => ({
						type: "project",
						name: r.title,
						slug: makeSlug("project", r.title),
						mbid: r.mbid,
					}));
				}
				log(
					`[pipeline] label meta overridden: roster=${meta.roster.length} releases=${meta.notableReleases.length}`,
				);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`[pipeline] MB label enrich skipped: ${msg.slice(0, 100)}`);
		}
	}
	if (input.type === "track") {
		try {
			let mbid = input.mbid;
			if (!mbid) mbid = (await findRecordingMbidByName(input.name, input.disambiguator)) ?? undefined;
			if (mbid) {
				const genres = await fetchEntityGenresMb("recording", mbid, { minCount: 2, max: 8 });
				if (genres.length > 0) {
					const obj = node as Record<string, unknown>;
					obj.genres = mbGenreEdges(genres, genreResolver);
				}
				const meta = await fetchTrackMetaMb(mbid);
				const obj = node as Record<string, unknown>;
				if (meta.project) {
					obj.project = {
						type: "project",
						name: meta.project.name,
						slug: makeSlug("project", meta.project.name),
						mbid: meta.project.mbid,
					};
				}
				if (meta.label) {
					obj.label = {
						type: "label",
						name: meta.label.name,
						slug: makeSlug("label", meta.label.name),
						mbid: meta.label.mbid,
					};
				}
				if (meta.artists.length > 0) {
					obj.artists = meta.artists.slice(0, 10).map((a) => ({
						type: "artist",
						name: a.name,
						slug: makeSlug("artist", a.name),
						mbid: a.mbid,
					}));
				}
				if (meta.year) obj.year = meta.year;
				if (meta.duration) obj.duration = meta.duration;
				if (meta.producers.length > 0) {
					obj.producers = meta.producers.slice(0, 6).map((a) => ({
						type: "artist",
						name: a.name,
						slug: makeSlug("artist", a.name),
						mbid: a.mbid,
					}));
				}
				if (meta.personnel.length > 0) {
					obj.personnel = meta.personnel.slice(0, 20).map((a) => ({
						type: "artist",
						name: a.name,
						slug: makeSlug("artist", a.name),
						mbid: a.mbid,
					}));
				}
				log(
					`[pipeline] track meta overridden: project=${meta.project?.name ?? "-"} label=${meta.label?.name ?? "-"} artists=${meta.artists.length} producers=${meta.producers.length} personnel=${meta.personnel.length} year=${meta.year ?? "-"} duration=${meta.duration ?? "-"}`,
				);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`[pipeline] MB track enrich skipped: ${msg.slice(0, 100)}`);
		}
	}
	if (input.type === "project") {
		try {
			let mbid = input.mbid;
			if (!mbid) mbid = (await findReleaseGroupMbidByName(input.name, input.disambiguator)) ?? undefined;
			if (mbid) {
				const genres = await fetchEntityGenresMb("release-group", mbid, { minCount: 2, max: 8 });
				if (genres.length > 0) {
					const obj = node as Record<string, unknown>;
					obj.genres = mbGenreEdges(genres, genreResolver);
				}
				const meta = await fetchProjectMetaMb(mbid);
				const obj = node as Record<string, unknown>;
				if (meta.tracks.length > 0) {
					obj.tracklist = meta.tracks.slice(0, 30).map((t) => ({
						type: "track",
						name: t.title,
						slug: makeSlug("track", t.title),
						mbid: t.mbid,
					}));
				}
				if (meta.label) {
					obj.label = {
						type: "label",
						name: meta.label.name,
						slug: makeSlug("label", meta.label.name),
						mbid: meta.label.mbid,
					};
				}
				if (meta.artists.length > 0) {
					obj.artists = meta.artists.slice(0, 10).map((a) => ({
						type: "artist",
						name: a.name,
						slug: makeSlug("artist", a.name),
						mbid: a.mbid,
					}));
				}
				if (meta.year) obj.year = meta.year;
				// MB release-group primary-type → narrow to the schema enum so chips
				// (EdgeRef.releaseType) and node payloads (ProjectNode.release_type) agree.
				// MB values outside album/ep/single (e.g. "Compilation", "Soundtrack") are
				// intentionally dropped — extending the enum is a separate change.
				if (meta.primaryType) {
					const normalized = meta.primaryType.toLowerCase();
					if (normalized === "album" || normalized === "ep" || normalized === "single") {
						obj.release_type = normalized;
					}
				}
				if (meta.producers.length > 0) {
					obj.producers = meta.producers.slice(0, 6).map((a) => ({
						type: "artist",
						name: a.name,
						slug: makeSlug("artist", a.name),
						mbid: a.mbid,
					}));
				}
				if (meta.personnel.length > 0) {
					obj.personnel = meta.personnel.slice(0, 20).map((a) => ({
						type: "artist",
						name: a.name,
						slug: makeSlug("artist", a.name),
						mbid: a.mbid,
					}));
				}
				log(
					`[pipeline] project meta overridden: tracks=${meta.tracks.length} label=${meta.label?.name ?? "-"} artists=${meta.artists.length} producers=${meta.producers.length} personnel=${meta.personnel.length} year=${meta.year ?? "-"} release_type=${(node as Record<string, unknown>).release_type ?? "-"}`,
				);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`[pipeline] MB project enrich skipped: ${msg.slice(0, 100)}`);
		}
	}
	// Genres: backfill parent_genres from the Wikidata catalog when the LLM
	// returned none. This rescues orphan genres (e.g. "bass-music", "acoustic")
	// that otherwise get quarantined by build-graph-json for having zero genre↔genre edges.
	if (input.type === "genre") {
		try {
			const obj = node as Record<string, unknown>;
			const catalog = await loadGenreCatalog();
			const slug = obj.slug as Slug;
			const body = slug.split(":")[1] ?? "";
			// 2026-09-10 (TRA-32): read the already-committed qid unconditionally, before either
			// branch below decides obj.qid — the cached-wins conflict rule needs it regardless of
			// whether the resolver even succeeds. This is a single local file read (~150us, per
			// the review round that requested it), negligible next to the multi-second LLM call
			// already paid for this node; do not move it into an "on resolve miss" branch only.
			const cachedQid = await genreRegistry?.existingGenreQid(slug);
			// 2026-09-09 (TRA-26): catalog.get(body) was a slug-exact lookup. The Wikidata
			// catalog only has "electronic-music", not "electronic", so genre:electronic got
			// neither qid nor parents and was invisible to report:genre-dupes. Route through
			// the resolver (name -> catalog slug -> alias -> "music" suffix -> squashed form)
			// instead; only fall back to the old slug-exact lookup when the resolver itself
			// failed to load (loadGenreResolver is memoized, so this doesn't load it twice).
			let resolver: GenreResolver | null = null;
			try {
				resolver = await loadGenreResolver();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				log(
					`[pipeline] genre resolver unavailable for node qid, falling back to slug lookup: ${msg.slice(0, 100)}`,
				);
			}
			// TRA-18: obj.qid is stamped here, outside/before the parent_genres guard below — a
			// genre with parents already resolved still needs its own qid (re)stamped.
			if (resolver) {
				// Resolve on the node's own materialized name (obj.name), not input.name: by this
				// point canonicalizeDraft (:1179) has already let the LLM draft override the
				// requested name, so obj.name is the one actually persisted on the node — same
				// convention as mbGenreEdges (:805), which resolves on the tag's own name.
				const ownName = typeof obj.name === "string" ? obj.name : "";
				// 2026-09-10 (TRA-32): resolution order matches the backfill migration
				// (scripts/migrations/2026-09-04-backfill-genre-qid.ts:200-204) exactly — resolve
				// on the name first, and only fall back to the slug body (when non-empty) on any
				// resolve failure, not merely when the name is empty.
				const identity =
					resolver.resolve({ name: ownName }) ?? (body ? resolver.resolve({ name: body }) : null);

				// Conflict policy matches the backfill migration exactly (scripts/migrations/
				// 2026-09-04-backfill-genre-qid.ts:206-217, "conflicts (kept as-is)"): an
				// already-committed qid is authoritative over a freshly resolved one. Identity
				// corrections are a migration/curation concern (the TRA-21 backfill, TRA-33's
				// alias table) — cache/ is the committed knowledge base — never a silent runtime
				// overwrite. Concretely: genre:trap's TRA-33-curated qid Q47781397 (EDM lineage)
				// must never be replaced by "trap"'s "music"-suffix heuristic match Q2913982
				// (hip-hop lineage) just because a later LLM draft's name failed to resolve.
				if (cachedQid && identity && cachedQid !== identity.qid) {
					log(
						`[pipeline] genre qid conflict for ${slug}: cached=${cachedQid} resolved=${identity.qid} (cached kept)`,
					);
				}
				// 2026-09-10 (TRA-43): the edge's own qid wins over a fresh by-name resolve, same
				// rationale as cachedQid above -- log when it disagrees, like the cached case.
				if (input.qid && identity && input.qid !== identity.qid) {
					log(
						`[pipeline] genre qid conflict for ${slug}: edge=${input.qid} resolved=${identity.qid} (edge identity kept)`,
					);
				}
				obj.qid = cachedQid ?? input.qid ?? identity?.qid;
			} else {
				// 2026-09-10 (TRA-43 review round 1, nit): same precedence as the resolver-available
				// branch above -- the resolver being unavailable must not drop the edge's own qid.
				obj.qid = cachedQid ?? input.qid ?? catalog.get(body)?.wikidata_qid;
			}
			// 2026-09-10 (TRA-32): look up the parent_genres backfill entry by whichever qid
			// actually won above, BY QID — not by identity.slug/catalog.get(body)'s own slug,
			// which would backfill the wrong lineage whenever the cached-wins rule above picked a
			// qid other than what name/slug resolution would have (see the conflict comment
			// above).
			const entry = typeof obj.qid === "string" ? (await loadGenreCatalogByQid()).get(obj.qid) : undefined;
			const current = Array.isArray(obj.parent_genres) ? (obj.parent_genres as unknown[]) : [];
			if (current.length === 0 && entry?.parents?.length) {
				obj.parent_genres = entry.parents.map((p) => {
					// 2026-09-10 (TRA-34): the catalog slug collapses "R&B" to "rb"
					// ("contemporary-rb"), and rehydrating that slug verbatim produced
					// "Contemporary Rb" -> genre:contemporary-rb — off the cache's "-r-and-b"
					// convention (genre:r-and-b, genre:alternative-r-and-b) and a duplicate-minting
					// risk alongside a resolver-derived genre:contemporary-r-and-b. Deriving from the
					// catalog NAME instead was tried and reverted: it also restores every internal
					// hyphen, apostrophe and diacritic the catalog name carries (e.g. "hip-hop" ->
					// "Hip-Hop" instead of "Hip Hop"), changing 143 of 1449 parent slugs — including
					// two real collisions where a distinct "*-edm" entry folded onto its unrelated
					// non-EDM sibling (bass-music-edm -> genre:bass-music, glitch-hop-edm ->
					// genre:glitch-hop). Scoped fix instead: expand the standalone "rb" word back to
					// "R&B" before title-casing; makeSlug already turns "&" into " and ", so
					// "Contemporary R&B" slugs to genre:contemporary-r-and-b. Every other slug
					// (hyphenation, diacritics, apostrophes) is untouched.
					const expanded = p.replace(/-/g, " ").replace(/\brb\b/gi, "R&B");
					const display = genreDisplayName(expanded);
					return genreEdge(display, makeSlug("genre", display), catalog.get(p)?.wikidata_qid);
				});
				log(`[pipeline] genre parent_genres backfilled from Wikidata: ${entry.parents.length}`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`[pipeline] Wikidata genre enrich skipped: ${msg.slice(0, 100)}`);
		}
	}
	// Dedup personnel against producers for project + track nodes. The LLM frequently lists
	// Producers win over personnel duplicates (ADR 2026-05-20 personnel-dedup).
	if (input.type === "project" || input.type === "track") {
		const obj = node as Record<string, unknown>;
		const prods = Array.isArray(obj.producers) ? (obj.producers as Array<Record<string, unknown>>) : [];
		const pers = Array.isArray(obj.personnel) ? (obj.personnel as Array<Record<string, unknown>>) : [];
		if (prods.length > 0 && pers.length > 0) {
			const key = (e: Record<string, unknown>): string =>
				typeof e.mbid === "string" ? `mb:${e.mbid}` : `slug:${String(e.slug ?? "")}`;
			const prodKeys = new Set(prods.map(key));
			obj.personnel = pers.filter((p) => !prodKeys.has(key(p)));
		}
	}
}

function buildMetrics(t0: number, research: ResearchResult, draft: DraftResult): PipelineResult["metrics"] {
	const totalBytes = research.corpus.reduce((a, c) => a + c.markdown.length, 0);
	// Gemini 3.1 Flash Lite preview pricing (approx): $0.075 / 1M input, $0.30 / 1M output.
	const costUsd =
		(draft.inputTokens * pricingConfig.geminiFlashLiteInputUsdPerMillion +
			draft.outputTokens * pricingConfig.geminiFlashLiteOutputUsdPerMillion) /
		1_000_000;

	return {
		searchMs: research.searchMs,
		fetchMs: research.fetchMs,
		llmMs: draft.llmMs,
		totalMs: Date.now() - t0,
		searchCount: 1,
		fetchCount: research.corpus.length,
		urlsFetched: research.corpus.map((c) => c.url),
		corpusBytes: totalBytes,
		inputTokens: draft.inputTokens,
		outputTokens: draft.outputTokens,
		costUsd,
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
		"Produce a single JSON object that satisfies the schema. Use ONLY information from the pages above for facts.\n\n" +
		"editorial_article quality bar — failure modes to avoid (RECENT REGRESSIONS):\n" +
		"  BAD: \"Released in 2026 under the OVO and Republic Records banners, 'X' serves as a standout inclusion on Drake's project ICEMAN. The track emphasizes the artist's current stylistic trajectory and showcases the polished production values expected of a major label output.\"\n" +
		"  GOOD: \"Released 15 May 2026 on Drake's surprise ICEMAN mixtape (OVO/Republic). Built around a chopped Lykke Li 'I Follow Rivers' sample over a sub-bass loop produced by Boi-1da. Lyric topic is a feud with manager Janice — first Drake song to name her directly.\"\n" +
		"  The GOOD version has 6 concrete sourced facts (date, label, sample source, producer, lyric topic, biographical first). The BAD version has 0 — every clause is filler. Match the GOOD pattern.\n" +
		"  If the corpus does not support 4+ concrete facts, write fewer sentences. NEVER pad.";
	return prompt;
}

function canonicalizeDraft(
	raw: Record<string, unknown>,
	input: PipelineInput,
	corpus: { url: string; markdown?: string }[],
	allowedUrls: Set<string>,
): unknown {
	const nameStr = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : input.name;
	const slug = input.slug ?? makeSlug(input.type, nameStr, input.disambiguator);
	const next: Record<string, unknown> = { ...raw, type: input.type, slug, name: nameStr };
	if (input.disambiguator) next.disambiguator = input.disambiguator;

	// Gemini's structured output sometimes omits keys that have 0 minItems; the Zod schema
	// still requires list-edge fields, so default them to [] here.
	for (const f of LIST_EDGES_BY_TYPE[input.type]) {
		if (!Array.isArray(next[f])) next[f] = [];
	}
	// Drop ungrounded scalar/edge values before validation (ADR 2026-05-19 groundedness).
	const corpusBlob = (corpus as { markdown?: string }[])
		.map((c) => (typeof c.markdown === "string" ? c.markdown : ""))
		.join("\n")
		.toLowerCase();
	const disambigTokens = input.disambiguator
		? input.disambiguator
				.toLowerCase()
				.split(/\s+/)
				.filter((t) => t.length >= 3)
		: [];
	const isGroundedName = (name: string): boolean => {
		const n = name.toLowerCase().trim();
		if (n.length < 2) return false;
		if (disambigTokens.length && disambigTokens.some((t) => n === t || n.includes(t))) return false;
		return corpusBlob.includes(n);
	};
	if (input.type === "project" || input.type === "track") {
		// Singular label: drop if not grounded.
		if (next.label && typeof next.label === "object" && !Array.isArray(next.label)) {
			const lbl = next.label as Record<string, unknown>;
			const nm = typeof lbl.name === "string" ? lbl.name : "";
			if (!nm || !isGroundedName(nm)) delete next.label;
		}
		// Tracklist on project: drop entries whose name isn't in the corpus AND looks suspiciously
		// like the project's own name with a parenthetical suffix (a common confab pattern).
		if (Array.isArray(next.tracklist)) {
			const projName = (typeof next.name === "string" ? next.name : "").toLowerCase();
			next.tracklist = (next.tracklist as unknown[]).filter((t) => {
				if (!t || typeof t !== "object") return false;
				const tn = (t as Record<string, unknown>).name;
				if (typeof tn !== "string") return false;
				const tnl = tn.toLowerCase();
				// Reject suspicious parenthetical reuse of the project's own name when not in corpus.
				const looksLikeReuse =
					projName && tnl.startsWith(projName) && /\([^)]+\)\s*$/.test(tn) && !corpusBlob.includes(tnl);
				if (looksLikeReuse) return false;
				return true;
			});
		}
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

function validateNode(node: unknown): NodePayload {
	return nodePayloadSchema.parse(node) as NodePayload;
}

export function normalizeEdge(
	e: unknown,
): { slug: string; type: NodeType; name: string; mbid?: string; qid?: string } | null {
	if (!e || typeof e !== "object") return null;
	const r = e as { type?: unknown; name?: unknown; mbid?: unknown; qid?: unknown };
	if (typeof r.type !== "string") return null;
	if (typeof r.name !== "string" || !r.name.trim()) return null;
	if (!(NODE_TYPES as readonly string[]).includes(r.type)) return null;
	try {
		const t = r.type as NodeType;
		const out: { slug: string; type: NodeType; name: string; mbid?: string; qid?: string } = {
			slug: makeSlug(t, r.name),
			type: t,
			name: r.name.trim(),
		};
		if (
			typeof r.mbid === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.mbid)
		) {
			out.mbid = r.mbid;
		}
		// Symmetric with mbid above (TRA-17): normalizeEdge rebuilds the object from scratch, so
		// any unlisted field is silently dropped. The MusicBrainz genre path never reaches this
		// function today (canonicalizeDraft runs before enrichFromMusicBrainz), but a future
		// upstream producer stamping qid before canonicalization must not lose it here.
		if (typeof r.qid === "string" && QID_PATTERN.test(r.qid)) {
			out.qid = r.qid;
		}
		return out;
	} catch {
		return null;
	}
}
