/**
 * CLI, disk application and report for removing a single false cache node entirely: drops
 * every dangling edge that points at it from every other node, drops matching
 * pending-reverses.json entries, and deletes its file last. Dry-run by default; fails loudly
 * (an invariant violation writes nothing) and is idempotent.
 *
 * WHY (2026-09-18, TRA-273): cache/nodes/track/incubus--1987-death-metal-band-from-atlanta.json
 * is a `track` node that in fact describes a *band* (an obscure 1987 Atlanta death metal act,
 * unrelated to the famous rock band Incubus) -- there is no such track. It inflates Death
 * Metal's neighbour count with a phantom track (lot B4c, TRA-204, just published). Split off
 * TRA-248 (TRA-229 arbitration #18), which bundled this removal with an unrelated genre merge
 * (genre:wave -> genre:new-wave) and pushed the diff past the diff-size job's 600-line cap.
 * TRA-248 keeps the merge; this migration only removes the track. Server sync (B6) is out of
 * scope.
 *
 * Reuses 2026-09-04-merge-genre-duplicates.ts rather than duplicating it (readCacheNodes,
 * looksLikeCacheDir, parseCliArgs, isRecord, isNodeType, readTextOrDefault, plus
 * atomicWriteJson from src/cache.ts). rewriteNodeEdges/rewritePendingReverses in that module
 * always rewrite a dangling edge to a *replacement* slug -- there is no replacement here, so
 * this migration drops the edge instead (dropEdgesToSlug/dropPendingReversesForSlug below).
 *
 * Usage: tsx scripts/migrations/2026-09-18-remove-track-incubus.ts <cache-dir> [--apply]
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, type PendingReverse } from "../../src/cache.js";
import { LIST_EDGES_BY_TYPE, type NodeType, SINGULAR_EDGES_BY_TYPE } from "../../src/node-spec.js";
import { parseSlug } from "../../src/slug.js";
import {
	isNodeType,
	isRecord,
	looksLikeCacheDir,
	parseCliArgs,
	readCacheNodes,
	readTextOrDefault,
} from "./2026-09-04-merge-genre-duplicates.js";

/** The one node this migration ever removes -- deliberately not a parameter, unlike the merge
 * and rename migrations: this one is scoped to a single known defect (see header). */
export const TARGET_SLUG = "track:incubus--1987-death-metal-band-from-atlanta";

/**
 * Drops every edge on `node` whose slug is `targetSlug` -- a plain removal, not a rewrite to a
 * replacement (contrast rewriteNodeEdges in the merge script). Returns the hit count, for the
 * report.
 */
export function dropEdgesToSlug(
	node: Record<string, unknown>,
	type: NodeType,
	targetSlug: string,
): { node: Record<string, unknown>; hits: number } {
	let hits = 0;
	const next: Record<string, unknown> = { ...node };

	for (const field of LIST_EDGES_BY_TYPE[type]) {
		const list = node[field];
		if (!Array.isArray(list)) continue;
		next[field] = list.filter((edge) => {
			const isTarget = isRecord(edge) && edge.slug === targetSlug;
			if (isTarget) hits += 1;
			return !isTarget;
		});
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[type]) {
		const value = node[field];
		if (isRecord(value) && value.slug === targetSlug) {
			hits += 1;
			next[field] = undefined;
		}
	}

	return { node: next, hits };
}

/**
 * Drops pending-reverses.json entries touching `targetSlug`: the whole key (the node awaiting
 * those reverses is itself being deleted), plus any entry in another key's list whose edge
 * points at it. A key left with an empty list is dropped entirely rather than kept as `[]`.
 */
export function dropPendingReversesForSlug(
	pending: Readonly<Record<string, PendingReverse[]>>,
	targetSlug: string,
): { result: Record<string, PendingReverse[]>; changed: boolean } {
	const result: Record<string, PendingReverse[]> = {};
	let changed = false;

	for (const [key, list] of Object.entries(pending)) {
		if (key === targetSlug) {
			changed = true;
			continue;
		}
		const filtered = list.filter((pr) => pr.edge.slug !== targetSlug);
		if (filtered.length !== list.length) changed = true;
		if (filtered.length > 0) result[key] = filtered;
	}

	return { result, changed };
}

