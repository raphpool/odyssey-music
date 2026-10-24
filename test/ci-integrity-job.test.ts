import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
		expect(block).toMatch(/^ {4}runs-on: \[self-hosted, linux\]\s*$/m);
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

// TRA-556: the `tier-guard` job no longer carries its own copy of `sensitivePath`. Its first step derives a
// `grep -Eqi` pattern from the literal on the default branch; its second step feeds the changed paths to it. The
// tests below run those two steps, as written in ci.yml, on throwaway repositories with a fake `gh`.

/** A GitHub Actions expression, built here so the source does not hold a literal template placeholder. */
const expr = (inner: string): string => `\${{ ${inner} }}`;

const POLICY_PATH = "scripts/ci/review-gate-policy.ts";
const REAL_POLICY = readFileSync(POLICY_PATH, "utf8");
const LOAD_STEP = "Charger les chemins sensibles de la branche par défaut";
const DETECT_STEP = "Détecter les chemins sensibles";

/**
 * The grep that the job carried before TRA-556, frozen at the commit that replaced it (it already held TRA-553:
 * `-i`, with `--no-renames` and `-z` on the diff). It is a reference for the migration only: nothing reads it at
 * run time, and it must never follow `sensitivePath`.
 */
const LEGACY_GREP = String.raw`(^|/)(auth|payment[s]?|migrations|infra|deploy)/|^\.github/|^scripts/(deploy-|ci/review-gate-policy|ci/review-reuse|ci/threshold-ratchet\.ts$|audit-cache\.ts$)|^data/integrity-thresholds\.json$|^\.codex/scripts/publish-review-status\.sh$|^REVIEW\.md$|\.sql$|secrets`;

/** The text of the `run:` block of a step of a job, indented as GitHub hands it to the shell. */
function stepScript(block: string, name: string): string {
	const lines = block.split("\n");
	const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
	if (start === -1) throw new Error(`step "${name}" not found`);
	const end = lines.findIndex((line, index) => index > start && /^\s*- (name|uses):/.test(line));
	const runAt = lines.findIndex(
		(line, index) => index > start && (end === -1 || index < end) && /^\s*run: \|$/.test(line),
	);
	if (runAt === -1) throw new Error(`step "${name}" has no run block`);
	const indent = (lines[runAt] as string).length - (lines[runAt] as string).trimStart().length + 2;
	const body: string[] = [];
	for (const line of lines.slice(runAt + 1)) {
		if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
		body.push(line.slice(indent));
	}
	return body.join("\n");
}

/** The alternatives of a pattern at its top level (`a|(b|c)|d` gives `a`, `(b|c)` and `d`). */
function topLevelAlternatives(pattern: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i] as string;
		if (char === "\\") {
			current += char + (pattern[i + 1] ?? "");
			i++;
			continue;
		}
		if (inClass) {
			if (char === "]") inClass = false;
		} else if (char === "[") inClass = true;
		else if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (char === "|" && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts;
}

const git = (cwd: string, ...args: string[]): string => {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
};

const put = (root: string, path: string, body = "content\n"): void => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), body);
};

const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface Detection {
	status: number | null;
	escalated: boolean;
	stderr: string;
}

/**
 * A repository whose default branch holds `policy` (and `baseFiles`) and a checkout on a pull request branch,
 * with the two steps of the job run on it. `gh` is a script that records what it is asked to do.
 */
