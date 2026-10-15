/**
 * CI ratchet for `data/integrity-thresholds.json` (TRA-461, plan graph-integrity decision 9).
 *
 * The audit (`scripts/audit-cache.ts`) fails when a measure exceeds its committed ceiling. That alone
 * lets a PR "fix" a failing audit by raising the ceiling, so this script compares the thresholds file
 * at HEAD with the one on the PR base and rejects any ceiling that goes up or disappears.
 * Adding a new metric or a new key under an existing metric is allowed: it only tightens the audit.
 *
 * Valve (TRA-498): a coverage ceiling (`missing-*`, `single-citation`, see `coverageNodeType`) is an absolute
 * count, so a batch that ADDS not-yet-enriched nodes raises it without any regression. Such a rise is accepted
 * when the number of nodes of the type it measures grew by at least as much between the base and HEAD.
 * Both node counts are recomputed from the `cache/` of each side (the base one extracted with `git archive`):
 * deterministic, and nothing to keep in sync in the thresholds file. Correctness metrics stay strict.
 *
 * Usage: threshold-ratchet.ts <base-ref>
 * Exit codes: 0 = ratchet respected, 1 = violation (or unreadable HEAD file / bad usage),
 * 2 = the base ref has no thresholds file (first PR after TRA-448: the workflow accepts it with a warning).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeType } from "../../src/node-spec.js";
import {
	auditNodes,
	coverageNodeType,
	type MetricValue,
	parseThresholds,
	readRawNodes,
	type Thresholds,
} from "../audit-cache.js";

export const THRESHOLDS_PATH = "data/integrity-thresholds.json";
const CACHE_PATH = "cache";

export type NodeCounts = Record<NodeType, number>;

/** `nodeCount` of the audit report on the base side and on the HEAD side. */
export interface NodeGrowth {
	base: NodeCounts;
	head: NodeCounts;
}

interface Comparison {
	violations: string[];
	/** Coverage rises accepted because nodes were added, for the job summary. */
	absorbed: string[];
}

/** How far a coverage ceiling may rise: the growth of its node type, never negative, 0 when strict. */
function allowance(metric: string, key: string | undefined, growth: NodeGrowth | undefined): number {
	const type = coverageNodeType(metric, key);
	if (type === null || growth === undefined) return 0;
	return Math.max(0, growth.head[type] - growth.base[type]);
}

function compare(base: Thresholds, head: Thresholds, growth: NodeGrowth | undefined): Comparison {
	const violations: string[] = [];
	const absorbed: string[] = [];
	const rise = (label: string, metric: string, key: string | undefined, from: number, to: number) => {
		if (to <= from) return;
		const room = allowance(metric, key, growth);
		if (to - from <= room) absorbed.push(`${label}: ${from} → ${to} (+${to - from}, ${room} node(s) added)`);
		else violations.push(`${label}: ${from} → ${to} (increase)`);
	};
	for (const [metric, baseValue] of Object.entries(base)) {
		const headValue: MetricValue | undefined = head[metric];
		if (headValue === undefined) {
			violations.push(`${metric}: removed`);
			continue;
		}
		if (typeof baseValue === "number") {
			if (typeof headValue !== "number") violations.push(`${metric}: shape changed (number → per-key)`);
			else rise(metric, metric, undefined, baseValue, headValue);
			continue;
		}
		if (typeof headValue === "number") {
			violations.push(`${metric}: shape changed (per-key → number)`);
			continue;
		}
		for (const [key, baseCeiling] of Object.entries(baseValue)) {
			const headCeiling = headValue[key];
			if (headCeiling === undefined) violations.push(`${metric}[${key}]: removed`);
			else rise(`${metric}[${key}]`, metric, key, baseCeiling, headCeiling);
		}
	}
	return { violations, absorbed };
}

/**
 * One line per violation: a ceiling that increased (beyond what `growth` explains for coverage metrics)
 * or vanished, or a metric whose shape changed. Without `growth` every rise is a violation.
 */
export function compareThresholds(base: Thresholds, head: Thresholds, growth?: NodeGrowth): string[] {
	return compare(base, head, growth).violations;
}

