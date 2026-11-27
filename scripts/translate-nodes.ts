/**
 * Batch tool that writes `l10n.<locale>` into the nodes of a cache (TRA-808, plan docs/plans/track1-contenu-fr.md
 * part 2). Nodes are taken in slug order, `--concurrency` at a time, at most `--rpm` calls started per sliding
 * minute (TRA-811). A "call" is a translator call: the translator retries once on an invalid answer, so the
 * provider can see up to twice `--rpm` requests (keep `--rpm` under half the key's limit when it matters).
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
 * - Quota stop (TRA-811, plan risk R8): three results in a row that are `quota_exhausted` or
 *   `provider_unavailable` (any mix) stop the batch. Calls in flight finish and their valid results are
 *   written, nothing new starts, `stopped` carries the last reason, and the three nodes are left out of
 *   `failed`: they are not at fault, and the next run takes them again like any untranslated node. A success
 *   or an `invalid_output` (the provider did answer) resets the series.
 * - Permanent refusal stop (TRA-837, 2026-11-26): a `provider_rejected` (404 model not found, 401, 403)
 *   stops the batch at the first one, with its own exit code: waiting and relaunching cannot fix it, and
 *   exit 3 says exactly that. The node is left out of `failed`, like the nodes of a quota stop, and the stop
 *   names it (`rejected_slugs`, and the `STOPPED:` line).
 * - 400 (`bad_request`, review of #742): a 400 often depends on one node's request, so a lone one fails that
 *   node (in `failed`, with its slug and `provider_error`) and the batch goes on. Three in a row (a setting
 *   the model refuses for every node) stop the batch as `provider_rejected`, exit 4, the three slugs in
 *   `rejected_slugs` and out of `failed`. Any other result restarts that series; it is independent of the
 *   quota series above, which a 400 restarts too (the provider did answer).
 * - Why the provider failed (TRA-837): a provider failure carries its HTTP status and a truncated message,
 *   written to the manifest (`provider_error`, on the stop and on each `failed` entry) and to the summary. The
 *   pilot of TRA-812 only read `STOPPED: provider_unavailable` for a 404 on the model. The provider removes the
 *   API key and the request text from the message before it gets here.
 * - `attempts`: the manifest gives, for each translated node, the 1 or 2 translator attempts it took, and the
 *   summary counts "first attempt / second attempt" (the pilot PR has to report that split).
 * - Resume (TRA-839, 2026-11-26): `--limit n` counts the nodes handed to the translator in one pass, so "run the
 *   same command again" after a stop with k nodes written would translate n more, n + k in all (the pilot of
 *   TRA-812 had a ceiling of 30). A stop on quota or on passing failures now prints the command to run with
 *   `--limit n-k`. With `--force` no command is printed: the same one would take the k written nodes again.
 *   After a `provider_rejected` (exit 4) no resume is offered: the cause has to be fixed first.
 * - Interruption (TRA-839): SIGINT or SIGTERM, in `--apply`, stops the pass like a quota stop (calls in flight
 *   finish and are written, nothing new starts, a wait for a rate slot is cut short), then the sample and the
 *   manifest are written with what is already translated (`interrupted` in the manifest, exit 130 / 143). On
 *   TRA-812 a pass cut by the end of the session after 21 nodes lost its manifest (usage, refusals) and its
 *   sample, and the 21 files had to be put back and the pass replayed. A second signal is not caught: it kills
 *   the process at once.
 * - `--sample <path>` (only with `--apply`): a Markdown file with a regular draw of `--sample-size` of the
 *   nodes translated in this pass, English then French, for a human to read before the batch is merged.
 *
 * Exit codes: 0 done, 1 done with `failed` (or an error), 2 usage, 3 stopped on quota or on passing provider
 * failures (wins over 1), 130 / 143 interrupted by SIGINT / SIGTERM (wins over 1 and 3), 4 stopped on a
 * permanent provider refusal (wins over all).
 * Flags: see `parseCliArgs`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
	type ProviderFailureDetail,
	type ProviderFailureReason,
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
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_RPM = 120;
export const DEFAULT_SAMPLE_SIZE = 30;
const MAX_CONCURRENCY = 16;
const MAX_RPM = 2000;
const RPM_WINDOW_MS = 60_000;
/** Consecutive provider-side failures that stop the batch. */
const STOP_AFTER = 3;