function makeRepo(options: { policy?: string; baseFiles?: Readonly<Record<string, string>> } = {}) {
	const root = mkdtempSync(join(tmpdir(), "tier-guard-"));
	scratch.push(root);
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	const runnerTemp = join(root, "runner-temp");
	const bin = join(root, "bin");
	const calls = join(root, "gh-calls");
	mkdirSync(runnerTemp);
	mkdirSync(bin);
	git(root, "init", "-q", "--bare", "--initial-branch=main", origin);
	git(root, "clone", "-q", origin, work);
	git(work, "config", "user.email", "ci@example.test");
	git(work, "config", "user.name", "ci");
	git(work, "config", "commit.gpgsign", "false");
	put(work, POLICY_PATH, options.policy ?? REAL_POLICY);
	for (const [file, body] of Object.entries(options.baseFiles ?? {})) put(work, file, body);
	git(work, "add", "-A");
	git(work, "commit", "-q", "-m", "base");
	git(work, "push", "-q", "origin", "HEAD:main");
	git(work, "fetch", "-q", "origin");
	writeFileSync(join(bin, "gh"), `#!/bin/bash\necho "$@" >> '${calls}'\nexit 0\n`);
	chmodSync(join(bin, "gh"), 0o755);

	const tierGuard = jobBlock("tier-guard");
	const loadScript = stepScript(tierGuard, LOAD_STEP);
	// GitHub substitutes the expression before the shell sees it; the number is the pull request's.
	const detectScript = stepScript(tierGuard, DETECT_STEP).replaceAll(
		expr("github.event.pull_request.number"),
		"42",
	);
	const patternFile = join(runnerTemp, "tier-guard", "sensitive-path.ere");
	// `shell: bash` is `bash --noprofile --norc -eo pipefail {0}`; a step without `shell:` is `bash -e {0}`.
	const run = (script: string, shellArgs: string[], env: Record<string, string>) =>
		spawnSync("bash", [...shellArgs, "-c", script], {
			cwd: work,
			encoding: "utf8",
			env: { PATH: `${bin}:${process.env.PATH}`, HOME: runnerTemp, RUNNER_TEMP: runnerTemp, ...env },
		});

	return {
		work,
		/** A pull request branch cut from the default branch, with one commit made by `change`. */
		pr(change: (dir: string) => void): void {
			git(work, "checkout", "-q", "-B", "pr", "origin/main");
			change(work);
			git(work, "add", "-A");
			git(work, "commit", "-q", "--allow-empty", "-m", "pr");
		},
		/** The first step of the job, run in the pull request checkout. */
		load(env: Record<string, string> = {}) {
			return run(loadScript, ["--noprofile", "--norc", "-eo", "pipefail"], {
				DEFAULT_BRANCH: "main",
				...env,
			});
		},
		hasPattern: () => existsSync(patternFile),
		pattern: () => readFileSync(patternFile, "utf8"),
		/** Replaces what the first step wrote, to run the second one with another pattern. */
		setPattern(text: string): void {
			mkdirSync(dirname(patternFile), { recursive: true });
			writeFileSync(patternFile, text);
		},
		/** The second step of the job: did it label the pull request tier/3? */
		detectScript,
		detect(script: string = detectScript): Detection {
			rmSync(calls, { force: true });
			const result = run(script, ["-e"], { BASE_REF: "main", GH_TOKEN: "x" });
			const recorded = existsSync(calls) ? readFileSync(calls, "utf8") : "";
			return {
				status: result.status,
				escalated: recorded.includes("pr edit 42 --add-label tier/3"),
				stderr: result.stderr,
			};
		},
	};
}