// --- Report formatting ---

function formatRemovalReport(args: {
	targetSlug: string;
	alreadyRemoved: boolean;
	danglingEdgesDropped: number;
	pendingReversesChanged: boolean;
	dryRun: boolean;
}): string {
	const { targetSlug, alreadyRemoved, danglingEdgesDropped, pendingReversesChanged, dryRun } = args;
	const lines: string[] = [`=== Remove false node${dryRun ? " (DRY RUN)" : ""} ===`];
	lines.push(`${"Target:".padEnd(24)}${targetSlug}`);

	if (alreadyRemoved) {
		lines.push(`${"Status:".padEnd(24)}already removed -- nothing to do`);
		return lines.join("\n");
	}

	lines.push(`${"Dangling edges dropped:".padEnd(24)}${danglingEdgesDropped}`);
	lines.push(`${"pending-reverses.json:".padEnd(24)}${pendingReversesChanged ? "updated" : "unchanged"}`);

	return lines.join("\n");
}

// --- Migration runner ---

export interface MigrationResult {
	report: string;
	deletedCount: 0 | 1;
	exitCode: 0 | 1;
}

/**
 * Runs the full migration against `cacheDir`: builds the plan in memory, verifies its
 * invariants before touching disk, and -- only if clean and `apply` is set -- writes. Never
 * calls process.exit; exit-code semantics only, so it's directly testable.
 */