type Obj = Record<string, unknown>;
type Status = "current" | "missing" | "stale" | "ineligible";
/** A `bad_request` never stops the batch under its own name: three in a row stop it as `provider_rejected`. */
type Stopped = Exclude<ProviderFailureReason, "bad_request">;
export const EXIT_STOPPED_PASSING = 3;
export const EXIT_STOPPED_PERMANENT = 4;
/** The signals that interrupt a pass; the exit code is the shell convention, 128 + the signal number. */
export const EXIT_INTERRUPTED = { SIGINT: 130, SIGTERM: 143 } as const;
export type InterruptSignal = keyof typeof EXIT_INTERRUPTED;
const isInterruptSignal = (value: unknown): value is InterruptSignal =>
	value === "SIGINT" || value === "SIGTERM";
/** What `runCli` listens to: the process, or an emitter in tests. */
export interface InterruptSource {
	once(signal: InterruptSignal, listener: () => void): unknown;
	off(signal: InterruptSignal, listener: () => void): unknown;
}
const RESUME_SAME_COMMAND = "run the same command again to resume";

export interface TranslationRunOptions {
	cacheDir: string;
	locale: ContentLocale;
	types?: readonly NodeType[];
	slugs?: readonly Slug[];
	limit?: number;
	force: boolean;
	apply: boolean;
	// Optional here (the CLI always fills them): the TRA-808 callers do not know them, and a run without them
	// must behave as the defaults say.
	concurrency?: number;
	rpm?: number;
	sampleSize?: number;
	samplePath?: string;
	/** Aborted with the name of the signal as reason (`controller.abort("SIGTERM")`) to interrupt the pass. */
	signal?: AbortSignal;
	/** Clock and wait, injected by tests only. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface TranslationRunManifest {
	tool: "translate-nodes";
	locale: ContentLocale;
	model: string;
	generated_at: string;
	applied: boolean;
	/** `total` = current + missing + stale + ineligible, over the nodes the filters select. */
	counts: Record<NodeType, Record<"total" | Status, number>>;
	/** Sorted: nodes finish out of slug order when several calls run at once. */
	translated: Slug[];
	/** Translator attempts (1 = accepted at once, 2 = after the retry) of each node in `translated`, in slug order. */
	attempts: Record<string, 1 | 2>;
	failed: {
		slug: Slug;
		reason: TranslationFailure;
		issues: TranslationIssue[];
		provider_error?: ProviderFailureDetail;
	}[];
	usage: TranslationUsage;
	stopped?: Stopped;
	/** Why the provider failed on the result that raised `stopped`. */
	provider_error?: ProviderFailureDetail;
	/** With `stopped: "provider_rejected"`: the slug(s) whose requests the provider refused, slug order. */
	rejected_slugs?: Slug[];
	/** The pass was cut short by this signal (TRA-839): `translated` holds what was written before. */
	interrupted?: InterruptSignal;
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

/**
 * Hands out call slots: at most `rpm` per sliding minute, in the order they are asked for. A queue and a clock
 * are enough, so no dependency.
 */
function createRateLimiter(rpm: number, now: () => number, sleep: (ms: number) => Promise<void>) {
	const starts: number[] = [];
	let tail: Promise<void> = Promise.resolve();
	const take = async (): Promise<void> => {
		for (;;) {
			const t = now();
			let oldest = starts[0];
			while (oldest !== undefined && t - oldest >= RPM_WINDOW_MS) {
				starts.shift();
				oldest = starts[0];
			}
			if (oldest === undefined || starts.length < rpm) {
				starts.push(t);
				return;
			}
			await sleep(oldest + RPM_WINDOW_MS - t);
		}
	};
	return () => {
		tail = tail.then(take);
		return tail;
	};
}

const bySlug = (a: { slug: string }, b: { slug: string }) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** `size` items at a regular step through the (already sorted) list; the whole list when it is not longer. */
function pickSample<T>(sorted: readonly T[], size: number): T[] {
	if (sorted.length <= size) return [...sorted];
	return Array.from({ length: size }, (_, i) => sorted[Math.floor((i * sorted.length) / size)] as T);
}

interface WrittenTranslation {
	slug: Slug;
	node: Obj;
	translation: NodeTranslation;
	attempts: 1 | 2;
}

function renderSample(entries: readonly WrittenTranslation[], locale: ContentLocale): string {
	const parts = [`# translate-nodes ${locale}: sample of ${entries.length} node(s)`];
	if (entries.length === 0) parts.push("No node was translated in this pass.");
	for (const { slug, node, translation } of entries) {
		const source = translationSourceOf(node as unknown as NodePayload);
		parts.push(`## ${slug}`, "### EN", `**Teaser**\n\n${source.teaser}`, `**Article**\n\n${source.article}`);
		parts.push(`### ${locale.toUpperCase()}`, `**Teaser**\n\n${translation.teaser}`);
		parts.push(`**Article**\n\n${translation.article}`);
		const facts = Object.entries(translation.facts ?? {});
		if (facts.length > 0) parts.push(`**Facts**\n\n${facts.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
	}
	return `${parts.join("\n\n")}\n`;
}

export async function runTranslation(
	options: TranslationRunOptions,
	translate: NodeTranslator,
): Promise<TranslationRunManifest> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const rpm = options.rpm ?? DEFAULT_RPM;
	// The CLI refuses these first (exit 2); a hole here would hang the run, so a caller that gets it wrong throws.
	for (const [name, value, max] of [
		["concurrency", concurrency, MAX_CONCURRENCY],
		["rpm", rpm, MAX_RPM],
	] as const) {
		if (!Number.isInteger(value) || value < 1 || value > max) {
			throw new RangeError(`${name} must be an integer from 1 to ${max}, got ${value}`);
		}
	}
	const { nodes, invalid } = await readCacheNodes(options.cacheDir);
	warnSkippedNodeFiles(invalid);
	const counts = Object.fromEntries(
		NODE_TYPES.map((type) => [type, { total: 0, current: 0, missing: 0, stale: 0, ineligible: 0 }]),
	) as TranslationRunManifest["counts"];
	const usage: TranslationUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	const written: WrittenTranslation[] = [];
	let failed: TranslationRunManifest["failed"] = [];
	const stop: { reason?: Stopped; providerError?: ProviderFailureDetail; rejected?: Slug[] } = {};

	const todo: typeof nodes = [];
	for (const file of nodes) {
		if (options.types && !options.types.includes(file.type)) continue;
		if (options.slugs && !options.slugs.includes(file.slug as Slug)) continue;
		const status = statusOf(file.node, file.type, options.locale);
		counts[file.type].total++;
		counts[file.type][status]++;
		if (status !== "ineligible" && (status !== "current" || options.force)) todo.push(file);
	}

	const takeSlot = createRateLimiter(
		rpm,
		options.now ?? Date.now,
		options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
	);
	const queue = todo.slice(0, options.limit);
	let cursor = 0;
	// Set by a quota stop or by an error in a worker: nothing new starts, calls in flight finish.
	let halted = false;
	// Slugs of the current run of provider-side failures, in the order the results arrived.
	let series: Slug[] = [];
	// Slugs of the current run of 400 answers (TRA-837); any other result starts it again.
	let badRequests: Slug[] = [];
	// An interruption halts like a stop; `interruption` also cuts short a worker that waits for a rate slot,
	// which can be a whole minute.
	const { signal } = options;
	if (signal?.aborted) halted = true;
	const interruption =
		signal === undefined
			? undefined
			: new Promise<void>((resolve) => {
					const halt = () => {
						halted = true;
						resolve();
					};
					if (signal.aborted) halt();
					else signal.addEventListener("abort", halt, { once: true });
				});

	// One worker: the apply branch below runs `concurrency` of them. A preview never calls it.
	const work = async (): Promise<void> => {
		while (!halted) {
			const file = queue[cursor++];
			if (file === undefined) return;
			const slug = file.slug as Slug;
			// A node the schema would alter can never be written: refuse it before paying for a translation.
			const { l10n: _l10n, ...bare } = file.node;
			if (!passesSchema(bare)) {
				failed.push({ slug, reason: "invalid_output", issues: [] });
				continue;
			}
			await (interruption === undefined ? takeSlot() : Promise.race([takeSlot(), interruption]));
			// The stop may have come while this call waited for its slot.
			if (halted) return;
			const outcome = await translate(file.node as unknown as NodePayload, options.locale);
			usage.inputTokens += outcome.usage.inputTokens;
			usage.outputTokens += outcome.usage.outputTokens;
			usage.costUsd =
				usage.costUsd === null || outcome.usage.costUsd === null
					? null
					: usage.costUsd + outcome.usage.costUsd;
			if (!outcome.ok) {
				const { reason } = outcome;
				const withDetail = outcome.detail === undefined ? {} : { provider_error: outcome.detail };
				if (reason === "invalid_output") {
					series = [];
					badRequests = [];
					failed.push({ slug, reason, issues: outcome.issues });
				} else if (stop.reason === undefined && reason === "provider_rejected") {
					// Holds for the whole batch (TRA-837): no series to wait for, since every request will be
					// refused the same way. Like the nodes of a quota stop, this one is not at fault: left for
					// the next run, and so are the passing failures of the current series, which the stop makes
					// moot. The stop names it, so the operator sees which request was refused.
					stop.reason = reason;
					stop.rejected = [slug];
					if (outcome.detail !== undefined) stop.providerError = outcome.detail;
					halted = true;
					const inSeries = new Set(series);
					failed = failed.filter((f) => !inSeries.has(f.slug));
				} else if (stop.reason === undefined && reason === "bad_request") {
					// A 400 often depends on this node's request (review of #742, 2026-11-26: a lone one froze every
					// run on the same node). It fails this node only, and the provider did answer, so the quota
					// series restarts. Three in a row mean the model refuses a setting for every node: same stop
					// as a permanent refusal.
					series = [];
					badRequests.push(slug);
					failed.push({ slug, reason, issues: outcome.issues, ...withDetail });
					if (badRequests.length >= STOP_AFTER) {
						stop.reason = "provider_rejected";
						stop.rejected = [...badRequests];
						if (outcome.detail !== undefined) stop.providerError = outcome.detail;
						halted = true;
						// Not at fault, like the nodes of a quota stop: named by the stop instead of listed in `failed`.
						const raisedIt = new Set(badRequests);
						failed = failed.filter((f) => !raisedIt.has(f.slug));
					}
				} else if (stop.reason === undefined && reason !== "bad_request") {
					// A result that lands after the stop is the same outage: left for the next run, not a failure.
					badRequests = [];
					series.push(slug);
					failed.push({ slug, reason, issues: outcome.issues, ...withDetail });
					if (series.length >= STOP_AFTER) {
						stop.reason = reason;
						if (outcome.detail !== undefined) stop.providerError = outcome.detail;
						halted = true;
						const raisedIt = new Set(series);
						failed = failed.filter((f) => !raisedIt.has(f.slug));
					}
				}
				continue;
			}
			series = [];
			badRequests = [];
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
			written.push({ slug, node: file.node, translation: outcome.translation, attempts: outcome.attempts });
		}
	};

	if (options.apply) {
		const halting = (error: unknown): never => {
			halted = true;
			throw error;
		};
		// Let every worker settle before rethrowing, so no write is left running behind the error.
		const settled = await Promise.allSettled(
			Array.from({ length: concurrency }, () => work().catch(halting)),
		);
		for (const result of settled) if (result.status === "rejected") throw result.reason;

		// Results arrive in completion order; the manifest and the sample must not depend on it.
		written.sort(bySlug);
		failed.sort(bySlug);
		if (options.samplePath !== undefined) {
			try {
				const sample = pickSample(written, options.sampleSize ?? DEFAULT_SAMPLE_SIZE);
				await mkdir(dirname(options.samplePath), { recursive: true });
				await writeFile(options.samplePath, renderSample(sample, options.locale));
			} catch (error) {
				// The nodes are paid for and written: a sample that cannot be written must not cost the manifest.
				process.stderr.write(
					`warning: sample not written: ${error instanceof Error ? error.message : error}\n`,
				);
			}
		}
	}

	const interrupted = options.apply && signal?.aborted ? signal.reason : undefined;
	return {
		tool: "translate-nodes",
		locale: options.locale,
		model: translationConfig.model,
		generated_at: new Date().toISOString(),
		applied: options.apply,
		counts,
		translated: written.map((w) => w.slug),
		attempts: Object.fromEntries(written.map((w) => [w.slug, w.attempts])),
		failed,
		usage,
		...(stop.reason === undefined ? {} : { stopped: stop.reason }),
		...(stop.providerError === undefined ? {} : { provider_error: stop.providerError }),
		...(stop.rejected === undefined ? {} : { rejected_slugs: [...stop.rejected].sort() as Slug[] }),
		...(isInterruptSignal(interrupted) ? { interrupted } : {}),
	};
}

/** ` (HTTP 404: message)`, ` (message)` when no answer came, "" when the provider gave nothing. */
function describeProviderError(detail: ProviderFailureDetail | undefined): string {
	if (detail === undefined) return "";
	return ` (${detail.status === undefined ? "" : `HTTP ${detail.status}: `}${detail.message})`;
}

/**
 * `resume` says how to carry on after a stop or an interruption (see `resumeAdvice`); without it, the same
 * command, which is only right for a run without `--limit` and without `--force`.
 */
export function formatSummary(
	manifest: TranslationRunManifest,
	manifestPath: string,
	resume: string = RESUME_SAME_COMMAND,
): string {
	const lines = [`translate-nodes ${manifest.locale} (${manifest.applied ? "apply" : "preview"})`];
	for (const type of NODE_TYPES) {
		const c = manifest.counts[type];
		lines.push(
			`  ${type.padEnd(8)} total ${c.total}  current ${c.current}  missing ${c.missing}  stale ${c.stale}  ineligible ${c.ineligible}`,
		);
	}
	if (manifest.applied) {
		lines.push(`  translated ${manifest.translated.length}, failed ${manifest.failed.length}`);
		const second = Object.values(manifest.attempts).filter((attempts) => attempts === 2).length;
		lines.push(
			`  accepted on first attempt ${manifest.translated.length - second} / second attempt ${second}`,
		);
		for (const f of manifest.failed)
			lines.push(`    ${f.slug}: ${f.reason}${describeProviderError(f.provider_error)}`);
		lines.push(
			manifest.usage.costUsd === null
				? "  cost unknown (no tariff for the model)"
				: `  cost $${manifest.usage.costUsd.toFixed(4)}`,
		);
		if (manifest.stopped) {
			const why = `${manifest.stopped}${describeProviderError(manifest.provider_error)}`;
			const rejected = manifest.rejected_slugs ?? [];
			lines.push(
				manifest.stopped === "provider_rejected"
					? `  STOPPED: ${why}${rejected.length > 0 ? ` for ${rejected.join(", ")}` : ""}; the provider will refuse every retry: fix the cause (model, key, setting), then run again`
					: `  STOPPED: ${why}; ${resume}`,
			);
		}
		if (manifest.interrupted) {
			const written = `${manifest.translated.length} node(s) written, sample and manifest kept`;
			const next = manifest.stopped === "provider_rejected" ? "" : `; ${resume}`;
			lines.push(`  INTERRUPTED: ${manifest.interrupted}, ${written}${next}`);
		}
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
		concurrency: DEFAULT_CONCURRENCY,
		rpm: DEFAULT_RPM,
		sampleSize: DEFAULT_SAMPLE_SIZE,
	};
	const integerIn = (text: string, max: number) => /^[1-9]\d*$/.test(text) && Number(text) <= max;
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
			else if (flag === "--concurrency" && integerIn(value, MAX_CONCURRENCY))
				args.concurrency = Number(value);
			else if (flag === "--rpm" && integerIn(value, MAX_RPM)) args.rpm = Number(value);
			else if (flag === "--sample") args.samplePath = value;
			else if (flag === "--sample-size" && integerIn(value, Number.MAX_SAFE_INTEGER)) {
				args.sampleSize = Number(value);
			} else return null;
		}
	}
	return args;
}

/** Printable as one shell word: bare when it holds nothing the shell would read, else single-quoted. */
const shellWord = (text: string) =>
	/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

/**
 * How to carry on after a stop or an interruption that left `written` nodes in the cache (TRA-839).
 * `--limit n` counts the nodes sent in a pass and the written ones are no longer missing, so the same command
 * would do n more: the command given has `--limit n-written`, which keeps the total at n.
 */
export function resumeAdvice(argv: readonly string[], args: CliArgs, written: number): string {
	if (args.force && written > 0) {
		return `do not run the same command again: --force would translate the ${written} node(s) already written again; list the nodes still to do with --slugs`;
	}
	if (args.limit === undefined) return RESUME_SAME_COMMAND;
	const remaining = args.limit - written;
	if (remaining < 1) return "the --limit is reached, nothing is left to resume";
	// The last --limit is the one `parseCliArgs` keeps.
	const at = argv
		.map((word, i) => (word === "--limit" && i > 0 ? i : -1))
		.reduce((a, b) => Math.max(a, b), -1);
	const words = argv.map((word, i) => (i === at + 1 ? String(remaining) : word));
	return `resume with: npm run translate:nodes -- ${words.map(shellWord).join(" ")}`;
}

/** The CLI without `process`: returns the exit code. `translator` replaces Gemini (tests). */
export async function runCli(
	argv: readonly string[],
	apiKey: string,
	translator?: NodeTranslator,
	interrupts: InterruptSource = process,
): Promise<number> {
	const args = parseCliArgs(argv);
	if (!args) {
		process.stderr.write(
			"usage: translate-nodes.ts <cache-dir> [--locale fr] [--types a,b] [--slugs a,b] [--limit n] [--force] [--apply] [--manifest <path>] [--concurrency 1-16] [--rpm 1-2000] [--sample <path>] [--sample-size n]\n",
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
	// Caught from the start of the pass until the manifest is written (TRA-839): a signal in between must not
	// cost the manifest either. Only a pass that translates listens; `once`, so a second signal kills at once.
	const controller = new AbortController();
	const listeners = args.apply
		? (["SIGINT", "SIGTERM"] as const).map((name) => {
				const listener = () => controller.abort(name);
				interrupts.once(name, listener);
				return { name, listener };
			})
		: [];
	try {
		const manifest = await runTranslation(
			args.apply ? { ...args, signal: controller.signal } : args,
			translate,
		);
		await mkdir(dirname(args.manifestPath), { recursive: true });
		await atomicWriteJson(args.manifestPath, manifest);
		const stoppedOrCut = manifest.stopped !== undefined || manifest.interrupted !== undefined;
		const resume = stoppedOrCut ? resumeAdvice(argv, args, manifest.translated.length) : undefined;
		console.log(formatSummary(manifest, args.manifestPath, resume));
		if (args.apply && args.samplePath !== undefined) console.log(`sample: ${args.samplePath}`);
		// The manifest is written above, before this code is returned: a stop never loses it.
		if (manifest.stopped === "provider_rejected") return EXIT_STOPPED_PERMANENT;
		if (manifest.interrupted) return EXIT_INTERRUPTED[manifest.interrupted];
		return manifest.stopped ? EXIT_STOPPED_PASSING : manifest.failed.length > 0 ? 1 : 0;
	} finally {
		for (const { name, listener } of listeners) interrupts.off(name, listener);
	}
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
