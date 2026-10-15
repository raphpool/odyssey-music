import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyRisk, sensitivePath } from "../scripts/ci/review-gate-policy.js";

// TRA-461: the `integrity` job of ci.yml runs the cache audit and, on pull requests, the threshold ratchet.
// Like native-ci-triggers.test.ts, no YAML parser is added: the job block is read as text.
const source = readFileSync(".github/workflows/ci.yml", "utf8")
	.replaceAll("\r\n", "\n")
	.split("\n")
	.filter((line) => !/^\s*#/.test(line))
	.join("\n");

/** Returns a job's text, from its key up to the next top-level job key. */
function jobBlock(name: string): string {
	const start = source.indexOf(`\n  ${name}:\n`);
	if (start === -1) throw new Error(`job ${name} not found in ci.yml`);
	const rest = source.slice(start + 1);
	const next = rest.slice(1).search(/^ {2}[a-z][\w-]*:\s*$/m);
	return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The shell scripts of every `run:` of a text: inline values and the lines of `|` / `>` block scalars. */
function runScripts(text: string): string[] {
	const lines = text.split("\n");
	const scripts: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match = /^(\s*)(- )?run:\s*(.*)$/.exec(lines[i] as string);
		if (!match) continue;
		const keyIndent = (match[1] as string).length + (match[2] === undefined ? 0 : 2);
		const inline = match[3] as string;
		if (!/^[|>][+-]?$/.test(inline)) {
			scripts.push(inline);
			continue;
		}
		const body: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] as string;
			if (line.trim() !== "" && line.length - line.trimStart().length <= keyIndent) break;
			body.push(line);
		}
		scripts.push(body.join("\n"));
	}
	return scripts;
}

describe("ci.yml integrity job (TRA-461, TRA-498)", () => {
	const block = jobBlock("integrity");

	it("runs the audit script directly on the cache directory, not through a package.json script", () => {
		// package.json is not a sensitive path: a tier/1 PR could redefine `audit:cache` to neutralize the job.
		expect(block).toContain("npx --no-install tsx scripts/audit-cache.ts cache");
		expect(block).not.toContain("npm run");
	});

	it("runs the threshold ratchet against the first parent of the merge ref, on pull requests only", () => {
		expect(block).toContain("fetch-depth: 2");
		expect(block).toContain("BASE=HEAD^1");
		expect(block).toContain('scripts/ci/threshold-ratchet.ts "$BASE"');
		const ratchetStep = block.slice(block.lastIndexOf("- name:", block.indexOf("threshold-ratchet")));
		expect(ratchetStep).toContain("if: ${{ !cancelled() && github.event_name == 'pull_request' }}");
		// The base is the commit already checked out, never a branch fetched after the event.
		expect(block).not.toContain("git fetch");
		expect(block).not.toContain("origin/");
	});

	it("appends the audit output, violations included, to the job summary", () => {
		const auditStep = block.slice(
			block.indexOf("- name: Auditer le cache"),
			block.indexOf("- name: Cliquet"),
		);
		expect(auditStep).toContain("2>");
		expect(auditStep).toContain('>> "$GITHUB_STEP_SUMMARY"');
		expect(auditStep).toContain('exit "$status"');
	});

	it("uses the same runner labels and HOME isolation as the other jobs", () => {
		expect(block).toMatch(/^ {4}runs-on: \[self-hosted, macOS, ARM64\]\s*$/m);
		expect(block).toContain('echo "HOME=$RUNNER_TEMP/home" >> "$GITHUB_ENV"');
	});

	it("skips draft pull requests like the other jobs", () => {
		expect(block).toContain(
			"github.event_name != 'pull_request' || github.event.pull_request.draft == false",
		);
	});

	it("adds no timeout-minutes to the integrity job, consistently with the other jobs", () => {
		expect(block).not.toContain("timeout-minutes");
	});

	it("never reads the generated web/data.json", () => {
		expect(block).not.toContain("web/data.json");
	});
});

describe("ci.yml shell scripts (TRA-498)", () => {
	it("never interpolate the PR base ref into a run: script, which is a shell injection vector", () => {
		const scripts = runScripts(source);
		expect(scripts.length).toBeGreaterThan(5);
		for (const script of scripts) expect(script).not.toContain("github.event.pull_request.base.ref");
	});

	it.each(["diff-size", "tier-guard"])("passes the base ref to %s through env BASE_REF", (job) => {
		const block = jobBlock(job);
		expect(block).toContain('BASE_REF: "${{ github.event.pull_request.base.ref }}"');
		expect(block).toContain('git fetch origin "$BASE_REF"');
	});
});

describe("tier-guard sensitive paths (TRA-498)", () => {
	// The grep of the job and `sensitivePath` of review-gate-policy.ts are two copies of one list.
	const grep = /grep -Eq '([^']+)'/.exec(jobBlock("tier-guard"))?.[1] as string;
	const gate = (path: string) => classifyRisk([path], []) === 3;
	const grepMatches = (path: string) => spawnSync("grep", ["-Eq", grep], { input: `${path}\n` }).status === 0;

	// One path per alternative of the pattern (and a nested variant), then neighbours that must not escalate.
	const sensitive = [
		"auth/login.ts",
		"src/auth/login.ts",
		"payment/a.ts",
		"src/payments/a.ts",
		"scripts/migrations/001.ts",
		"infra/main.tf",
		"deploy/deploy-server.sh",
		"x/deploy/y.sh",
		".github/workflows/ci.yml",
		".github/pull_request_template.md",
		"scripts/deploy-web.sh",
		"scripts/ci/review-gate-policy.ts",
		"scripts/ci/review-reuse.ts",
		"scripts/ci/threshold-ratchet.ts",
		"scripts/audit-cache.ts",
		"data/integrity-thresholds.json",
		".codex/scripts/publish-review-status.sh",
		"db/schema.sql",
		"config/secrets.json",
	];
	const ordinary = [
		"src/author/a.ts",
		"src/authz/a.ts",
		"src/payments.ts",
		"docs/.github/x.md",
		".githubx/a.yml",
		"scripts/deployer.ts",
		"scripts/audit-cache-notes.md",
		"scripts/audit-cache.ts.bak",
		"scripts/ci/threshold-ratchet.ts.bak",
		"scripts/ci/threshold-ratchet.test.ts",
		"scripts/ci/pr-policy.ts",
		"data/integrity-thresholds.json.bak",
		"data/genre-catalog.json",
		".codex/scripts/other.sh",
		".codex/scripts/publish-review-status.sh.bak",
		"db/schema.sqlx",
		"src/graph.ts",
	];

	it("is the sensitivePath pattern of the review gate, text for text", () => {
		expect(grep).toBeDefined();
		expect(grep).toBe(sensitivePath.source.replaceAll("\\/", "/"));
	});

	it.each(sensitive)("escalates %s in the workflow grep and in the review gate policy", (path) => {
		expect(grepMatches(path), `grep: ${path}`).toBe(true);
		expect(gate(path), `policy: ${path}`).toBe(true);
	});

	it.each(ordinary)("does not escalate %s in either copy", (path) => {
		expect(grepMatches(path), `grep: ${path}`).toBe(false);
		expect(gate(path), `policy: ${path}`).toBe(false);
	});
});
