/**
 * Backfill the `qid` field onto every genre edge and genre node already in the cache.
 *
 * Background: since TRA-18, nodes materialized from now on carry a Wikidata `qid` on
 * their genre edges and on genre nodes themselves, resolved via the genre-identity
 * resolver (TRA-11/TRA-17). The corpus already on disk predates that change and has
 * none. This migration closes that gap offline: no LLM call, no network request,
 * everything resolves from the committed data/genre-catalog.json, data/genre-qid-map.json
 * and data/genre-aliases.json tables (TRA-20's planBackfill/formatReport below, untouched
 * here).
 *
 * This file adds (TRA-21): the CLI entry point, real disk I/O (reading node files
 * directly, writing via atomicWriteJson, never through NodeCache.write which would also
 * rewrite the shared pending-reverses.json for every node touched), and the invariant
 * checks the migration verifies on itself: pending-reverses.json stays byte-identical,
 * the node file count is unchanged, and any node that fails to reparse via
 * nodePayloadSchema before being written is skipped (signaled, left intact) rather than
 * aborting the whole run.
 *
 * Usage: tsx scripts/migrations/2026-09-04-backfill-genre-qid.ts <cache-dir> [--apply]
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, NodeCache } from "../../src/cache.js";
import { type GenreMatchStrategy, type GenreResolver, loadGenreResolver } from "../../src/genre-identity.js";
import {
	EDGE_TARGET_TYPES_BY_TYPE,
	LIST_EDGES_BY_TYPE,
	NODE_TYPES,
	type NodeType,
	SINGULAR_EDGES_BY_TYPE,
} from "../../src/node-spec.js";
import { nodePayloadSchema } from "../../src/schemas.js";
import { parseSlug } from "../../src/slug.js";

export interface BackfillStats {
	nodeFilesScanned: number;
	genreEdgeOccurrences: number;
	alreadyStamped: number;
	newlyResolved: number;
	unresolvedEdges: number;
	conflictEdges: number;
	genreNodesTotal: number;
	genreNodesStamped: number;
	genreNodesUnresolved: number;
	strategyCounts: Record<GenreMatchStrategy, number>;
}

export interface BackfillPlan {
	/** Absolute file path -> the node object to write. Only files that actually change. */
	writes: Map<string, unknown>;
	stats: BackfillStats;
	unresolved: { name: string; count: number }[];
	conflicts: { slug: string; field: string; name: string; existing: string; resolved: string }[];
}