describe("tier-guard derives its pattern from sensitivePath (TRA-556)", () => {
	const block = jobBlock("tier-guard");
	const ere = (alternative: string) => alternative.replaceAll("\\/", "/");

	it("holds no copy of the pattern: neither the whole of sensitivePath nor its alternatives are written in the job", () => {
		const alternatives = topLevelAlternatives(sensitivePath.source);
		expect(alternatives.length).toBeGreaterThan(5);
		for (const copy of [sensitivePath.source, ...alternatives]) {
			// The short alternatives (`secrets`) are plain words that the job uses for other reasons.
			if (copy.length < 15) continue;
			expect(block, copy).not.toContain(copy);
			expect(block, copy).not.toContain(ere(copy));
		}
		expect(block).not.toMatch(/grep -Eqi '/);
	});

	it("reads the literal from the default branch, before it detects, and executes nothing of the PR checkout", () => {
		const load = block.indexOf(`- name: ${LOAD_STEP}`);
		const detect = block.indexOf(`- name: ${DETECT_STEP}`);
		expect(load).toBeGreaterThan(-1);
		expect(load).toBeLessThan(detect);
		expect(block).toContain(`DEFAULT_BRANCH: "${expr("github.event.repository.default_branch")}"`);
		const script = stepScript(block, LOAD_STEP);
		expect(script).toContain('git show "origin/$DEFAULT_BRANCH:scripts/ci/review-gate-policy.ts"');
		// The path of the policy is read nowhere else: not from the working tree, not from the PR base.
		expect(script.replace('origin/$DEFAULT_BRANCH:scripts/ci/review-gate-policy.ts"', "")).not.toContain(
			"scripts/ci/review-gate-policy.ts",
		);
		expect(block).not.toMatch(/npm (ci|install)|npx|tsx|--experimental-strip-types/);
		expect(script).not.toContain("BASE_REF");
		expect(block).not.toContain("origin/${{");
	});

	it("keeps --no-renames, -z and grep -Eqi (TRA-553), and the base ref through env", () => {
		const script = stepScript(block, DETECT_STEP);
		expect(script).toContain("git diff -z --name-only --no-renames");
		expect(script).toContain("grep -Eqi -f");
		expect(script).toContain("set -o pipefail");
	});

	it("writes the pattern of sensitivePath, `\\/` written `/`, and nothing else", () => {
		const repo = makeRepo();
		repo.pr((dir) => put(dir, "src/graph.ts"));
		const loaded = repo.load();
		expect(loaded.status, loaded.stderr).toBe(0);
		expect(repo.pattern()).toBe(`${ere(sensitivePath.source)}\n`);
		// The other half of the pattern: the job greps with `-i` and nothing else.
		expect(sensitivePath.flags).toBe("i");
		expect(loaded.stdout).toContain(ere(sensitivePath.source));
	});

	describe("fails closed on a policy it cannot translate faithfully", () => {
		const declaration = (literal: string) => `export const sensitivePath =\n\t${literal};\n`;
		const cases: [string, string][] = [
			["a flag other than i", declaration("/^a\\/|b/gi")],
			["no flag", declaration("/^a\\/|b/")],
			[
				"the declaration renamed",
				REAL_POLICY.replace("\nexport const sensitivePath =", "\nexport const sensitive ="),
			],
			["the declaration twice", declaration("/^a/i") + declaration("/^b/i")],
			["a non-capturing group", declaration("/(?:a|b)\\//i")],
			["a lookahead", declaration("/a(?=b)/i")],
			["a JS-only escape", declaration("/^\\d+\\//i")],
			["a word boundary", declaration("/\\bsecrets/i")],
			["a backslash in a character class", declaration("/[\\.]x/i")],
			["a slash in a character class", declaration("/^[/]x/i")],
			["a POSIX class, which JS reads as a plain class", declaration("/^[[:alpha:]]x/i")],
			["a lazy quantifier", declaration("/^a+?x/i")],
			["a non-ASCII character", declaration("/^é\\//i")],
			["an invalid expression", declaration("/(a/i")],
			["a policy on several lines", "export const sensitivePath =\n\t/a\nb/i;\n"],
		];

		it.each(cases)("%s", (_name, policy) => {
			const repo = makeRepo({ policy });
			repo.pr((dir) => put(dir, "src/graph.ts"));
			const loaded = repo.load();
			expect(loaded.status).not.toBe(0);
			expect(repo.hasPattern()).toBe(false);
		});

		it("reports why on stderr as a workflow error", () => {
			const repo = makeRepo({ policy: declaration("/a/gi") });
			repo.pr((dir) => put(dir, "src/graph.ts"));
			expect(repo.load().stderr).toContain("::error::sensitivePath de la branche par défaut inutilisable");
		});

		it("when the default branch cannot be read", () => {
			const repo = makeRepo();
			repo.pr((dir) => put(dir, "src/graph.ts"));
			expect(repo.load({ DEFAULT_BRANCH: "no-such-branch" }).status).not.toBe(0);
			expect(repo.hasPattern()).toBe(false);
		});

		it("accepts the quoting of a punctuation character, and writes `\\/` as `/`", () => {
			const repo = makeRepo({ policy: declaration("/^a\\/b\\.c\\$|\\(x\\)/i") });
			repo.pr((dir) => put(dir, "src/graph.ts"));
			expect(repo.load().status).toBe(0);
			expect(repo.pattern()).toBe("^a/b\\.c\\$|\\(x\\)\n");
		});
	});

	describe("a missing or unusable pattern fails the detection instead of reading as 'nothing sensitive'", () => {
		it("fails when the first step did not run", () => {
			const repo = makeRepo();
			repo.pr((dir) => put(dir, ".github/workflows/ci.yml"));
			const run = repo.detect();
			expect(run.status).not.toBe(0);
			expect(run.escalated).toBe(false);
		});

		it("fails when grep cannot compile the pattern (status 2, not 1)", () => {
			const repo = makeRepo();
			repo.pr((dir) => put(dir, "src/graph.ts"));
			repo.setPattern("(unclosed\n");
			const run = repo.detect();
			expect(run.status).not.toBe(0);
			expect(run.escalated).toBe(false);
		});

		it("passes without a label when nothing sensitive changed (status 1 is not an error)", () => {
			const repo = makeRepo();
			repo.pr((dir) => put(dir, "src/graph.ts"));
			expect(repo.load().status).toBe(0);
			const run = repo.detect();
			expect(run.status).toBe(0);
			expect(run.escalated).toBe(false);
		});

		// `grep -q` stops at the first match. With `pipefail`, an `echo` that the pipe kills (SIGPIPE) on a list
		// larger than the pipe buffer ends the pipeline in 141, which is neither "match" nor "no match".
		describe("a diff larger than the pipe buffer, with the sensitive path listed first", () => {
			const bulk = (dir: string) => {
				put(dir, ".github/workflows/ci.yml");
				for (let file = 0; file < 3000; file++) put(dir, `data/bulk/${"x".repeat(60)}-${file}.json`);
			};

			it("is still labelled tier/3", () => {
				const repo = makeRepo();
				repo.pr(bulk);
				expect(repo.load().status).toBe(0);
				const run = repo.detect();
				expect(run.status, run.stderr).toBe(0);
				expect(run.escalated).toBe(true);
			});

			it("would have failed with the list piped into grep (the test is able to fail)", () => {
				const repo = makeRepo();
				repo.pr(bulk);
				expect(repo.load().status).toBe(0);
				const piped = repo.detectScript.replace(
					'grep -Eqi -f "$pattern" <<< "$CHANGED"',
					'echo "$CHANGED" | grep -Eqi -f "$pattern"',
				);
				expect(piped).not.toBe(repo.detectScript);
				const run = repo.detect(piped);
				expect(run.status).not.toBe(0);
				expect(run.escalated).toBe(false);
			});
		});
	});
});

describe("tier-guard classifies every path as the grep it replaces did (TRA-556)", () => {
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
		"REVIEW.md",
		"db/schema.sql",
		"config/secrets.json",
		// TRA-553: the runners' APFS ignores case, so a differently cased path is the same file there.
		"review.md",
		"Review.MD",
		".GitHub/workflows/ci.yml",
		"Scripts/CI/Review-Reuse.ts",
		"DB/SCHEMA.SQL",
		// TRA-553: a path with a non-ASCII byte, which git quotes unless the diff is NUL-separated.
		".github/workflows/é.yml",
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
		"docs/REVIEW.md",
		"docs/review.md",
		"REVIEW.md.bak",
		"src/graph.ts",
		"src/é/a.ts",
	];
	// The migration test below holds the job to the frozen grep. A path that matches only because
	// `sensitivePath` grew after TRA-556 belongs in `sensitive` (the job must escalate it) and here (the frozen
	// grep never did).
	const grewAfterTra556: readonly string[] = [];

	/** One repository for the whole corpus; each path is a pull request cut from the same default branch. */
	let repo: ReturnType<typeof makeRepo>;
	beforeAll(() => {
		repo = makeRepo();
		repo.pr((dir) => put(dir, "src/graph.ts"));
		const loaded = repo.load();
		if (loaded.status !== 0) throw new Error(loaded.stderr);
	});

	/** The verdict of the second step of the job on a pull request that adds `path`, under each pattern. */
	const verdicts = (path: string) => {
		repo.pr((dir) => put(dir, path));
		const derived = repo.pattern();
		const current = repo.detect();
		repo.setPattern(`${LEGACY_GREP}\n`);
		const legacy = repo.detect();
		repo.setPattern(derived);
		return { current, legacy };
	};

	it("covers every alternative of sensitivePath with at least one escalating path", () => {
		// A new alternative with no path here would be derived into the job and never exercised.
		for (const alternative of topLevelAlternatives(sensitivePath.source)) {
			const pattern = new RegExp(alternative, sensitivePath.flags);
			expect(
				sensitive.some((path) => pattern.test(path)),
				`no path of the corpus matches ${alternative}`,
			).toBe(true);
		}
	});

	it.each(sensitive)("escalates %s, in the job, as the policy and the frozen grep do", (path) => {
		expect(classifyRisk([path], [])).toBe(3);
		const { current, legacy } = verdicts(path);
		expect(current.status, current.stderr).toBe(0);
		expect(current.escalated, `job: ${path}`).toBe(true);
		if (!grewAfterTra556.includes(path)) expect(legacy.escalated, `frozen grep: ${path}`).toBe(true);
	});

	it.each(ordinary)("does not escalate %s, in the job, in the policy or in the frozen grep", (path) => {
		expect(classifyRisk([path], [])).toBeLessThan(3);
		const { current, legacy } = verdicts(path);
		expect(current.status, current.stderr).toBe(0);
		expect(current.escalated, `job: ${path}`).toBe(false);
		expect(legacy.escalated, `frozen grep: ${path}`).toBe(false);
	});

	it("is able to fail: a pattern missing one alternative lets a sensitive path through", () => {
		repo.pr((dir) => put(dir, "config/secrets.json"));
		const derived = repo.pattern();
		try {
			repo.setPattern(`${LEGACY_GREP.replace("|secrets", "")}\n`);
			expect(repo.detect().escalated).toBe(false);
			expect(classifyRisk(["config/secrets.json"], [])).toBe(3);
		} finally {
			repo.setPattern(derived);
		}
	});

	// TRA-553: `git diff --name-only` lists a rename by its destination only, so `git mv REVIEW.md docs/REVIEW.md`
	// plus an edit used to leave the sensitive source out of the list. The job's own steps run on a real rename.
	describe("a rename out of a sensitive path (TRA-553)", () => {
		const body = Array.from({ length: 40 }, (_, line) => `line ${line} of the file\n`).join("");
		// One repository per rename: the source must exist on the default branch for the PR's move to be a rename.
		const renames: [string, string][] = [
			["REVIEW.md", "docs/REVIEW.md"],
			["review.md", "docs/notes.md"],
			[".GitHub/workflows/old.yml", "docs/old.yml"],
			["scripts/ci/review-reuse.ts", "src/review-reuse.ts"],
		];

		/** Both steps of the job on a PR that moves and edits `from`, under the derived and the frozen pattern. */
		const renameVerdicts = (from: string, to: string) => {
			const repo = makeRepo({ baseFiles: { [from]: body } });
			repo.pr((work) => {
				mkdirSync(dirname(join(work, to)), { recursive: true });
				git(work, "mv", from, to);
				writeFileSync(join(work, to), `${body}one more line\n`);
			});
			const loaded = repo.load();
			expect(loaded.status, loaded.stderr).toBe(0);
			const derived = repo.pattern();
			const current = repo.detect();
			repo.setPattern(`${LEGACY_GREP}\n`);
			const legacy = repo.detect();
			repo.setPattern(derived);
			return { current, legacy };
		};

		it.each(renames)("escalates %s -> %s, in the job and in the frozen grep", (from, to) => {
			const { current, legacy } = renameVerdicts(from, to);
			expect(current.escalated, "job").toBe(true);
			expect(legacy.escalated, "frozen grep").toBe(true);
			expect(classifyRisk([from, to], [])).toBe(3);
		});

		it("does not escalate a rename between ordinary paths", () => {
			const { current, legacy } = renameVerdicts("src/a.ts", "src/b.ts");
			expect(current.escalated).toBe(false);
			expect(legacy.escalated).toBe(false);
		});
	});
});

