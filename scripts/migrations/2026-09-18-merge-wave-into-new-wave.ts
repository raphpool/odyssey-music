/**
 * CLI, disk application and report for a single, one-off genre merge (TRA-248, arbitrage n°18 of
 * TRA-229, 2026-09-17): `genre:wave` (Q106369996) actually describes New Wave, not a distinct
 * "Wave" genre -- merged into `genre:new-wave` (Q187760): edges unioned onto the winner, every
 * cache-wide incoming reference (list edges, singular edges, pending-reverses.json) rewritten to
 * point at `genre:new-wave`, a `genre:wave -> genre:new-wave` redirect recorded, then `genre:wave`
 * deleted last.
 *
 * (TRA-229's arbitrage n°18 also called for deleting a fake track that was inflating Death
 * Metal's coverage count -- split out to TRA-273 during review, since bundling it here pushed
 * this PR's diff past the review budget without any way to trim it that didn't mean compressing
 * tests. That deletion is unrelated cache state: no node this migration touches references it.)
 *
 * Reuses 2026-09-04-merge-genre-duplicates.ts rather than duplicating it (mergeGenreEdges,
 * rewriteNodeEdges, rewritePendingReverses, mergeRedirects, readCacheNodes, looksLikeCacheDir,
 * isRecord, isNodeType, defaultDataDir, readTextOrDefault, parseCliArgs, plus atomicWriteJson
 * from src/cache.ts). Unlike that script and 2026-09-10-rename-genre-node.ts, this one does NOT
 * re-implement their ONBOARDING_GENRES/genre-taxonomy protection (TRA-138/TRA-139): both are
 * general-purpose tools meant to run again on arbitrary future slugs, where that guard matters;
 * this one is a single-purpose, hardcoded script for exactly this merge. Checked at review time
 * (2026-09-18): `genre:wave` is in neither ONBOARDING_GENRES nor the published taxonomy, so the
 * guard would not fire here anyway. A future single-slug merge script should re-add it rather
 * than copy this one's omission.
 *
 * Dry-run by default; fails loudly (an invariant violation writes nothing) and is idempotent --
 * a second `--apply` run is a no-op once the merge has landed.
 *
 * Usage: tsx scripts/migrations/2026-09-18-merge-wave-into-new-wave.ts <cache-dir> [--apply]
 *        [--redirects <path>]
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { loadGenreRedirects, parseGenreRedirects } from "../../src/genre-registry.js";
import { LIST_EDGES_BY_TYPE, type NodeType, SINGULAR_EDGES_BY_TYPE } from "../../src/node-spec.js";
import type { Slug } from "../../src/types.js";
import {
	type CliArgs,
	defaultDataDir,
	isNodeType,
	isRecord,
	looksLikeCacheDir,
	mergeGenreEdges,
	mergeRedirects,
	parseCliArgs,
	type RewriteTarget,
	readCacheNodes,
	readTextOrDefault,
	rewriteNodeEdges,
	rewritePendingReverses,
	warnSkippedNodeFiles,
} from "./2026-09-04-merge-genre-duplicates.js";

export { type CliArgs, parseCliArgs };

export const WAVE: Slug = "genre:wave";
export const NEW_WAVE: Slug = "genre:new-wave";

function formatReport(args: {
	alreadyMerged: boolean;
	hitsByType: ReadonlyMap<NodeType, number>;
	qidFixes: number;
	redirects: { newCount: number; totalCount: number };
	dryRun: boolean;
	note?: string;
}): string {
	const { hitsByType, qidFixes, redirects, dryRun, note } = args;
	const totalRewritten = [...hitsByType.values()].reduce((sum, n) => sum + n, 0);
	const lines: string[] = [`=== Wave -> New Wave genre merge${dryRun ? " (DRY RUN)" : ""} ===`];
	if (note) {
		lines.push(note);
		return lines.join("\n");
	}
	lines.push(`${"Merge:".padEnd(28)}${args.alreadyMerged ? "already done" : "applied"}`);
	lines.push(`${"Incoming edges rewritten:".padEnd(28)}${totalRewritten}`);
	lines.push(`${"Denormalized qids fixed:".padEnd(28)}${qidFixes}`);
	lines.push(`${"Redirects (new/total):".padEnd(28)}${redirects.newCount}/${redirects.totalCount}`);

	lines.push("", "=== Edges rewritten by node type ===");
	if (hitsByType.size === 0) {
		lines.push("  (none)");
	} else {
		for (const [type, count] of [...hitsByType.entries()].sort()) {
			lines.push(`  ${type.padEnd(10)} ${count}`);
		}
	}
	lines.push(`  ${"total".padEnd(10)} ${totalRewritten}`);

	return lines.join("\n");
}

export interface MigrationResult {
	report: string;
	applied: boolean;
	exitCode: 0 | 1;
}

/**
 * Runs the full migration against `cacheDir`: builds the plan in memory, verifies its invariants
 * before touching disk, and -- only if clean and `apply` is set -- writes. Never calls
 * process.exit; exit-code semantics only, so it's directly testable.
 */
