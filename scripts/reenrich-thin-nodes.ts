/**
 * Re-write the TEXT of the artists and labels that cite a single source (TRA-487, plan
 * docs/plans/graph-integrity.md, part 6.4). A card whose `citations.length < 2` is judged too thin (D5). Since
 * the research step reads two pages (TRA-459) and the text is normalized (TRA-458), generating the text again
 * fixes such a card. A full re-materialization would re-derive the edges and cost an identity migration, so
 * this script keeps everything but the text.
 *
 * Per selected node: `runPipeline` is called with the node's own `slug` (pinned), `name`, `mbid`,
 * `disambiguator`. The pipeline never writes (writing is the caller's job: NodeCache.write), so the fresh node
 * is a candidate only; just these fields are copied from it onto the node already on disk:
 *   editorial_article, the teaser of the type, citations, and the text facts of the type
 *   (artist: origin, active_years -- label: founded, location, founders, active_years)
 * plus `materialized_at`. Every other key (edges, mbid, image, _metrics...) is the one on disk. A fact the
 * fresh node does not carry is kept, never erased.
 *
 * A node is rewritten only if the fresh node really cites >= 2 sources, validates (`nodePayloadSchema`), and
 * is the same entity (same slug and type, and the same `mbid` when both carry one). A fresh node that is still
 * thin leaves the file alone and its slug goes to `stillThin`; any other refusal goes to `errors`.
 *
 * Why this is safe to re-run: the selection is read from the files, so a node already rewritten is no longer
 * selected. A run that stops half-way (budget, quota, a kill) is resumed by running it again.
 *
 * Dry-run by default (no key needed, no network): it lists the candidates and the estimated cost
 * (`selected x 0.006 $`). `--apply` calls the pipeline, which costs Gemini and search credits.
 *
 * This is not a migration of scripts/migrations/ and has no channel contract: prod receives these texts with
 * the next global cache sync.
 *
 * Usage: tsx scripts/reenrich-thin-nodes.ts <cache-dir> [--types artist,label] [--apply] [--limit N]
 *        [--only slug,slug] [--manifest out/reenrich.json] [--concurrency 2] [--max-cost USD]
 *        [--search-provider tavily|firecrawl]
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { atomicWriteJson } from "../src/cache.js";
import { loadEnv } from "../src/env.js";
import { OPTIONAL_TEXT_FIELDS, TEASER_FIELD_BY_TYPE } from "../src/node-spec.js";
import { type PipelineDeps, type PipelineInput, runPipeline } from "../src/pipeline.js";
import { nodePayloadSchema } from "../src/schemas.js";
import type { NodeType, Slug } from "../src/types.js";
import {
	type CacheNodeFile,
	looksLikeCacheDir,
	readCacheNodes,
} from "./migrations/2026-09-04-merge-genre-duplicates.js";

export const DEFAULT_MANIFEST_PATH = "out/reenrich.json";
/** Gemini cost of one node, as estimated by the ticket (2.5 Flash Lite; a pricier model costs more). */
export const ESTIMATED_COST_PER_NODE_USD = 0.006;
/** A card with fewer citations than this is "thin" (D5). */
export const MIN_CITATIONS = 2;

/** The types this script handles: projects, tracks and genres are out of the ticket's scope. */
export const REENRICH_TYPES = ["artist", "label"] as const;
export type ReenrichType = (typeof REENRICH_TYPES)[number];

type Obj = Record<string, unknown>;

export function isReenrichType(value: string): value is ReenrichType {
	return (REENRICH_TYPES as readonly string[]).includes(value);
}

/** The fields copied from a fresh node: the article, the teaser, the citations and the text facts. */
export function mergedFieldsOf(type: ReenrichType): string[] {
	const facts = OPTIONAL_TEXT_FIELDS[type].filter((f) => !f.endsWith("_url"));
	return ["editorial_article", TEASER_FIELD_BY_TYPE[type], "citations", ...facts];
}

export function citationCount(node: Obj): number {
	return Array.isArray(node.citations) ? node.citations.length : 0;
}

export interface SelectOptions {
	types: readonly ReenrichType[];
	/** Restrict to these slugs (a thin node among them is still required). */
	only?: readonly string[];
	limit?: number;
}

/** The thin nodes of the requested types, in slug order, then `only`, then `limit`. */
export function selectThinNodes(nodes: readonly CacheNodeFile[], opts: SelectOptions): CacheNodeFile[] {
	const only = opts.only ? new Set(opts.only) : null;
	const picked = nodes
		.filter((n) => (opts.types as readonly NodeType[]).includes(n.type))
		.filter((n) => citationCount(n.node) < MIN_CITATIONS)
		.filter((n) => only === null || only.has(n.slug))
		.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	return opts.limit === undefined ? picked : picked.slice(0, opts.limit);
}

