/**
 * Pure planning/reporting logic for backfilling the `qid` field onto every genre edge
 * and genre node already in the cache.
 *
 * Background: since TRA-18, nodes materialized from now on carry a Wikidata `qid` on
 * their genre edges and on genre nodes themselves, resolved via the genre-identity
 * resolver (TRA-11/TRA-17). The corpus already on disk predates that change and has
 * none. This migration will close that gap offline: no LLM call, no network request,
 * everything resolves from the committed data/genre-catalog.json, data/genre-qid-map.json
 * and data/genre-aliases.json tables.
 *
 * This file holds only the pure planning step and its report formatter — no CLI, no
 * disk I/O. Reading the cache, writing via atomicWriteJson, and the invariant checks
 * (pending-reverses.json byte-identical, idempotence) land in TRA-21, in this same file.
 */
import type { GenreMatchStrategy, GenreResolver } from "../../src/genre-identity.js";
import {
	EDGE_TARGET_TYPES_BY_TYPE,
	LIST_EDGES_BY_TYPE,
	NODE_TYPES,
	type NodeType,
	SINGULAR_EDGES_BY_TYPE,
} from "../../src/node-spec.js";

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