export async function runMigration(cacheDir: string, apply: boolean): Promise<MigrationResult> {
	const { nodes, invalid } = await readCacheNodes(cacheDir);
	for (const { path, error } of invalid) {
		process.stderr.write(`warning: skipping unreadable node file ${path}: ${error}\n`);
	}

	const target = nodes.find((n) => n.slug === TARGET_SLUG);

	// Independent of readCacheNodes's own `invalid` list, whose entries carry a path built from
	// the raw slug -- an internal detail of that shared function, not a contract to depend on.
	// A file that EXISTS at the real path but isn't in `nodes` failed to parse and must refuse,
	// never be treated as "already removed" -- only a genuine stat ENOENT is that.
	if (!target) {
		const { type: targetType, body: targetBody } = parseSlug(TARGET_SLUG);
		const targetRealPath = join(cacheDir, "nodes", targetType, `${targetBody}.json`);
		const onDisk = await stat(targetRealPath)
			.then(() => true)
			.catch(() => false);
		if (onDisk) {
			return {
				report:
					`=== Remove false node${apply ? "" : " (DRY RUN)"} ===\n` +
					`refusing: ${TARGET_SLUG} is on disk at ${targetRealPath} but failed to parse -- ` +
					"a corrupted node is never treated as already removed\n",
				deletedCount: 0,
				exitCode: 1,
			};
		}
		return {
			report: formatRemovalReport({
				targetSlug: TARGET_SLUG,
				alreadyRemoved: true,
				danglingEdgesDropped: 0,
				pendingReversesChanged: false,
				dryRun: !apply,
			}),
			deletedCount: 0,
			exitCode: 0,
		};
	}

	const errors: string[] = [];
	// Content drift guard: the file lives at the right path (that's how it was found above), but
	// its own declared slug/type must still agree -- otherwise this would silently delete
	// whatever got materialized there instead, not the defect this migration targets.
	if (target.node.slug !== TARGET_SLUG) {
		errors.push(`${TARGET_SLUG}'s on-disk slug field is ${JSON.stringify(target.node.slug)} -- refusing`);
	}
	if (target.node.type !== "track") {
		errors.push(`${TARGET_SLUG}'s on-disk type field is ${JSON.stringify(target.node.type)} -- refusing`);
	}

	// --- Plan (in memory, nothing written yet): drop every edge across every other node that
	// points at the target.
	const writes = new Map<string, Record<string, unknown>>();
	let danglingEdgesDropped = 0;
	const resultNodes: Record<string, unknown>[] = [];
	for (const file of nodes) {
		if (file.slug === TARGET_SLUG) continue;
		const { node: rewritten, hits } = dropEdgesToSlug(file.node, file.type, TARGET_SLUG);
		if (hits > 0) {
			danglingEdgesDropped += hits;
			writes.set(file.path, rewritten);
		}
		resultNodes.push(rewritten);
	}

	// --- Verify invariants in memory before writing anything -- fail loudly, never half-applied.
	for (const node of resultNodes) {
		if (!isNodeType(node.type)) continue;
		for (const field of [...LIST_EDGES_BY_TYPE[node.type], ...SINGULAR_EDGES_BY_TYPE[node.type]]) {
			const value = node[field];
			const edges = Array.isArray(value) ? value : value ? [value] : [];
			for (const edge of edges) {
				if (isRecord(edge) && edge.slug === TARGET_SLUG) {
					errors.push(`dangling edge: ${String(node.slug)}.${field} still points to ${TARGET_SLUG}`);
				}
			}
		}
	}

	// A truncated/corrupted pending-reverses.json must fail here, before any write -- not after
	// the target is gone. Shape-checked, not just JSON.parse'd: a syntactically valid file whose
	// value isn't the expected slug -> PendingReverse[] map must land in `errors` too, rather
	// than throwing out of dropPendingReversesForSlug's own list.filter uncaught.
	const pendingPath = join(cacheDir, "pending-reverses.json");
	let pendingParsed: Record<string, PendingReverse[]> = {};
	try {
		const parsed = JSON.parse(await readTextOrDefault(pendingPath, "{}")) as unknown;
		if (!isRecord(parsed) || !Object.values(parsed).every((v) => Array.isArray(v))) {
			throw new Error("expected a JSON object mapping each slug to an array of pending reverses");
		}
		pendingParsed = parsed as Record<string, PendingReverse[]>;
	} catch (e) {
		errors.push(`pending-reverses.json is invalid: ${e instanceof Error ? e.message : String(e)}`);
	}
	const { result: nextPending, changed: pendingChanged } = dropPendingReversesForSlug(
		pendingParsed,
		TARGET_SLUG,
	);

	const report = formatRemovalReport({
		targetSlug: TARGET_SLUG,
		alreadyRemoved: false,
		danglingEdgesDropped,
		pendingReversesChanged: pendingChanged,
		dryRun: !apply,
	});

	if (errors.length > 0) {
		for (const err of errors) process.stderr.write(`error: ${err}\n`);
		return { report, deletedCount: 0, exitCode: 1 };
	}

	if (!apply) return { report, deletedCount: 0, exitCode: 0 };

	// --- Apply, crash-safe order: rewrite nodes, then pending-reverses, THEN delete the target
	// last -- the target briefly still on disk after every dangling edge to it is already gone
	// is harmless; deleting it first and crashing before the rewrites land would leave dangling
	// edges to a node that no longer exists, with no trace of the in-progress cleanup.
	for (const [path, node] of writes) await atomicWriteJson(path, node);
	if (pendingChanged) await atomicWriteJson(pendingPath, nextPending);
	await rm(target.path);

	return { report, deletedCount: 1, exitCode: 0 };
}

// --- CLI ---

async function main(): Promise<void> {
	// Reuses the merge script's parseCliArgs as-is (same `<cache-dir> [--apply] [--redirects
	// <path>]` shape) rather than recopying it -- this migration has no use for `--redirects`
	// and simply ignores it if passed.
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write("usage: 2026-09-18-remove-track-incubus.ts <cache-dir> [--apply]\n");
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const result = await runMigration(args.cacheDir, args.apply);
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