/** Why `fresh` cannot stand for `existing`, or null. The text of another entity must never land on a node. */
export function identityMismatch(existing: Obj, fresh: Obj): string | null {
	if (fresh.type !== existing.type) return `type ${String(fresh.type)} != ${String(existing.type)}`;
	if (fresh.slug !== existing.slug) return `slug ${String(fresh.slug)} != ${String(existing.slug)}`;
	if (typeof existing.mbid === "string" && typeof fresh.mbid === "string" && existing.mbid !== fresh.mbid) {
		return `mbid ${fresh.mbid} != ${existing.mbid}`;
	}
	return null;
}

function hasValue(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	return typeof value !== "string" || value.trim() !== "";
}

/**
 * `existing` with the text fields of `fresh` and a new `materialized_at`. A field `fresh` does not carry (or
 * carries empty) keeps its stored value. `changed` lists the fields whose value differs.
 */
export function mergeFreshText(
	existing: Obj,
	fresh: Obj,
	type: ReenrichType,
	materializedAt: string,
): { node: Obj; changed: string[] } {
	const node: Obj = { ...existing };
	const changed: string[] = [];
	for (const field of mergedFieldsOf(type)) {
		const value = fresh[field];
		if (!hasValue(value) || isDeepStrictEqual(existing[field], value)) continue;
		node[field] = value;
		changed.push(field);
	}
	node.materialized_at = materializedAt;
	return { node, changed };
}

export interface ReenrichManifest {
	mode: "dry-run" | "apply";
	generated_at: string;
	types: ReenrichType[];
	/** Thin nodes picked by the selection (after --only and --limit). */
	selected: number;
	/** Their slugs. */
	candidates: string[];
	/** `selected x ESTIMATED_COST_PER_NODE_USD`. */
	estimatedCostUsd: number;
	/** Files written (planned, never in a dry-run). */
	rewritten: number;
	rewrittenSlugs: string[];
	/** Nodes the pipeline still gave < 2 citations: their file is untouched. */
	stillThin: string[];
	/** Sum of the pipeline `metrics.costUsd` of the calls made (priced by GEMINI_FLASH_LITE_*_USD_PER_MILLION). */
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	/** True when `--max-cost` stopped the run: `notRun` was left out. */
	budgetExhausted: boolean;
	notRun: string[];
	errors: { slug: string; error: string }[];
}

export interface ReenrichOptions extends SelectOptions {
	cacheDir: string;
	apply: boolean;
	deps?: PipelineDeps;
	concurrency?: number;
	/** Stop starting nodes once the pipeline cost reaches this many dollars. */
	maxCostUsd?: number;
	now?: () => Date;
	log?: (line: string) => void;
}

function inputOf(file: CacheNodeFile): PipelineInput {
	const { node } = file;
	const input: PipelineInput = {
		type: file.type,
		name: String(node.name),
		// Pinned: the text is written back under this very slug whatever the pipeline would derive.
		slug: file.slug as Slug,
	};
	if (typeof node.mbid === "string") input.mbid = node.mbid;
	if (typeof node.disambiguator === "string") input.disambiguator = node.disambiguator;
	return input;
}

export async function reenrichThinNodes(opts: ReenrichOptions): Promise<ReenrichManifest> {
	const log = opts.log ?? ((): void => undefined);
	const now = opts.now ?? ((): Date => new Date());
	const { nodes, invalid } = await readCacheNodes(opts.cacheDir);
	for (const bad of invalid) log(`warning: unreadable node file ${bad.path}: ${bad.error}`);
	const selected = selectThinNodes(nodes, opts);
	const manifest: ReenrichManifest = {
		mode: opts.apply ? "apply" : "dry-run",
		generated_at: now().toISOString(),
		types: [...opts.types],
		selected: selected.length,
		candidates: selected.map((n) => n.slug),
		estimatedCostUsd: Number((selected.length * ESTIMATED_COST_PER_NODE_USD).toFixed(4)),
		rewritten: 0,
		rewrittenSlugs: [],
		stillThin: [],
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		budgetExhausted: false,
		notRun: [],
		errors: [],
	};
	if (!opts.apply) return manifest;
	if (!opts.deps) throw new Error("reenrichThinNodes: --apply needs the pipeline deps (API keys)");
	const deps = opts.deps;

	const queue = selected.slice();
	const worker = async (): Promise<void> => {
		for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
			if (opts.maxCostUsd !== undefined && manifest.costUsd >= opts.maxCostUsd) {
				manifest.budgetExhausted = true;
				manifest.notRun.push(file.slug);
				continue;
			}
			try {
				await reenrichOne(file, deps, manifest, now, log);
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				manifest.errors.push({ slug: file.slug, error });
				log(`FAIL ${file.slug}: ${error}`);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker));
	manifest.rewrittenSlugs.sort();
	manifest.stillThin.sort();
	manifest.notRun.sort();
	manifest.errors.sort((a, b) => (a.slug < b.slug ? -1 : 1));
	manifest.rewritten = manifest.rewrittenSlugs.length;
	return manifest;
}