describe("a pull request that edits sensitivePath is classified by the default branch's (TRA-556)", () => {
	const WEAKENED = "export const sensitivePath =\n\t/never/i;\nexport const classifyRisk = () => 1;\n";

	it("stays tier/3 when the PR replaces sensitivePath with a pattern that matches nothing", () => {
		const repo = makeRepo();
		repo.pr((dir) => put(dir, POLICY_PATH, WEAKENED));
		// Control: the PR's own pattern would not escalate its own change.
		expect(/never/i.test(POLICY_PATH)).toBe(false);

		const loaded = repo.load();
		expect(loaded.status, loaded.stderr).toBe(0);
		expect(repo.pattern()).toBe(`${sensitivePath.source.replaceAll("\\/", "/")}\n`);
		expect(repo.pattern()).not.toContain("never");
		const run = repo.detect();
		expect(run.status, run.stderr).toBe(0);
		expect(run.escalated).toBe(true);
	});

	it("is able to fail: loaded from the PR checkout, the weakened pattern would let the PR through unlabelled", () => {
		const repo = makeRepo();
		repo.pr((dir) => put(dir, POLICY_PATH, WEAKENED));
		repo.setPattern("never\n");
		expect(repo.detect().escalated).toBe(false);
	});

	it("does not apply an alternative the PR adds to sensitivePath to its own files", () => {
		const widened = REAL_POLICY.replace("|secrets/i;", "|secrets|^plans\\/secret\\//i;");
		expect(widened).not.toBe(REAL_POLICY);
		const repo = makeRepo();
		repo.pr((dir) => put(dir, POLICY_PATH, widened));
		expect(repo.load().status).toBe(0);
		expect(repo.pattern()).not.toContain("plans");
		// The PR is still tier/3, by the default branch's own `^scripts/ci/review-gate-policy`.
		expect(repo.detect().escalated).toBe(true);
	});

	it("keeps ci.yml itself, where the job lives, in tier/3", () => {
		const repo = makeRepo();
		repo.pr((dir) => put(dir, ".github/workflows/ci.yml"));
		expect(repo.load().status).toBe(0);
		expect(repo.detect().escalated).toBe(true);
	});
});