export async function runMigration(
	cacheDir: string,
	apply: boolean,
	options: { redirectsPath?: string } = {},
): Promise<MigrationResult> {
	const { nodes, invalid } = await readCacheNodes(cacheDir);
	warnSkippedNodeFiles(invalid);
	const bySlug = new Map(nodes.map((f) => [f.slug, f]));

	const redirectsPath = options.redirectsPath ?? join(defaultDataDir(), "genre-redirects.json");
	const errors: string[] = [];

	// A file that exists on disk but failed to parse lands in `invalid`, not `nodes` -- so
	// without this check it would read exactly like a slug that was never there, and the
	// idempotence check below would mistake corruption for "already merged" and quietly skip it
	// (code review, 2026-09-18). readCacheNodes always builds an invalid entry's path as
	// `<root>/nodes/<slug>`, so a trailing-slug match reliably identifies which target it was.
	for (const target of [WAVE, NEW_WAVE]) {
		if (invalid.some((i) => i.path.endsWith(target))) {
			errors.push(
				`${target} exists on disk but failed to read -- refusing rather than treating it as absent`,
			);
		}
	}
	let existingRedirects = new Map<string, string>();
	try {
		existingRedirects = new Map(await loadGenreRedirects(redirectsPath));
	} catch (e) {
		errors.push(`existing redirects table failed to load: ${e instanceof Error ? e.message : String(e)}`);
	}

	const waveFile = bySlug.get(WAVE);
	const newWaveFile = bySlug.get(NEW_WAVE);
	const alreadyMerged = !waveFile && !!newWaveFile && existingRedirects.get(WAVE) === NEW_WAVE;

	const earlyReport = (note: string): string =>
		formatReport({
			alreadyMerged,
			hitsByType: new Map(),
			qidFixes: 0,
			redirects: { newCount: 0, totalCount: existingRedirects.size },
			dryRun: !apply,
			note,
		});

	// Idempotence: already merged -- nothing to do, not an error. Gated on errors.length so a
	// corrupt-file refusal above (a real problem) is never masked by this shortcut just because
	// the corrupt slug also happens to be absent from `bySlug`.
	if (errors.length === 0 && alreadyMerged) {
		return { report: earlyReport("Already merged -- nothing to do."), applied: false, exitCode: 0 };
	}

	// --- Refuse on unexpected state ---
	if (!newWaveFile) {
		errors.push(`merge target ${NEW_WAVE} not found`);
	} else if (newWaveFile.type !== "genre") {
		errors.push(`merge target ${NEW_WAVE} is not a genre node (type: ${newWaveFile.type})`);
	}
	if (existingRedirects.has(NEW_WAVE)) {
		errors.push(`merge target ${NEW_WAVE} is itself a redirect source`);
	}
	if (!waveFile) {
		// wave gone but no matching redirect: neither "not started" nor "already merged" -- an
		// unexpected state (e.g. wave deleted by something else), refuse rather than guess.
		if (existingRedirects.get(WAVE) !== NEW_WAVE) {
			errors.push(`${WAVE} is absent and no existing redirect to ${NEW_WAVE} was found -- unexpected state`);
		}
	} else if (waveFile.type !== "genre") {
		errors.push(`${WAVE} is not a genre node (type: ${waveFile.type})`);
	}

	if (errors.length > 0) {
		for (const err of errors) process.stderr.write(`error: ${err}\n`);
		return { report: earlyReport(errors.map((e) => `error: ${e}`).join("\n")), applied: false, exitCode: 1 };
	}
	const source = waveFile as NonNullable<typeof waveFile>;
	const target = newWaveFile as NonNullable<typeof newWaveFile>;

	// --- Plan (in memory, nothing written yet) ---
	const targetQid = typeof target.node.qid === "string" ? target.node.qid : undefined;
	const rewriteMap = new Map<string, RewriteTarget>([
		[WAVE, targetQid ? { slug: NEW_WAVE, qid: targetQid } : NEW_WAVE],
	]);
	const winnerMerged = mergeGenreEdges(target.node, [source.node]);

	// rewriteNodeEdges also deduplicates every OTHER list field on any node it's given --
	// documented, intentional behavior (see its own docstring), but running it cache-wide would
	// silently "fix" unrelated, pre-existing duplicate entries on nodes that have nothing to do
	// with this migration (found in review: dozens of artist/project files gained unrelated
	// diffs on a first pass that ran it over every node). Scoping it to only nodes that actually
	// reference genre:wave keeps every other file byte-identical.
	function referencesWave(node: Record<string, unknown>, type: NodeType): boolean {
		for (const field of [...LIST_EDGES_BY_TYPE[type], ...SINGULAR_EDGES_BY_TYPE[type]]) {
			const value = node[field];
			const edges = Array.isArray(value) ? value : value ? [value] : [];
			for (const edge of edges) {
				if (isRecord(edge) && edge.slug === WAVE) return true;
			}
		}
		return false;
	}

	const writes = new Map<string, Record<string, unknown>>();
	const hitsByType = new Map<NodeType, number>();
	let qidFixesTotal = 0;
	const resultNodes: Record<string, unknown>[] = [];
	for (const file of nodes) {
		if (file.slug === WAVE) continue; // deleted, handled below
		const isWinner = file.slug === NEW_WAVE;
		const base = isWinner ? winnerMerged : file.node;
		if (!isWinner && !referencesWave(base, file.type)) {
			resultNodes.push(base); // untouched: never added to `writes`, stays byte-identical
			continue;
		}
		const { node: rewritten, hits, qidFixes } = rewriteNodeEdges(base, file.type, rewriteMap);
		for (const count of hits.values()) {
			hitsByType.set(file.type, (hitsByType.get(file.type) ?? 0) + count);
		}
		qidFixesTotal += [...qidFixes.values()].reduce((sum, n) => sum + n, 0);
		if (JSON.stringify(rewritten) !== JSON.stringify(file.node)) writes.set(file.path, rewritten);
		resultNodes.push(rewritten);
	}

	// --- Verify invariants in memory before writing anything -- fail loudly, never half-applied.
	// Runs over every surviving node (not just the ones touched above) as a safety net against a
	// bug in referencesWave's scoping.
	for (const node of resultNodes) {
		if (!isNodeType(node.type) || typeof node.slug !== "string") continue;
		if (referencesWave(node, node.type)) {
			errors.push(`dangling edge: ${node.slug} still references ${WAVE} after rewriting`);
		}
	}

	let mergedRedirects: Record<string, string>;
	try {
		mergedRedirects = mergeRedirects(Object.fromEntries(existingRedirects), { [WAVE]: NEW_WAVE });
		parseGenreRedirects({ redirects: mergedRedirects }); // re-validates the flattening invariant
	} catch (e) {
		mergedRedirects = Object.fromEntries(existingRedirects);
		errors.push(`redirects table would fail validation: ${e instanceof Error ? e.message : String(e)}`);
	}

	// A corrupted or truncated pending-reverses.json must fail here, before any write -- fail-fast,
	// never a tolerant read that could silently drop pending edges.
	const pendingPath = join(cacheDir, "pending-reverses.json");
	let pendingParsed: Record<string, PendingReverse[]> = {};
	try {
		pendingParsed = JSON.parse(await readTextOrDefault(pendingPath, "{}")) as Record<
			string,
			PendingReverse[]
		>;
	} catch (e) {
		errors.push(`pending-reverses.json is invalid: ${e instanceof Error ? e.message : String(e)}`);
	}

	const redirectsWritten = { newCount: 1, totalCount: Object.keys(mergedRedirects).length };
	const report = formatReport({
		alreadyMerged,
		hitsByType,
		qidFixes: qidFixesTotal,
		redirects: redirectsWritten,
		dryRun: !apply,
	});

	if (errors.length > 0) {
		for (const err of errors) process.stderr.write(`error: ${err}\n`);
		return { report, applied: false, exitCode: 1 };
	}

	if (!apply) return { report, applied: false, exitCode: 0 };

	// --- Apply, crash-safe order: rewrite nodes, pending-reverses, redirects, THEN delete the
	// loser last -- a loser briefly having both its file and a redirect is harmless; deleting
	// first could leave half-migrated state on a crash.
	for (const [path, node] of writes) await atomicWriteJson(path, node);

	const { result: nextPending, changed: pendingChanged } = rewritePendingReverses(pendingParsed, rewriteMap);
	if (pendingChanged) await atomicWriteJson(pendingPath, nextPending);

	await mkdir(dirname(redirectsPath), { recursive: true });
	await atomicWriteJson(redirectsPath, {
		source: "genre:wave -> genre:new-wave merge (TRA-248)",
		generated_at: new Date().toISOString(),
		redirects: mergedRedirects,
	});

	await rm(source.path);

	return { report, applied: true, exitCode: 0 };
}

async function main(): Promise<void> {
	const args: CliArgs | null = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-09-18-merge-wave-into-new-wave.ts <cache-dir> [--apply] [--redirects <path>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runMigration(
		args.cacheDir,
		args.apply,
		args.redirectsPath ? { redirectsPath: args.redirectsPath } : {},
	);
	console.log(result.report);
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	// Guarded like the other migrations in this directory, so importing this module from a test
	// doesn't require a cache-dir argument or touch the filesystem.
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