async function reenrichOne(
	file: CacheNodeFile,
	deps: PipelineDeps,
	manifest: ReenrichManifest,
	now: () => Date,
	log: (line: string) => void,
): Promise<void> {
	const type = file.type as ReenrichType;
	const result = await runPipeline(inputOf(file), { ...deps, maxProviderAttempts: 1 });
	manifest.costUsd += result.metrics.costUsd;
	manifest.inputTokens += result.metrics.inputTokens;
	manifest.outputTokens += result.metrics.outputTokens;
	const fresh = result.node as unknown as Obj;

	const mismatch = identityMismatch(file.node, fresh);
	if (mismatch) throw new Error(`fresh node is not the same entity (${mismatch})`);
	if (citationCount(fresh) < MIN_CITATIONS) {
		manifest.stillThin.push(file.slug);
		log(`STILL THIN ${file.slug}: ${citationCount(fresh)} citation(s)`);
		return;
	}
	const { node, changed } = mergeFreshText(file.node, fresh, type, now().toISOString());
	const parsed = nodePayloadSchema.safeParse(node);
	if (!parsed.success)
		throw new Error(`merged node refused by the schema: ${parsed.error.message.slice(0, 300)}`);
	await atomicWriteJson(file.path, node);
	manifest.rewrittenSlugs.push(file.slug);
	log(`OK ${file.slug} citations=${citationCount(node)} changed=${changed.join(",")}`);
}

// --- CLI ---

export interface CliArgs {
	cacheDir: string;
	types: ReenrichType[];
	apply: boolean;
	limit?: number;
	only?: string[];
	manifest: string;
	concurrency: number;
	maxCostUsd?: number;
	searchProvider: "tavily" | "firecrawl";
}

/** Null (the CLI exits 2) on a missing cache dir, an unknown flag or type, or a number that is not one. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	let values: Record<string, string | boolean | undefined>;
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args: [...argv],
			allowPositionals: true,
			options: {
				types: { type: "string" },
				apply: { type: "boolean" },
				limit: { type: "string" },
				only: { type: "string" },
				manifest: { type: "string" },
				concurrency: { type: "string" },
				"max-cost": { type: "string" },
				"search-provider": { type: "string" },
			},
		}));
	} catch {
		return null;
	}
	const [cacheDir, ...extra] = positionals;
	if (!cacheDir || extra.length > 0) return null;
	const types = String(values.types ?? "artist,label")
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t !== "");
	if (types.length === 0 || !types.every(isReenrichType)) return null;
	const num = (raw: unknown): number | undefined | null => {
		if (raw === undefined) return undefined;
		const n = Number(raw);
		return Number.isFinite(n) && n > 0 ? n : null;
	};
	const limit = num(values.limit);
	const concurrency = num(values.concurrency);
	const maxCost = num(values["max-cost"]);
	if (limit === null || concurrency === null || maxCost === null) return null;
	const searchProvider = String(values["search-provider"] ?? "tavily");
	if (searchProvider !== "tavily" && searchProvider !== "firecrawl") return null;
	const only = typeof values.only === "string" ? values.only.split(",").filter((s) => s !== "") : undefined;
	return {
		cacheDir,
		types: [...new Set(types)] as ReenrichType[],
		apply: values.apply === true,
		...(limit !== undefined ? { limit: Math.floor(limit) } : {}),
		...(only ? { only } : {}),
		manifest: typeof values.manifest === "string" ? values.manifest : DEFAULT_MANIFEST_PATH,
		concurrency: concurrency === undefined ? 2 : Math.floor(concurrency),
		...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
		searchProvider,
	};
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: reenrich-thin-nodes.ts <cache-dir> [--types artist,label] [--apply] [--limit N] [--only slug,slug]\n" +
				"       [--manifest out/reenrich.json] [--concurrency 2] [--max-cost USD] [--search-provider tavily|firecrawl]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	let deps: PipelineDeps | undefined;
	if (args.apply) {
		const env = loadEnv({ searchProvider: args.searchProvider });
		deps = {
			tavilyApiKey: env.TAVILY_API_KEY,
			firecrawlApiKey: env.FIRECRAWL_API_KEY,
			geminiApiKey: env.GEMINI_API_KEY,
			searchProvider: args.searchProvider,
		};
	}
	const manifest = await reenrichThinNodes({
		cacheDir: args.cacheDir,
		types: args.types,
		apply: args.apply,
		concurrency: args.concurrency,
		...(args.limit !== undefined ? { limit: args.limit } : {}),
		...(args.only ? { only: args.only } : {}),
		...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
		...(deps ? { deps } : {}),
		log: (line) => process.stdout.write(`${line}\n`),
	});
	await mkdir(dirname(args.manifest), { recursive: true });
	await atomicWriteJson(args.manifest, manifest);
	const summary = args.apply
		? `rewritten=${manifest.rewritten} stillThin=${manifest.stillThin.length} errors=${manifest.errors.length} ` +
			`notRun=${manifest.notRun.length} cost=$${manifest.costUsd.toFixed(4)}`
		: `candidates=${manifest.selected} estimated cost=$${manifest.estimatedCostUsd.toFixed(2)} (dry-run, nothing written)`;
	process.stdout.write(`[reenrich] ${manifest.mode}: ${summary} -> ${args.manifest}\n`);
	if (manifest.errors.length > 0) process.exit(1);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
