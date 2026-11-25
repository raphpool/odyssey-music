/**
 * Batch tool that writes `l10n.<locale>` into the nodes of a cache (TRA-808, plan docs/plans/track1-contenu-fr.md
 * part 2). One node at a time, in slug order; throughput, quota stop and sample are TRA-811's business.
 *
 * Preview by default: without `--apply` the translator is never called and no node is written (counts and
 * manifest are). A node is handled when it has no `currentTranslation` (`missing`: no block; `stale`: a block
 * whose fingerprint no longer matches), or with `--force`. `--limit n` counts nodes handed to the translator.
 *
 * - `ineligible` (2026-11-24): a source the validator can never accept (English article under 80 characters,
 *   empty teaser) is counted apart and dropped before the translator, `--force` or not: each call would be
 *   paid for an answer that is refused.
 * - Written: the node as read plus `l10n.<locale>`, existing key order kept. The copy must pass
 *   `nodePayloadSchema` without losing a field (`onlyAddsSchemaDefaults`), else the node goes to `failed`; the
 *   file read back without `l10n` must equal the node read, else the tool stops (a second run resumes).
 * - Never `NodeCache.write` (reverse edges, other nodes rewritten); never `materialized_at` (the data channel
 *   arbitrates repo vs prod on it).
 *
 * Exit codes: 0 done, 1 done with `failed` (or an error), 2 usage. Flags: see `parseCliArgs`.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJson } from "../src/cache.js";
import { pipelineConfig, translationConfig } from "../src/config.js";
import { CONTENT_LOCALES, type ContentLocale, NODE_TYPES, type NodeType } from "../src/node-spec.js";
import { nodePayloadSchema, nodeTranslationSchema } from "../src/schemas.js";
import { createGeminiGenerateJson } from "../src/translation/gemini-generate.js";
import { currentTranslation, translationSourceOf } from "../src/translation/source.js";
import {
	createNodeTranslator,
	type NodeTranslator,
	type TranslationFailure,
	type TranslationUsage,
} from "../src/translation/translate-node.js";
import { MIN_ARTICLE_LENGTH, type TranslationIssue } from "../src/translation/validate.js";
import type { NodePayload, NodeTranslation, Slug } from "../src/types.js";
import {
	isNodeType,
	looksLikeCacheDir,
	readCacheNodes,
	warnSkippedNodeFiles,
} from "./migrations/2026-09-04-merge-genre-duplicates.js";
import { onlyAddsSchemaDefaults } from "./migrations/2026-10-15-backfill-artist-identity.js";

export const DEFAULT_MANIFEST_PATH = "out/translate-nodes-fr.json";

type Obj = Record<string, unknown>;
type Status = "current" | "missing" | "stale" | "ineligible";

export interface TranslationRunOptions {
	cacheDir: string;
	locale: ContentLocale;
	types?: readonly NodeType[];
	slugs?: readonly Slug[];
	limit?: number;
	force: boolean;
	apply: boolean;
}

export interface TranslationRunManifest {
	tool: "translate-nodes";
	locale: ContentLocale;
	model: string;
	generated_at: string;
	applied: boolean;
	/** `total` = current + missing + stale + ineligible, over the nodes the filters select. */
	counts: Record<NodeType, Record<"total" | Status, number>>;
	translated: Slug[];
	failed: { slug: Slug; reason: TranslationFailure; issues: TranslationIssue[] }[];
	usage: TranslationUsage;
}

const isPlainRecord = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The raw node is read as a payload for classification only: this reads its text fields and `l10n`, and a
 * node that fails the schema (an article under 80 characters, say) must still be counted, not crash.
 */
function statusOf(raw: Obj, type: NodeType, locale: ContentLocale): Status {
	// The type comes from the file path: a damaged `type` field must not make the classification throw.
	const node = { ...raw, type } as unknown as NodePayload;
	const source = translationSourceOf(node);
	const article: unknown = source.article;
	if (
		typeof article !== "string" ||
		article.trim().length < MIN_ARTICLE_LENGTH ||
		source.teaser.trim() === ""
	)
		return "ineligible";
	const block: unknown = node.l10n?.[locale];
	if (block === undefined) return "missing";
	// A block the readers would discard (TRA-821) is not a translation: it is replaced, like a stale one.
	const usable = nodeTranslationSchema.safeParse(block).success;
	return usable && currentTranslation(node, locale) !== undefined ? "current" : "stale";
}

/** True when the schema accepts `node` and changes nothing but the defaults it fills in (see the header). */
function passesSchema(node: Obj): boolean {
	const parsed = nodePayloadSchema.safeParse(node);
	return parsed.success && onlyAddsSchemaDefaults(node, parsed.data);
}

function withTranslation(raw: Obj, locale: ContentLocale, translation: NodeTranslation): Obj {
	const l10n = isPlainRecord(raw.l10n) ? raw.l10n : {};
	return { ...raw, l10n: { ...l10n, [locale]: translation } };
}

