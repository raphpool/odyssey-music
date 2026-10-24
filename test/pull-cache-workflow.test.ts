import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural assertions on .github/workflows/pull-cache.yml (TRA-493), by text slicing like
// test/sync-genre-cache-workflow.test.ts: no YAML parser. The behavior of the scripts it calls is covered
// by test/pull-cache-script.test.ts and test/pull-cache-pr-script.test.ts; this file tests the wiring.

const REPO_ROOT = join(__dirname, "..");
const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/pull-cache.yml"), "utf8");
const deploy = readFileSync(join(REPO_ROOT, ".github/workflows/deploy.yml"), "utf8");
const prScript = readFileSync(join(REPO_ROOT, "scripts/ci/pull-cache-pr.sh"), "utf8");
const pullScript = readFileSync(join(REPO_ROOT, "deploy/pull-cache.sh"), "utf8");

const steps = workflow.split(/\n {6}- /).slice(1);
const step = (start: string): string => {
	const found = steps.find((s) => s.startsWith(start));
	if (!found) throw new Error(`step "${start}" not found`);
	return found;
};

describe("pull-cache workflow", () => {
	it("is workflow_dispatch only, with one boolean input `apply` defaulting to false", () => {
		const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\nconcurrency:"));
		expect(on).toMatch(/workflow_dispatch:/);
		for (const trigger of ["push", "schedule", "pull_request", "pull_request_target", "workflow_run"]) {
			expect(on).not.toMatch(new RegExp(`\\b${trigger}:`));
		}
		expect([...on.matchAll(/^ {6}(\w+):$/gm)].map((m) => m[1])).toEqual(["apply"]);
		const apply = on.slice(on.indexOf("apply:"));
		expect(apply).toMatch(/type: boolean/);
		expect(apply).toMatch(/default: false/);
	});

	it("runs on the Linux runners, not the Mac", () => {
		expect(workflow).toMatch(/runs-on: \[self-hosted, linux\]/);
		expect(workflow).not.toMatch(/macOS|ARM64/);
	});

	it("authenticates with the deploy key held by a job-scoped ssh-agent, never written to disk", () => {
		const ssh = step("name: Set up SSH");
		expect(ssh).toMatch(/DEPLOY_SSH_KEY: \$\{\{ secrets\.DEPLOY_SSH_KEY \}\}/);
		expect(ssh).toMatch(/ssh-agent -s/);
		expect(ssh).toMatch(/ssh-add -/);
		expect(workflow).not.toMatch(/~\/\.ssh|id_ed25519|>\s*"?\$HOME\/\.ssh/);
		// The same host pinning as the other prod-touching workflows.
		const deployHost = /ssh-keyscan -H (\S+)/.exec(deploy)?.[1];
		expect(deployHost).toBeDefined();
		expect(ssh).toContain(`ssh-keyscan -H ${deployHost}`);
		expect(workflow).not.toMatch(/(secrets\.(?!DEPLOY_SSH_KEY|GITHUB_TOKEN))/);
	});

	it("shares deploy-prod's concurrency group, so it never reads while a cache transfer runs", () => {
		expect(workflow).toMatch(/concurrency:\n {2}group: deploy-prod\n {2}cancel-in-progress: false/);
	});

	it("lets no input steer the transfer: the script runs with its own defaults", () => {
		expect(workflow).not.toMatch(/\bSERVER[A-Z_]*:|SERVER=|REPO_CACHE_DIR|PULL_THRESHOLDS_PATH/);
		const pull = step("name: Pull and validate prod nodes");
		expect(pull).toContain("bash deploy/pull-cache.sh");
		expect(pull).toMatch(/if \[ "\$APPLY" = "true" \]; then ARGS\+=\(--apply\); fi/);
		// An input is only ever read through `if:` and `env:`, never interpolated into a run: script.
		for (const line of workflow.split("\n").filter((l) => l.includes("inputs."))) {
			expect(line.trim()).toMatch(
				/^(if: \$\{\{ .*inputs\.apply.* \}\}|APPLY: \$\{\{ inputs\.apply \}\})$|^description:/,
			);
		}
	});

	it("previews by default: the PR step, and only that one, is gated on `apply`", () => {
		const pr = step("name: Open the draft PR");
		expect(pr).toMatch(/if: \$\{\{ inputs\.apply \}\}/);
		expect(pr).toContain("bash scripts/ci/pull-cache-pr.sh");
		expect(pr).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
		expect(step("name: Pull and validate prod nodes")).not.toContain("if:");
	});

	it("only applies from main, the base of the PR it opens", () => {
		const guard = step("name: Require main to apply");
		expect(guard).toContain("inputs.apply && github.ref != 'refs/heads/main'");
		expect(guard).toContain("exit 1");
		// The guard runs before anything is checked out or pulled.
		expect(workflow.indexOf("Require main to apply")).toBeLessThan(workflow.indexOf("actions/checkout"));
	});

	it("checks out without persisting credentials, and the token is given to the push alone", () => {
		expect(step("uses: actions/checkout")).toContain("persist-credentials: false");
		expect(prScript).toMatch(/git push "\$REMOTE" "\$BRANCH"/);
		expect(prScript).toContain("x-access-token:");
	});

	it("opens a DRAFT PR and never marks it ready, merges it or forces the push", () => {
		expect(prScript).toMatch(/gh pr create --draft --base "\$BASE"/);
		expect(prScript).not.toMatch(/gh pr (ready|merge)|--auto|--force|push -f|--admin/);
		expect(workflow).not.toMatch(/gh pr (ready|merge)|--auto|--admin/);
		expect(workflow).toMatch(/\n {4}permissions:\n {6}contents: write\n {6}pull-requests: write/);
		expect(workflow).toMatch(/^permissions:\n {2}contents: read/m);
	});

	it("is read-only on the server, and pulls nodes/ only: the pull script has no write path to it", () => {
		const code = pullScript
			.split("\n")
			.filter((l) => !l.trim().startsWith("#"))
			.join("\n");
		expect(code).not.toMatch(/\bssh\s/);
		expect(code).not.toMatch(/--delete|--remove-source-files|--ignore-existing/);
		// One rsync, server -> local scratch, nodes/ on both sides: the git-ignored sidecars never come back.
		const rsyncs = code.split("\n").filter((l) => /^\s*rsync\b/.test(l));
		expect(rsyncs).toEqual([
			'rsync -az --no-links "$SERVER:$SERVER_CACHE_REMOTE/nodes/" "$SCRATCH/pulled/nodes/"',
		]);
	});
});
