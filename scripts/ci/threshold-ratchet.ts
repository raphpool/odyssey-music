/**
 * CI ratchet for `data/integrity-thresholds.json` (TRA-461, plan graph-integrity decision 9).
 *
 * The audit (`scripts/audit-cache.ts`) fails when a measure exceeds its committed ceiling. That alone
 * lets a PR "fix" a failing audit by raising the ceiling, so this script compares the thresholds file
 * at HEAD with the one on the PR base and rejects any ceiling that goes up or disappears.
 * Adding a new metric or a new key under an existing metric is allowed: it only tightens the audit.
 *
 * Usage: threshold-ratchet.ts <base-ref>
 * Exit codes: 0 = ratchet respected, 1 = violation (or unreadable HEAD file / bad usage),
 * 2 = the base ref has no thresholds file (first PR after TRA-448: the workflow accepts it with a warning).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseThresholds, type Thresholds } from "../audit-cache.js";

export const THRESHOLDS_PATH = "data/integrity-thresholds.json";

/** One line per violation: a ceiling that increased or vanished, or a metric whose shape changed. */
export function compareThresholds(base: Thresholds, head: Thresholds): string[] {
	const violations: string[] = [];
	for (const [metric, baseValue] of Object.entries(base)) {
		const headValue = head[metric];
		if (headValue === undefined) {
			violations.push(`${metric}: removed`);
			continue;
		}
		if (typeof baseValue === "number") {
			if (typeof headValue !== "number") violations.push(`${metric}: shape changed (number → per-key)`);
			else if (headValue > baseValue) violations.push(`${metric}: ${baseValue} → ${headValue} (increase)`);
			continue;
		}
		if (typeof headValue === "number") {
			violations.push(`${metric}: shape changed (per-key → number)`);
			continue;
		}
		for (const [key, baseCeiling] of Object.entries(baseValue)) {
			const headCeiling = headValue[key];
			if (headCeiling === undefined) violations.push(`${metric}[${key}]: removed`);
			else if (headCeiling > baseCeiling)
				violations.push(`${metric}[${key}]: ${baseCeiling} → ${headCeiling} (increase)`);
		}
	}
	return violations;
}

export interface RatchetResult {
	exitCode: 0 | 1 | 2;
	/** Markdown, also appended to the job summary by the workflow. */
	output: string;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Compares HEAD's thresholds file (working tree of `cwd`) with the one at `base`. */
export function checkRatchet(base: string, cwd: string): RatchetResult {
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
	const violations = compareThresholds(baseThresholds, headThresholds);
	if (violations.length === 0) {
		return {
			exitCode: 0,
			output: "## Integrity thresholds\n\nRatchet respected: no ceiling raised or removed.\n",
		};
	}
	const lines = [
		"## Integrity thresholds: ratchet violated",
		"",
		`Ceilings in \`${THRESHOLDS_PATH}\` may only go down. Fix the cache instead of raising a ceiling.`,
		"",
		...violations.map((v) => `- ${v}`),
		"",
		...violations.map((v) => `::error::${v}`),
	];
	return { exitCode: 1, output: `${lines.join("\n")}\n` };
}

const main = (): void => {
	const base = process.argv[2];
	if (base === undefined) {
		console.error("Usage: threshold-ratchet.ts <base-ref>");
		process.exit(1);
	}
	const result = checkRatchet(base, process.cwd());
	process.stdout.write(result.output);
	process.exit(result.exitCode);
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