type EdgeOutcome =
	| { status: "already" }
	| { status: "resolved"; edge: Record<string, unknown>; via: GenreMatchStrategy }
	| { status: "conflict"; existing: string; resolved: string }
	| { status: "unresolved" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

function isEdgeLike(value: unknown): value is Record<string, unknown> & { name: string } {
	return isRecord(value) && typeof value.name === "string";
}

/** Genre-target edge fields for a node type, list and singular alike — never hardcoded. */
function genreEdgeFieldsFor(type: NodeType): { field: string; cardinality: "list" | "single" }[] {
	const targets = EDGE_TARGET_TYPES_BY_TYPE[type];
	const fields: { field: string; cardinality: "list" | "single" }[] = [];
	for (const field of LIST_EDGES_BY_TYPE[type]) {
		if (targets[field]?.includes("genre")) fields.push({ field, cardinality: "list" });
	}
	for (const field of SINGULAR_EDGES_BY_TYPE[type]) {
		if (targets[field]?.includes("genre")) fields.push({ field, cardinality: "single" });
	}
	return fields;
}

function resolveEdge(edge: Record<string, unknown> & { name: string }, resolver: GenreResolver): EdgeOutcome {
	const identity = resolver.resolve({ name: edge.name });
	if (!identity) return { status: "unresolved" };
	const existingQid = edge.qid;
	if (typeof existingQid === "string") {
		return existingQid === identity.qid
			? { status: "already" }
			: { status: "conflict", existing: existingQid, resolved: identity.qid };
	}
	// Spread first, qid last: JSON.stringify serializes in insertion order, and the qid must
	// land after slug/type/name (and any mbid/year/releaseType already present) for a minimal diff.
	return { status: "resolved", edge: { ...edge, qid: identity.qid }, via: identity.via };
}

function recordOutcome(
	outcome: EdgeOutcome,
	slug: string,
	field: string,
	name: string,
	stats: BackfillStats,
	conflicts: BackfillPlan["conflicts"],
	unresolvedCounts: Map<string, number>,
): void {
	switch (outcome.status) {
		case "already":
			stats.alreadyStamped++;
			return;
		case "resolved":
			stats.newlyResolved++;
			stats.strategyCounts[outcome.via]++;
			return;
		case "conflict":
			stats.conflictEdges++;
			conflicts.push({ slug, field, name, existing: outcome.existing, resolved: outcome.resolved });
			return;
		case "unresolved":
			stats.unresolvedEdges++;
			unresolvedCounts.set(name, (unresolvedCounts.get(name) ?? 0) + 1);
	}
}

/**
 * Pure planning step: given already-parsed node payloads (whatever `unknown` a caller
 * loaded, e.g. off disk in TRA-21, literal content preserved) and a resolver, decides
 * which files need writing and accumulates the report data. Does no I/O — this is what
 * makes it unit-testable.
 */
export function planBackfill(
	nodes: readonly { path: string; node: unknown }[],
	resolver: GenreResolver,
): BackfillPlan {
	const writes = new Map<string, unknown>();
	const unresolvedCounts = new Map<string, number>();
	const conflicts: BackfillPlan["conflicts"] = [];
	const stats: BackfillStats = {
		nodeFilesScanned: nodes.length,
		genreEdgeOccurrences: 0,
		alreadyStamped: 0,
		newlyResolved: 0,
		unresolvedEdges: 0,
		conflictEdges: 0,
		genreNodesTotal: 0,
		genreNodesStamped: 0,
		genreNodesUnresolved: 0,
		strategyCounts: { mbid: 0, name: 0, alias: 0, heuristic: 0 },
	};

	for (const { path, node } of nodes) {
		if (!isRecord(node) || !isNodeType(node.type)) continue;
		const type = node.type;
		const slug = typeof node.slug === "string" ? node.slug : "";
		const nextNode: Record<string, unknown> = { ...node };
		let mutated = false;

		for (const { field, cardinality } of genreEdgeFieldsFor(type)) {
			if (cardinality === "list") {
				const list = node[field];
				if (!Array.isArray(list)) continue;
				let fieldMutated = false;
				const nextList = list.map((raw: unknown) => {
					if (!isEdgeLike(raw)) return raw;
					stats.genreEdgeOccurrences++;
					const outcome = resolveEdge(raw, resolver);
					recordOutcome(outcome, slug, field, raw.name, stats, conflicts, unresolvedCounts);
					if (outcome.status === "resolved") {
						fieldMutated = true;
						return outcome.edge;
					}
					return raw;
				});
				if (fieldMutated) {
					nextNode[field] = nextList;
					mutated = true;
				}
			} else {
				const single = node[field];
				if (!isEdgeLike(single)) continue;
				stats.genreEdgeOccurrences++;
				const outcome = resolveEdge(single, resolver);
				recordOutcome(outcome, slug, field, single.name, stats, conflicts, unresolvedCounts);
				if (outcome.status === "resolved") {
					nextNode[field] = outcome.edge;
					mutated = true;
				}
			}
		}

		if (type === "genre") {
			stats.genreNodesTotal++;
			const name = typeof node.name === "string" ? node.name : "";
			let identity = resolver.resolve({ name });
			if (!identity && typeof node.slug === "string") {
				const body = node.slug.split(":")[1];
				if (body) identity = resolver.resolve({ name: body });
			}
			const existingQid = node.qid;
			if (identity) {
				if (typeof existingQid === "string" && existingQid !== identity.qid) {
					conflicts.push({ slug, field: "qid", name, existing: existingQid, resolved: identity.qid });
					stats.genreNodesUnresolved++;
				} else {
					stats.genreNodesStamped++;
					if (existingQid !== identity.qid) {
						nextNode.qid = identity.qid;
						mutated = true;
						stats.strategyCounts[identity.via]++;
					}
				}
			} else {
				stats.genreNodesUnresolved++;
				// A genre node's own name feeds the same curation queue as unresolved edges:
				// it's exactly the kind of name a future alias entry should cover.
				unresolvedCounts.set(name, (unresolvedCounts.get(name) ?? 0) + 1);
			}
		}

		if (mutated) writes.set(path, nextNode);
	}

	const unresolved = [...unresolvedCounts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	return { writes, stats, unresolved, conflicts };
}

/** Style: `=== Section ===` / padEnd / toFixed(1), per scripts/analyze-coverage.ts. */
export function formatReport(plan: BackfillPlan, dryRun: boolean): string {
	const { stats, unresolved, conflicts } = plan;
	const pct = (n: number, total: number): string => (total === 0 ? "0.0" : ((n / total) * 100).toFixed(1));

	const lines: string[] = [];
	lines.push(`=== Genre QID backfill${dryRun ? " (DRY RUN)" : ""} ===`);
	lines.push(`${"Node files scanned:".padEnd(27)}${stats.nodeFilesScanned}`);
	lines.push(`${"Genre edge occurrences:".padEnd(27)}${stats.genreEdgeOccurrences}`);
	lines.push(`${"  already stamped:".padEnd(27)}${stats.alreadyStamped}`);
	lines.push(
		`${"  newly resolved:".padEnd(27)}${stats.newlyResolved}  (${pct(stats.newlyResolved, stats.genreEdgeOccurrences)}%)`,
	);
	lines.push(
		`${"  unresolved:".padEnd(27)}${stats.unresolvedEdges}  (${pct(stats.unresolvedEdges, stats.genreEdgeOccurrences)}%)`,
	);
	lines.push(`${"  conflicts (kept as-is):".padEnd(27)}${stats.conflictEdges}`);
	lines.push(`${"Genre nodes:".padEnd(27)}${stats.genreNodesTotal}`);
	lines.push(`${"  stamped:".padEnd(27)}${stats.genreNodesStamped}`);
	lines.push(`${"  unresolved:".padEnd(27)}${stats.genreNodesUnresolved}`);

	lines.push("", "=== Resolution strategy ===");
	for (const strategy of ["mbid", "name", "alias", "heuristic"] as const) {
		lines.push(`  ${strategy.padEnd(10)} ${stats.strategyCounts[strategy]}`);
	}

	lines.push("", "=== Unresolved genres by frequency ===");
	if (unresolved.length === 0) {
		lines.push("  (none)");
	} else {
		for (const { name, count } of unresolved) {
			lines.push(`  ${String(count).padStart(3)}  ${name}`);
		}
	}

	lines.push("", "=== Conflicts ===");
	if (conflicts.length === 0) {
		lines.push("  (none)");
	} else {
		for (const c of conflicts) {
			lines.push(`  ${c.slug}  ${c.field}  ${c.name}  existing=${c.existing}  resolved=${c.resolved}`);
		}
	}

	return lines.join("\n");
}

// --- Disk I/O (TRA-21): kept separate from planBackfill so the planning logic stays pure ---

export interface CacheNodeFile {
	path: string;
	node: unknown;
}

export interface UnreadableNodeFile {
	path: string;
	error: string;
}

/**
 * Reads every node file under `<root>/nodes/<type>/*.json` directly (readFile +
 * JSON.parse), never through NodeCache.get -- that parses via Zod and strips undeclared
 * fields, which would lose the literal on-disk content this migration must preserve.
 * Enumerated via NodeCache.listSlugs() so the on-disk layout stays defined in one place
 * (src/cache.ts). A file that isn't valid JSON is reported in `invalid` and excluded from
 * `nodes`; the migration continues for everything else.
 */
export async function readCacheNodes(
	root: string,
): Promise<{ nodes: CacheNodeFile[]; invalid: UnreadableNodeFile[] }> {
	const slugs = [...(await new NodeCache(root).listSlugs())].sort();
	const nodes: CacheNodeFile[] = [];
	const invalid: UnreadableNodeFile[] = [];
	for (const slug of slugs) {
		try {
			const { type, body } = parseSlug(slug);
			const path = join(root, "nodes", type, `${body}.json`);
			const raw = await readFile(path, "utf8");
			nodes.push({ path, node: JSON.parse(raw) as unknown });
		} catch (e) {
			// parseSlug throws for a stray non-type directory under nodes/ (e.g. a leftover
			// tmp/ or bak/ folder) -- reported the same way as an unreadable file, never left
			// to propagate uncaught, matching this function's own contract above.
			invalid.push({ path: join(root, "nodes", slug), error: e instanceof Error ? e.message : String(e) });
		}
	}
	return { nodes, invalid };
}

async function fingerprintFile(path: string): Promise<string | null> {
	try {
		return createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

export interface MigrationResult {
	plan: BackfillPlan;
	report: string;
	/** Files planBackfill wanted to rewrite but were skipped because they failed to reparse. */
	skippedWrites: { path: string; error: string }[];
	/** 0 = success (including a clean dry-run); 1 = an invariant broke. */
	exitCode: 0 | 1;
}

/**
 * Runs the full migration against `cacheDir`: plans, and -- only with `apply` -- writes,
 * then verifies the invariants. Exit-code semantics only; never calls process.exit itself,
 * so it's directly callable from tests. `resolver` is injectable for tests; production
 * code relies on the default (the real committed genre tables via loadGenreResolver).
 */
export async function runMigration(
	cacheDir: string,
	apply: boolean,
	resolver?: GenreResolver,
): Promise<MigrationResult> {
	const pendingReversesPath = join(cacheDir, "pending-reverses.json");
	const beforeFingerprint = await fingerprintFile(pendingReversesPath);

	const { nodes, invalid: unreadable } = await readCacheNodes(cacheDir);
	for (const { path, error } of unreadable) {
		process.stderr.write(`warning: skipping unreadable node file ${path}: ${error}\n`);
	}

	const plan = planBackfill(nodes, resolver ?? (await loadGenreResolver()));

	if (!apply) {
		return { plan, report: formatReport(plan, true), skippedWrites: [], exitCode: 0 };
	}

	const skippedWrites: { path: string; error: string }[] = [];
	for (const [path, node] of plan.writes) {
		// Reparse before every write -- a node that doesn't parse is signaled and left
		// intact, it must not fail the migration for every other file.
		const reparsed = nodePayloadSchema.safeParse(node);
		if (!reparsed.success) {
			process.stderr.write(`warning: refusing to write invalid node at ${path}: ${reparsed.error.message}\n`);
			skippedWrites.push({ path, error: reparsed.error.message });
			continue;
		}
		await atomicWriteJson(path, node);
	}

	const afterFingerprint = await fingerprintFile(pendingReversesPath);
	if (beforeFingerprint !== afterFingerprint) {
		process.stderr.write(
			`error: pending-reverses.json changed during migration -- before=${beforeFingerprint ?? "(absent)"} after=${afterFingerprint ?? "(absent)"}\n`,
		);
		return { plan, report: formatReport(plan, false), skippedWrites, exitCode: 1 };
	}

	const beforeCount = nodes.length + unreadable.length;
	const { nodes: afterNodes, invalid: afterUnreadable } = await readCacheNodes(cacheDir);
	const afterCount = afterNodes.length + afterUnreadable.length;
	if (afterCount !== beforeCount) {
		process.stderr.write(
			`error: node file count changed during migration -- before=${beforeCount} after=${afterCount}\n`,
		);
		return { plan, report: formatReport(plan, false), skippedWrites, exitCode: 1 };
	}

	return { plan, report: formatReport(plan, false), skippedWrites, exitCode: 0 };
}

export interface CliArgs {
	cacheDir: string;
	apply: boolean;
}

/**
 * Parses `<cache-dir> [--apply]` from argv (excluding the node/script entries). Returns
 * null when the mandatory positional cache-dir is missing OR a flag was passed in its
 * place (e.g. running with only `--apply`, forgetting the positional arg) -- accepting a
 * flag there would silently migrate a nonexistent directory named after the flag, print an
 * all-zero report, and exit 0 instead of failing loudly.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
	const cacheDir = argv[0];
	if (!cacheDir || cacheDir.startsWith("-")) return null;
	return { cacheDir, apply: argv.includes("--apply") };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write("usage: 2026-09-04-backfill-genre-qid.ts <cache-dir> [--apply]\n");
		process.exit(2);
	}
	const result = await runMigration(args.cacheDir, args.apply);
	console.log(result.report);
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	// Guarded like scripts/build-genre-qid-map.ts, so importing this module from a test
	// doesn't trigger the migration.
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
