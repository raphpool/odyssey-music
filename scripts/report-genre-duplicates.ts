/**
 * Report genre nodes that share a Wikidata QID.
 *
 * Every genre node has carried a `qid` since TRA-12/TRA-13 backfilled it. Two genre nodes
 * with the same `qid` are the same real-world genre materialized twice (e.g. "Electronic"
 * and "Electronic music") — the corpus splits that genre's content across both, and the
 * user only ever sees whichever half they clicked into.
 *
 * This script only looks: it reads the cache and prints a report. It never writes, merges,
 * or deletes anything — that's the follow-up ticket, once a human has read this output.
 *
 * Usage: report-genre-duplicates.ts <cache-dir>
 */
import { pathToFileURL } from "node:url";
import { NodeCache } from "../src/cache.js";
import type { NodePayload, NodeType } from "../src/types.js";
import { LIST_EDGES_BY_TYPE, NODE_TYPES, SINGULAR_EDGES_BY_TYPE } from "../src/types.js";

export interface GenreNodeUsage {
	slug: string;
	name: string;
	qid?: string;
	usages: number;
}

export interface DuplicateGroup {
	qid: string;
	/** Sorted by usages desc, then slug asc. */
	members: GenreNodeUsage[];
	totalUsages: number;
}

export interface DuplicateReport {
	groups: DuplicateGroup[];
	unqualified: GenreNodeUsage[];
	genreNodeCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareByUsageDescThenSlugAsc(a: GenreNodeUsage, b: GenreNodeUsage): number {
	return b.usages - a.usages || compareStrings(a.slug, b.slug);
}

/** Increment the usage counter for `value` when it is an edge ref pointing at a genre node. */
function bumpIfGenreEdge(usageBySlug: Map<string, number>, value: unknown): void {
	const edge = asRecord(value);
	if (!edge) return;
	if (edge.type !== "genre" || typeof edge.slug !== "string") return;
	usageBySlug.set(edge.slug, (usageBySlug.get(edge.slug) ?? 0) + 1);
}

/**
 * Count, for every genre slug, how many edges anywhere in the cache point at it — every
 * node type and every edge field, not just `artist.genres`. That total is what decides
 * whether a duplicate is worth merging.
 */
function countGenreUsages(nodes: readonly unknown[]): Map<string, number> {
	const usageBySlug = new Map<string, number>();
	for (const value of nodes) {
		const rec = asRecord(value);
		if (!rec || !isNodeType(rec.type)) continue;
		for (const field of LIST_EDGES_BY_TYPE[rec.type]) {
			const list = rec[field];
			if (!Array.isArray(list)) continue;
			for (const edge of list) bumpIfGenreEdge(usageBySlug, edge);
		}
		for (const field of SINGULAR_EDGES_BY_TYPE[rec.type]) {
			bumpIfGenreEdge(usageBySlug, rec[field]);
		}
	}
	return usageBySlug;
}

/**
 * Build the duplicate-detection report from a set of cache nodes. Pure and I/O-free — it
 * takes `unknown[]` rather than `NodePayload[]` so it can be exercised directly on
 * hand-built fixtures in tests without going through disk or schema validation, and so
 * `main()` stays a thin, untested wrapper around it.
 */
export function buildDuplicateReport(nodes: readonly unknown[]): DuplicateReport {
	const usageBySlug = countGenreUsages(nodes);

	const genreNodes: GenreNodeUsage[] = [];
	for (const value of nodes) {
		const rec = asRecord(value);
		if (!rec || rec.type !== "genre") continue;
		if (typeof rec.slug !== "string" || typeof rec.name !== "string") continue;
		genreNodes.push({
			slug: rec.slug,
			name: rec.name,
			...(typeof rec.qid === "string" ? { qid: rec.qid } : {}),
			usages: usageBySlug.get(rec.slug) ?? 0,
		});
	}

	// A genre node with no qid can never be part of a duplicate group — it's an
	// unresolved node from Part 3, not a confirmed duplicate.
	const byQid = new Map<string, GenreNodeUsage[]>();
	const unqualified: GenreNodeUsage[] = [];
	for (const genre of genreNodes) {
		if (genre.qid) {
			const members = byQid.get(genre.qid) ?? [];
			members.push(genre);
			byQid.set(genre.qid, members);
		} else {
			unqualified.push(genre);
		}
	}

	const groups: DuplicateGroup[] = [...byQid.entries()]
		.filter(([, members]) => members.length >= 2)
		.map(([qid, members]) => {
			const sortedMembers = [...members].sort(compareByUsageDescThenSlugAsc);
			return {
				qid,
				members: sortedMembers,
				totalUsages: sortedMembers.reduce((sum, m) => sum + m.usages, 0),
			};
		})
		.sort((a, b) => b.totalUsages - a.totalUsages || compareStrings(a.qid, b.qid));

	unqualified.sort(compareByUsageDescThenSlugAsc);

	return { groups, unqualified, genreNodeCount: genreNodes.length };
}

export function formatDuplicateReport(report: DuplicateReport): string {
	const nodesInGroup = report.groups.reduce((sum, g) => sum + g.members.length, 0);
	const lines: string[] = [
		"=== Genre duplicate groups ===",
		`${"Genre nodes:".padEnd(24)}${report.genreNodeCount}`,
		`${"Groups sharing a QID:".padEnd(24)}${report.groups.length}`,
		`${"Nodes in a group:".padEnd(24)}${nodesInGroup}`,
		`${"Nodes without a QID:".padEnd(24)}${report.unqualified.length}`,
	];

	lines.push("", "=== Groups (by total usages) ===");
	if (report.groups.length === 0) {
		lines.push("  (none)");
	} else {
		for (const group of report.groups) {
			lines.push(`  ${group.qid}  ${group.members[0]?.name ?? ""}`);
			for (const member of group.members) {
				lines.push(`    ${member.slug.padEnd(28)}${String(member.usages).padStart(4)} usages`);
			}
		}
	}

	lines.push("", "=== Genre nodes without a QID ===");
	if (report.unqualified.length === 0) {
		lines.push("  (none)");
	} else {
		for (const genre of report.unqualified) {
			lines.push(`  ${String(genre.usages).padStart(4)}  ${genre.slug}  ${genre.name}`);
		}
	}

	return lines.join("\n");
}

async function main(): Promise<void> {
	const cacheDir = process.argv[2];
	if (!cacheDir) {
		process.stderr.write("usage: report-genre-duplicates.ts <cache-dir>\n");
		process.exit(2);
	}

	const cache = new NodeCache(cacheDir);
	const slugs = await cache.listSlugs();
	const nodes: NodePayload[] = [];
	for (const slug of slugs) {
		nodes.push(await cache.get(slug));
	}

	console.log(formatDuplicateReport(buildDuplicateReport(nodes)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	// Guarded (instead of the repo's usual unconditional `main().catch(...)`) so importing
	// this module from a test doesn't require a cache-dir argument or touch the filesystem.
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