describe("tier-guard diff listing (TRA-553)", () => {
	const diffCommand = /CHANGED=\$\((git diff [^)]*)\)/.exec(jobBlock("tier-guard"))?.[1] as string;
	const body = Array.from({ length: 40 }, (_, line) => `line ${line} of the file\n`).join("");

	/** A repository whose last commit moves `from` to `to` and edits it; returns it with the commit before. */
	const withRename = (from: string, to: string) => {
		const dir = mkdtempSync(join(tmpdir(), "tier-guard-rename-"));
		scratch.push(dir);
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "ci@example.test");
		git(dir, "config", "user.name", "ci");
		git(dir, "config", "commit.gpgsign", "false");
		put(dir, from, body);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "base");
		const base = git(dir, "rev-parse", "HEAD").trim();
		mkdirSync(dirname(join(dir, to)), { recursive: true });
		git(dir, "mv", from, to);
		writeFileSync(join(dir, to), `${body}one more line\n`);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "move and edit");
		return { dir, base };
	};
	const list = (dir: string, base: string) =>
		spawnSync("bash", ["-c", diffCommand], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, BASE: base },
		});
	const sensitiveListed = (listed: string) => listed.split("\n").some((path) => sensitivePath.test(path));

	it("takes the git diff of the job with --name-only --no-renames", () => {
		expect(diffCommand).toContain("--name-only");
		expect(diffCommand).toContain("--no-renames");
		expect(diffCommand).toMatch(/git diff -z /);
	});

	it("lists a path with a non-ASCII byte raw, not quoted, so the `^` anchors still match", () => {
		const { dir, base } = withRename("src/a.ts", ".github/workflows/é.yml");
		const listed = list(dir, base);
		expect(listed.stdout.trim().split("\n").sort()).toEqual([".github/workflows/é.yml", "src/a.ts"]);
		expect(sensitiveListed(listed.stdout)).toBe(true);
		// The default output, which the job used to read: quoted and escaped, hence invisible to the anchors.
		const quoted = git(dir, "diff", "--name-only", "--no-renames", `${base}...HEAD`);
		expect(quoted).toContain('"');
		expect(sensitiveListed(quoted.replace("src/a.ts", ""))).toBe(false);
	});

	it("was invisible without --no-renames (the destination alone does not match)", () => {
		const { dir, base } = withRename("REVIEW.md", "docs/REVIEW.md");
		const listed = git(dir, "diff", "--name-only", "-M", `${base}...HEAD`);
		expect(listed.trim()).toBe("docs/REVIEW.md");
		expect(sensitiveListed(listed)).toBe(false);
		expect(list(dir, base).stdout.trim().split("\n").sort()).toEqual(["REVIEW.md", "docs/REVIEW.md"]);
	});

	// TRA-553: `git diff -z … | tr` hides the status of git diff unless pipefail is on; then CHANGED would be empty
	// with status 0 and a sensitive PR would pass unlabelled. The step's own script runs with a git that fails.
	describe("a failing git diff", () => {
		const script = stepScript(jobBlock("tier-guard"), DETECT_STEP);
		const runWithFailingDiff = (text: string) => {
			const dir = mkdtempSync(join(tmpdir(), "tier-guard-fail-"));
			scratch.push(dir);
			const bin = join(dir, "bin");
			mkdirSync(bin);
			const calls = join(dir, "gh-calls");
			writeFileSync(join(bin, "git"), '#!/bin/bash\n[ "$1" = diff ] && exit 2\nexit 0\n');
			writeFileSync(join(bin, "gh"), `#!/bin/bash\necho "$@" >> '${calls}'\nexit 0\n`);
			chmodSync(join(bin, "git"), 0o755);
			chmodSync(join(bin, "gh"), 0o755);
			// A pattern file that matches everything, so an empty list is the only reason not to label.
			mkdirSync(join(dir, "tier-guard"));
			writeFileSync(join(dir, "tier-guard", "sensitive-path.ere"), "^.+$\n");
			// `bash -e {0}` is what GitHub runs for a `run:` without `shell:`.
			const result = spawnSync("bash", ["-e", "-c", text], {
				cwd: dir,
				encoding: "utf8",
				env: { PATH: `${bin}:${process.env.PATH}`, BASE_REF: "main", GH_TOKEN: "x", RUNNER_TEMP: dir },
			});
			return result.status;
		};

		it("makes the step fail", () => {
			expect(script).toContain("set -o pipefail");
			expect(runWithFailingDiff(script)).not.toBe(0);
		});

		it("would have passed silently without pipefail (the test is able to fail)", () => {
			expect(runWithFailingDiff(script.replace("set -o pipefail", ":"))).toBe(0);
		});
	});
});