export interface RatchetResult {
	exitCode: 0 | 1 | 2;
	/** Markdown, also appended to the job summary by the workflow. */
	output: string;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** `nodeCount` of the audit of a cache directory; `null` when it is empty, partial or missing. */
async function countNodes(cacheDir: string): Promise<NodeCounts | null> {
	const read = await readRawNodes(cacheDir);
	if (read.invalid.length > 0 || read.nodes.size === 0) return null;
	return auditNodes(read.nodes).nodeCount;
}

/** Node counts of `base` and of the working tree of `cwd`; `null` (valve closed) when either is unavailable. */
async function nodeGrowth(base: string, cwd: string): Promise<NodeGrowth | null> {
	const scratch = mkdtempSync(join(tmpdir(), "ratchet-base-"));
	try {
		const archive = join(scratch, "cache.tar");
		try {
			git(cwd, ["archive", "--format=tar", "-o", archive, base, "--", CACHE_PATH]);
		} catch {
			return null; // no cache/ on the base
		}
		execFileSync("tar", ["-xf", archive, "-C", scratch], { stdio: ["ignore", "pipe", "pipe"] });
		const [baseCounts, headCounts] = await Promise.all([
			countNodes(join(scratch, CACHE_PATH)),
			countNodes(join(cwd, CACHE_PATH)),
		]);
		return baseCounts === null || headCounts === null ? null : { base: baseCounts, head: headCounts };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Compares HEAD's thresholds file (working tree of `cwd`) with the one at `base`. */
export async function checkRatchet(base: string, cwd: string): Promise<RatchetResult> {
	// ls-tree (not `git show`) so a missing file (exit 2) is told apart from a bad ref (throws: fail closed).
	const tracked = git(cwd, ["ls-tree", "--name-only", base, "--", THRESHOLDS_PATH]).trim();
	if (tracked === "") {
		return {
			exitCode: 2,
			output: `::warning::${THRESHOLDS_PATH} not found on ${base}: ratchet skipped (first PR after TRA-448).\n`,
		};
	}
	const baseThresholds = parseThresholds(JSON.parse(git(cwd, ["show", `${base}:${THRESHOLDS_PATH}`])));
	const headThresholds = parseThresholds(JSON.parse(readFileSync(join(cwd, THRESHOLDS_PATH), "utf8")));
	const growth = await nodeGrowth(base, cwd);
	const { violations, absorbed } = compare(baseThresholds, headThresholds, growth ?? undefined);
	const noGrowth =
		"Node counts unavailable on one side (no `cache/` nodes on the base or on HEAD): every rise is refused.";
	if (violations.length === 0) {
		const lines = ["## Integrity thresholds", ""];
		if (absorbed.length === 0) {
			lines.push("Ratchet respected: no ceiling raised or removed.");
		} else {
			lines.push(
				"Ratchet respected; coverage rises absorbed by node growth (the PR added nodes, not a regression):",
				"",
				...absorbed.map((a) => `- ${a}`),
			);
		}
		return { exitCode: 0, output: `${lines.join("\n")}\n` };
	}
	const lines = [
		"## Integrity thresholds: ratchet violated",
		"",
		`Ceilings in \`${THRESHOLDS_PATH}\` may only go down, except coverage ceilings, which may rise by the number of nodes the PR added. Fix the cache instead of raising a ceiling.`,
		"",
		...violations.map((v) => `- ${v}`),
	];
	if (growth === null) lines.push("", noGrowth);
	lines.push("", ...violations.map((v) => `::error::${v}`));
	return { exitCode: 1, output: `${lines.join("\n")}\n` };
}

/** Markdown for an unexpected failure (bad ref, unreadable file...): on stdout, so the workflow's `tee` keeps it. */
export function formatFailure(e: unknown): string {
	const message = e instanceof Error ? e.message : String(e);
	return `## Integrity thresholds: ratchet failed\n\nerror: ${message}\n\n::error::ratchet failed: ${message.split("\n")[0]}\n`;
}

const main = async (): Promise<void> => {
	const base = process.argv[2];
	if (base === undefined) {
		console.error("Usage: threshold-ratchet.ts <base-ref>");
		process.exit(1);
	}
	const result = await checkRatchet(base, process.cwd());
	process.stdout.write(result.output);
	process.exit(result.exitCode);
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	// Fail closed with exit 1 (never 2, which the workflow reads as "no thresholds file on the base").
	main().catch((e: unknown) => {
		process.stdout.write(formatFailure(e));
		process.exit(1);
	});
}