export async function runTranslation(
	options: TranslationRunOptions,
	translate: NodeTranslator,
): Promise<TranslationRunManifest> {
	const { nodes, invalid } = await readCacheNodes(options.cacheDir);
	warnSkippedNodeFiles(invalid);
	const counts = Object.fromEntries(
		NODE_TYPES.map((type) => [type, { total: 0, current: 0, missing: 0, stale: 0, ineligible: 0 }]),
	) as TranslationRunManifest["counts"];
	const usage: TranslationUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	const translated: Slug[] = [];
	const failed: TranslationRunManifest["failed"] = [];

	const todo: typeof nodes = [];
	for (const file of nodes) {
		if (options.types && !options.types.includes(file.type)) continue;
		if (options.slugs && !options.slugs.includes(file.slug as Slug)) continue;
		const status = statusOf(file.node, file.type, options.locale);
		counts[file.type].total++;
		counts[file.type][status]++;
		if (status !== "ineligible" && (status !== "current" || options.force)) todo.push(file);
	}

	if (options.apply) {
		for (const file of todo.slice(0, options.limit)) {
			const slug = file.slug as Slug;
			// A node the schema would alter can never be written: refuse it before paying for a translation.
			const { l10n: _l10n, ...bare } = file.node;
			if (!passesSchema(bare)) {
				failed.push({ slug, reason: "invalid_output", issues: [] });
				continue;
			}
			const outcome = await translate(file.node as unknown as NodePayload, options.locale);
			usage.inputTokens += outcome.usage.inputTokens;
			usage.outputTokens += outcome.usage.outputTokens;
			usage.costUsd += outcome.usage.costUsd;
			if (!outcome.ok) {
				failed.push({ slug, reason: outcome.reason, issues: outcome.issues });
				continue;
			}
			const next = withTranslation(file.node, options.locale, outcome.translation);
			if (!passesSchema(next)) {
				// The node, not the model, is at fault, so there is no validator issue to report.
				failed.push({ slug, reason: "invalid_output", issues: [] });
				continue;
			}
			// The node was read before the run began: never overwrite a change made since.
			if (!isDeepStrictEqual(JSON.parse(await readFile(file.path, "utf8")), file.node)) {
				throw new Error(`${slug}: changed on disk during the run; stopping (a second run resumes)`);
			}
			await atomicWriteJson(file.path, next);
			const { l10n: _after, ...after } = JSON.parse(await readFile(file.path, "utf8")) as Obj;
			const { l10n: _before, ...before } = file.node;
			if (!isDeepStrictEqual(after, before)) {
				throw new Error(`${slug}: the node on disk differs from the node read, beyond l10n; stopping`);
			}
			translated.push(slug);
		}
	}

	return {
		tool: "translate-nodes",
		locale: options.locale,
		model: translationConfig.model,
		generated_at: new Date().toISOString(),
		applied: options.apply,
		counts,
		translated,
		failed,
		usage,
	};
}

export function formatSummary(manifest: TranslationRunManifest, manifestPath: string): string {
	const lines = [`translate-nodes ${manifest.locale} (${manifest.applied ? "apply" : "preview"})`];
	for (const type of NODE_TYPES) {
		const c = manifest.counts[type];
		lines.push(
			`  ${type.padEnd(8)} total ${c.total}  current ${c.current}  missing ${c.missing}  stale ${c.stale}  ineligible ${c.ineligible}`,
		);
	}
	if (manifest.applied) {
		lines.push(`  translated ${manifest.translated.length}, failed ${manifest.failed.length}`);
		for (const f of manifest.failed) lines.push(`    ${f.slug}: ${f.reason}`);
		lines.push(`  cost $${manifest.usage.costUsd.toFixed(4)}`);
	} else lines.push("  preview: no translator call, no node written (re-run with --apply)");
	lines.push(`manifest: ${manifestPath}`);
	return lines.join("\n");
}

export interface CliArgs extends TranslationRunOptions {
	manifestPath: string;
}

/** `<cache-dir>` then the flags of the contract; null (exit 2) on anything else. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	const args: CliArgs = {
		cacheDir,
		locale: "fr",
		force: false,
		apply: false,
		manifestPath: DEFAULT_MANIFEST_PATH,
	};
	for (let i = 1; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--force") args.force = true;
		else if (flag === "--apply") args.apply = true;
		else {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) return null;
			const list = value.split(",");
			if (flag === "--locale" && (CONTENT_LOCALES as readonly string[]).includes(value)) {
				args.locale = value as ContentLocale;
			} else if (flag === "--types" && list.every(isNodeType)) args.types = list as NodeType[];
			else if (flag === "--slugs" && list.every((s) => isNodeType(s.split(":")[0]) && s.includes(":"))) {
				args.slugs = list as Slug[];
			} else if (flag === "--limit" && /^[1-9]\d*$/.test(value)) args.limit = Number(value);
			else if (flag === "--manifest") args.manifestPath = value;
			else return null;
		}
	}
	return args;
}

/** The CLI without `process`: returns the exit code. `translator` replaces Gemini (tests). */
export async function runCli(
	argv: readonly string[],
	apiKey: string,
	translator?: NodeTranslator,
): Promise<number> {
	const args = parseCliArgs(argv);
	if (!args) {
		process.stderr.write(
			"usage: translate-nodes.ts <cache-dir> [--locale fr] [--types a,b] [--slugs a,b] [--limit n] [--force] [--apply] [--manifest <path>]\n",
		);
		return 2;
	}
	// Before any read: an apply without a key must not look at the cache.
	if (args.apply && !apiKey) {
		process.stderr.write("error: --apply needs GEMINI_API_KEY (or GOOGLE_API_KEY)\n");
		return 2;
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		return 2;
	}
	const translate =
		translator ??
		(args.apply
			? createNodeTranslator({ generate: createGeminiGenerateJson(apiKey) })
			: async () => {
					throw new Error("a preview never translates");
				});
	const manifest = await runTranslation(args, translate);
	await mkdir(dirname(args.manifestPath), { recursive: true });
	await atomicWriteJson(args.manifestPath, manifest);
	console.log(formatSummary(manifest, args.manifestPath));
	return manifest.failed.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	runCli(process.argv.slice(2), pipelineConfig.geminiApiKey).then(
		(code) => process.exit(code),
		(e: unknown) => {
			process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
			process.exit(1);
		},
	);
}
