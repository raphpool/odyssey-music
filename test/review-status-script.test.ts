import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(".codex/scripts/publish-review-status.sh");
const sha = "0123456789012345678901234567890123456789";
const baseEnv = {
	...process.env,
	CODEX_REVIEW_DRY_RUN: "1",
	CODEX_REVIEW_REPO: "raphpool/odyssey-music",
};

function runWithActions(status: string, conclusion = "failure", runSha = sha) {
	const directory = mkdtempSync(join(tmpdir(), "review-status-"));
	const gh = join(directory, "gh");
	const calls = join(directory, "calls");
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$*" in
  *"repo view"*) printf 'raphpool/odyssey-music\\n' ;;
  *headRefOid*) printf '%s\\n' "$TEST_SHA" ;;
  *"json url"*) printf 'https://github.com/raphpool/odyssey-music/pull/53\\n' ;;
  *"run list"*) printf '123\\t%s\\t%s\\t%s\\n' "$TEST_RUN_STATUS" "$TEST_RUN_CONCLUSION" "$TEST_RUN_SHA" ;;
esac
`,
	);
	chmodSync(gh, 0o755);
	try {
		const result = spawnSync("bash", [script, "53", "pass", sha], {
			encoding: "utf8",
			env: {
				...baseEnv,
				CODEX_REVIEW_DRY_RUN: "0",
				PATH: `${directory}:${process.env.PATH ?? ""}`,
				TEST_CALLS: calls,
				TEST_SHA: sha,
				TEST_RUN_STATUS: status,
				TEST_RUN_CONCLUSION: conclusion,
				TEST_RUN_SHA: runSha,
			},
		});
		return { result, calls: readFileSync(calls, "utf8") };
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

describe("publish-review-status", () => {
	it.each([
		["pending", "pending"],
		["pass", "success"],
		["block", "failure"],
	])("maps %s to %s", (verdict, state) => {
		const output = execFileSync("bash", [script, "53", verdict, sha], {
			encoding: "utf8",
			env: baseEnv,
		});
		expect(output).toContain(`state=${state}`);
		expect(output).toContain("context=codex-review");
		expect(output).toContain(`sha=${sha}`);
	});

	it("refuses a verdict after the PR head changes", () => {
		const result = spawnSync("bash", [script, "53", "pass", sha], {
			encoding: "utf8",
			env: { ...baseEnv, CODEX_REVIEW_CURRENT_SHA: "different" },
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("pas sur le SHA reviewé");
	});

	it.each([
		["completed", "failure", sha, true],
		["completed", "success", sha, false],
		["queued", "failure", sha, false],
		["in_progress", "failure", sha, false],
		["completed", "failure", "different", false],
	] as const)(
		"reruns only a completed failing gate on the reviewed SHA",
		(status, conclusion, runSha, rerun) => {
			const { result, calls } = runWithActions(status, conclusion, runSha);
			expect(result.status).toBe(0);
			expect(calls).toContain(`run list --commit ${sha} --event pull_request`);
			expect(calls.includes("run rerun 123")).toBe(rerun);
		},
	);
});
