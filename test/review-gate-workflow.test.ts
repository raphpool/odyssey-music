import { execFile } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

// TRA-520: review-gate.yml is read as text and its two security-relevant pieces are executed as the job runs
// them: the jq program that picks the `review` check-run, and the step that loads the policy from the default
// branch. No YAML parser is added (same approach as ci-integrity-job.test.ts and review-reuse.test.ts).
const exec = promisify(execFile);

const gate = readFileSync(".github/workflows/review-gate.yml", "utf8").replaceAll("\r\n", "\n");
const code = gate
	.split("\n")
	.filter((line) => !/^\s*#/.test(line))
	.join("\n");

const expr = (inner: string): string => `\${{ ${inner} }}`;

/** The `run: |` script of a step, unindented, from its `- name:` line. */
function stepScript(name: string): string {
	const lines = gate.split("\n");
	const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
	if (start === -1) throw new Error(`step "${name}" not found in review-gate.yml`);
	const runAt = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
	if (runAt === -1) throw new Error(`step "${name}" has no run block`);
	const indent = (lines[runAt]?.length ?? 0) - (lines[runAt]?.trimStart().length ?? 0) + 2;
	const body: string[] = [];
	for (const line of lines.slice(runAt + 1)) {
		if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
		body.push(line.slice(indent));
	}
	return body.join("\n");
}

/** The jq program the "Evaluate" step keeps in `select_review`. */
function selectReviewProgram(): string {
	const match = /select_review=\$\(cat <<'JQ'\n([\s\S]*?)\nJQ\n\)/.exec(
		stepScript("Evaluate combined review policy"),
	);
	if (match?.[1] === undefined) throw new Error("select_review heredoc not found in review-gate.yml");
	return match[1];
}

const scratch = mkdtempSync(join(tmpdir(), "review-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const HEAD = "b".repeat(40);
const OTHER_HEAD = "c".repeat(40);
const AI_REVIEW = ".github/workflows/ai-review.yml";

const workflowRun = (id: number, suite: number, overrides: Record<string, unknown> = {}) => ({
	id,
	path: AI_REVIEW,
	event: "pull_request",
	head_sha: HEAD,
	check_suite_id: suite,
	...overrides,
});

const checkRun = (id: number, suite: number, overrides: Record<string, unknown> = {}) => ({
	id,
	name: "review",
	head_sha: HEAD,
	conclusion: "success",
	started_at: "2026-10-15T09:00:00Z",
	app: { slug: "github-actions" },
	check_suite: { id: suite },
	...overrides,
});

const job = (id: number, runId: number, overrides: Record<string, unknown> = {}) => ({
	id,
	name: "review",
	run_id: runId,
	...overrides,
});

interface Api {
	checks: unknown[];
	runs: unknown[];
	jobs: unknown[];
}

/** The `review` check-run of a run of ai-review.yml, as the API lists it: its check-run, its run, its job. */
const genuine = (id: number, suite: number, overrides: Record<string, unknown> = {}): Api => ({
	checks: [checkRun(id, suite, overrides)],
	runs: [workflowRun(5000 + suite, suite)],
	jobs: [job(id, 5000 + suite)],
});

const merge = (...apis: Partial<Api>[]): Api => ({
	checks: apis.flatMap((api) => api.checks ?? []),
	runs: apis.flatMap((api) => api.runs ?? []),
	jobs: apis.flatMap((api) => api.jobs ?? []),
});

let fixture = 0;
const stream = (path: string, items: unknown[]): void =>
	writeFileSync(path, items.map((item) => JSON.stringify(item)).join("\n"));

/** What the "Evaluate" step reads: `<check-run id>\t<conclusion or missing>`. */
async function select(api: Api): Promise<string> {
	fixture += 1;
	const files = (["checks", "runs", "jobs"] as const).map((kind) => {
		const path = join(scratch, `${kind}-${fixture}.json`);
		// Like the workflow's files: one JSON value per item, an empty file for an empty list.
		stream(path, api[kind]);
		return path;
	});
	const [checks, runs, jobs] = files as [string, string, string];
	const { stdout } = await exec("jq", [
		"-nr",
		"--slurpfile",
		"checks",
		checks,
		"--slurpfile",
		"runs",
		runs,
		"--slurpfile",
		"jobs",
		jobs,
		"--arg",
		"sha",
		HEAD,
		"--arg",
		"path",
		AI_REVIEW,
		selectReviewProgram(),
	]);
	return stdout.trimEnd();
}

describe("review-gate.yml: which check-run counts as the AI review (TRA-520)", () => {
	it("picks the review of ai-review.yml and reports its id and conclusion", async () => {
		expect(await select(genuine(11, 100))).toBe("11\tsuccess");
		expect(await select(genuine(12, 100, { conclusion: "failure" }))).toBe("12\tfailure");
	});

	it("ignores a `review` check-run created by another workflow or by the API, even when it starts last", async () => {
		const forged = { started_at: "2099-01-01T00:00:00Z" };
		// A job named `review` in a workflow that is not ai-review.yml.
		const otherWorkflow = {
			checks: [checkRun(99, 300, forged)],
			runs: [workflowRun(5300, 300, { path: ".github/workflows/forged.yml" })],
			jobs: [job(99, 5300)],
		};
		// Only the forged one exists: nothing counts, the gate stays on `missing`.
		expect(await select(otherWorkflow)).toBe("0\tmissing");
		// Created through the API under a suite of its own.
		expect(await select({ checks: [checkRun(98, 200, forged)], runs: [], jobs: [] })).toBe("0\tmissing");
		// Next to the real one it never wins, whatever its start time.
		expect(await select(merge(genuine(11, 100, { conclusion: "failure" }), otherWorkflow))).toBe(
			"11\tfailure",
		);
	});

	it("ignores a `review` check-run attached to the very suite of ai-review.yml when no job of that run made it", async () => {
		// The API may file a check-run created by a step of the PR under the Actions suite of the head.
		const attached = checkRun(77, 100, { started_at: "2099-01-01T00:00:00Z" });
		expect(await select({ checks: [attached], runs: [workflowRun(5100, 100)], jobs: [] })).toBe("0\tmissing");
		expect(await select(merge(genuine(11, 100, { conclusion: "failure" }), { checks: [attached] }))).toBe(
			"11\tfailure",
		);
	});

	it("keeps the ai-review.yml check-run even though it started before a forged `review`", async () => {
		const real = genuine(11, 100, { started_at: "2026-10-15T09:00:00Z" });
		const forgedLater = { checks: [checkRun(98, 200, { started_at: "2026-10-15T09:30:00Z" })] };
		const forgedNoSuiteMatch = { checks: [checkRun(97, 999, { started_at: "2026-10-15T09:45:00Z" })] };
		expect(await select(merge(forgedLater, real, forgedNoSuiteMatch))).toBe("11\tsuccess");
	});

	it("reports `missing` when no review of ai-review.yml exists for the head", async () => {
		expect(await select({ checks: [], runs: [], jobs: [] })).toBe("0\tmissing");
		const real = genuine(11, 100);
		expect(await select({ ...real, runs: [], jobs: [] })).toBe("0\tmissing");
		// A run of ai-review.yml whose job never started: no check-run.
		expect(await select({ ...real, checks: [] })).toBe("0\tmissing");
	});

	it.each([
		["a run of another workflow file", { path: ".github/workflows/ci.yml" }],
		["a lookalike path", { path: ".github/workflows/ai-review.yml.bak" }],
		["a run of ai-review.yml for another head", { head_sha: OTHER_HEAD }],
		["a run triggered by something else than pull_request", { event: "workflow_dispatch" }],
	])("ignores a check-run whose suite belongs to %s", async (_label, override) => {
		expect(await select({ ...genuine(11, 100), runs: [workflowRun(5100, 100, override)] })).toBe(
			"0\tmissing",
		);
	});

	it.each([
		["a job of another run", [job(11, 4242)]],
		["a job of another name", [job(11, 5100, { name: "review-extra" })]],
		["the id of another job", [job(12, 5100)]],
	])("ignores a check-run matched only by %s", async (_label, jobs) => {
		expect(await select({ ...genuine(11, 100), jobs })).toBe("0\tmissing");
	});

	it.each([
		["another app", { app: { slug: "some-other-app" } }],
		["no app", { app: null }],
		["another head", { head_sha: OTHER_HEAD }],
		["another name", { name: "review-extra" }],
	])("ignores a check-run of the right suite and job reported by %s", async (_label, override) => {
		expect(await select(genuine(11, 100, override))).toBe("0\tmissing");
	});

	it("takes the latest check-run of the workflow when a re-run added one, and keeps pending as missing", async () => {
		const first = genuine(11, 100, { conclusion: "failure", started_at: "2026-10-15T09:00:00Z" });
		// A re-run of the same run: a new check-run in the same suite, a new job id for the same run.
		const rerun = {
			checks: [checkRun(12, 100, { conclusion: "success", started_at: "2026-10-15T09:10:00Z" })],
			jobs: [job(12, 5100)],
		};
		const newerRun = genuine(13, 101, { conclusion: null, started_at: "2026-10-15T09:20:00Z" });
		expect(await select(merge(first, rerun))).toBe("12\tsuccess");
		expect(await select(merge(rerun, first))).toBe("12\tsuccess");
		// A newer review still running: that is the one judged, and it has no conclusion yet.
		expect(await select(merge(first, rerun, newerRun))).toBe("13\tmissing");
	});
});

describe("review-gate.yml: the policy comes from the default branch (TRA-520)", () => {
	const git = (cwd: string, ...args: string[]) =>
		exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd });

	// A PR that rewrites the policy so that nothing is ever required of it.
	const WEAKENED = `export const sensitivePath = /never/;
const main = (): void => {
	console.log(JSON.stringify({ risk: 1, verdict: "pass" }));
};
main();
`;

	/** A repository whose default branch holds the real policy and whose checked-out branch weakens it. */
	async function prCheckout(name: string): Promise<{ work: string; runnerTemp: string }> {
		const origin = join(scratch, `${name}-origin.git`);
		const work = join(scratch, `${name}-work`);
		const runnerTemp = join(scratch, `${name}-runner-temp`);
		mkdirSync(runnerTemp);
		await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
		await exec("git", ["clone", origin, work]);
		mkdirSync(join(work, "scripts", "ci"), { recursive: true });
		copyFileSync("scripts/ci/review-gate-policy.ts", join(work, "scripts", "ci", "review-gate-policy.ts"));
		// TRA-527: the allowed authors live next to the workflow, on the default branch too.
		mkdirSync(join(work, ".github"));
		copyFileSync(".github/review-gate-authors.txt", join(work, ".github", "review-gate-authors.txt"));
		await git(work, "add", ".");
		await git(work, "commit", "-m", "policy");
		await git(work, "push", "origin", "HEAD:main");
		await git(work, "fetch", "origin");
		await git(work, "checkout", "-b", "weaken-policy");
		writeFileSync(join(work, "scripts", "ci", "review-gate-policy.ts"), WEAKENED);
		// The same PR also appends a forger to the list it is judged by.
		writeFileSync(join(work, ".github", "review-gate-authors.txt"), "raphpool\nforger\n");
		await git(work, "commit", "-am", "weaken the policy");
		return { work, runnerTemp };
	}

	const loader = () => stepScript("Load the review policy from the default branch");

	const input = JSON.stringify({
		paths: [".github/workflows/review-gate.yml"],
		labels: ["tier/1"],
		ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
		deep: "missing",
		risk: 1,
	});

	const evaluate = async (policy: string) => {
		const { stdout } = await exec("npx", ["--no-install", "tsx", policy, input]);
		return JSON.parse(stdout) as { risk: number; verdict: string };
	};

	it("runs the default branch's policy, so a PR that lowers the tier does not lower the requirement", async () => {
		const { work, runnerTemp } = await prCheckout("loads");
		// Control: the copy in the PR checkout does say "pass" with no deep review, which is what the PR wants.
		expect(await evaluate(join(work, "scripts", "ci", "review-gate-policy.ts"))).toEqual({
			risk: 1,
			verdict: "pass",
		});

		await exec("bash", ["-c", loader()], {
			cwd: work,
			env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: runnerTemp, DEFAULT_BRANCH: "main" },
		});

		// A sensitive path escalates to tier/3 and, without codex-deep-review, the gate keeps waiting.
		expect(await evaluate(join(runnerTemp, "review-gate-policy", "review-gate-policy.ts"))).toEqual({
			risk: 3,
			verdict: "wait",
		});
	}, 60_000);

	it("fails closed, and leaves no policy behind, when the default branch's copy cannot be read", async () => {
		const { work, runnerTemp } = await prCheckout("fails");
		// A stale copy from a previous job of the same runner must not survive a failed load.
		mkdirSync(join(runnerTemp, "review-gate-policy"));
		writeFileSync(join(runnerTemp, "review-gate-policy", "review-gate-policy.ts"), WEAKENED);

		for (const defaultBranch of ["no-such-branch", ""]) {
			await expect(
				exec("bash", ["-c", loader()], {
					cwd: work,
					env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: runnerTemp, DEFAULT_BRANCH: defaultBranch },
				}),
			).rejects.toMatchObject({ code: expect.any(Number) });
			expect(existsSync(join(runnerTemp, "review-gate-policy", "review-gate-policy.ts"))).toBe(false);
		}
	}, 60_000);

	it("fails closed when the default branch has no policy file", async () => {
		const { work, runnerTemp } = await prCheckout("no-file");
		await git(work, "rm", "-q", "scripts/ci/review-gate-policy.ts");
		await git(work, "commit", "-m", "drop the policy");
		await git(work, "push", "origin", "HEAD:main");
		await git(work, "fetch", "origin");
		await expect(
			exec("bash", ["-c", loader()], {
				cwd: work,
				env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: runnerTemp, DEFAULT_BRANCH: "main" },
			}),
		).rejects.toMatchObject({ code: expect.any(Number) });
	}, 60_000);

	it("never executes anything from the PR checkout: loads before evaluating, no npm ci, no tsx", () => {
		expect(code.indexOf("- name: Load the review policy from the default branch")).toBeGreaterThan(-1);
		expect(code.indexOf("- name: Load the review policy from the default branch")).toBeLessThan(
			code.indexOf("- name: Evaluate combined review policy"),
		);
		expect(code).toContain('git show "origin/$DEFAULT_BRANCH:scripts/ci/review-gate-policy.ts"');
		expect(code).toContain(`DEFAULT_BRANCH: ${expr("github.event.repository.default_branch")}`);
		expect(code).toContain(
			'node --experimental-strip-types --no-warnings "$RUNNER_TEMP/review-gate-policy/review-gate-policy.ts"',
		);
		expect(code).not.toMatch(/npm (ci|install)|npx|tsx/);
		// The only mention of the policy path outside the loader is the copy the loader wrote.
		expect(code.match(/scripts\/ci\/review-gate-policy\.ts/g)).toHaveLength(1);
		expect(code).not.toContain("origin/${{");
	});

	it("keeps review-gate-policy.ts loadable by `node --experimental-strip-types`: no import, no runtime-only TS", () => {
		const source = readFileSync("scripts/ci/review-gate-policy.ts", "utf8")
			.split("\n")
			.filter((line) => !/^\s*\/\//.test(line))
			.join("\n");
		expect(source).not.toMatch(
			/^\s*import\s|\benum\s+\w+|\bnamespace\s+\w+|constructor\s*\([^)]*\b(public|private|protected)\b/m,
		);
	});
});

describe("review-gate.yml: permissions (TRA-520)", () => {
	it("can read workflow runs and checks, and cannot write anything", () => {
		const permissions = code.slice(code.indexOf("    permissions:"), code.indexOf("    env:"));
		for (const read of [
			"contents: read",
			"checks: read",
			"statuses: read",
			"pull-requests: read",
			"actions: read",
		]) {
			expect(permissions).toContain(read);
		}
		expect(permissions).not.toMatch(/:\s*write/);
	});

	it("reads the three lists with pagination and through files, so a flood of check-runs cannot hide the real one", () => {
		expect(code).toContain('gh api --paginate "repos/$REPOSITORY/commits/$SHA/check-runs?check_name=review');
		expect(code).toContain(
			'gh api --paginate "repos/$REPOSITORY/actions/runs?head_sha=$SHA&event=pull_request',
		);
		expect(code).toContain('gh api --paginate "repos/$REPOSITORY/actions/runs/$run_id/jobs?filter=all');
		// Files (--slurpfile), never --argjson of an API answer: the command line has a size limit.
		expect(code).toContain('--slurpfile checks "$api/checks.json"');
		expect(code).toContain('--slurpfile jobs "$api/jobs.json"');
		expect(code).not.toMatch(/--argjson (checks|runs|jobs)\b/);
	});

	it("pins the node release that runs the policy", () => {
		expect(code).toMatch(/node-version: 22\.\d+\.\d+/);
	});
});

// TRA-527 (2026-10-15): `codex-review` / `codex-deep-review` are plain commit statuses, and a status is not bound to
// its author. These tests run the jq program the "Evaluate" step keeps in `select_status`, and the loader step that
// reads the allowed authors, on simulated API answers.
describe("review-gate.yml: codex statuses count only from their expected author (TRA-527)", () => {
	const selectStatusProgram = (): string => {
		const match = /select_status=\$\(cat <<'JQ'\n([\s\S]*?)\nJQ\n\)/.exec(
			stepScript("Evaluate combined review policy"),
		);
		if (match?.[1] === undefined) throw new Error("select_status heredoc not found in review-gate.yml");
		return match[1];
	};

	let statusId = 0;
	const status = (context: string, state: string, login: string | null, createdAt: string) => {
		statusId += 1;
		// Same projection as the workflow's `--jq`: id, context, state, created_at, creator.login.
		return { id: statusId, context, state, created_at: createdAt, creator: { login } };
	};

	/** What the "Evaluate" step computes for one context: a state, or `missing`. */
	async function selectStatus(statuses: unknown[], context: string, allowed: unknown[] = ["raphpool"]) {
		fixture += 1;
		const list = join(scratch, `statuses-${fixture}.json`);
		const authors = join(scratch, `authors-${fixture}.json`);
		stream(list, statuses);
		writeFileSync(authors, JSON.stringify(allowed));
		const { stdout } = await exec("jq", [
			"-nr",
			"--slurpfile",
			"statuses",
			list,
			"--slurpfile",
			"allowed",
			authors,
			"--arg",
			"context",
			context,
			selectStatusProgram(),
		]);
		return stdout.trimEnd();
	}

	const T1 = "2026-10-15T09:00:00Z";
	const T2 = "2026-10-15T09:10:00Z";
	const T3 = "2026-10-15T09:20:00Z";

	it("keeps a status published by an allowed author, for each of the two contexts", async () => {
		const statuses = [
			status("codex-review", "success", "raphpool", T1),
			status("codex-deep-review", "failure", "raphpool", T1),
		];
		expect(await selectStatus(statuses, "codex-review")).toBe("success");
		expect(await selectStatus(statuses, "codex-deep-review")).toBe("failure");
		expect(await selectStatus(statuses, "ci/other")).toBe("missing");
	});

	it("treats a status from another author as absent, whatever its state or date", async () => {
		for (const state of ["success", "failure", "pending", "error"]) {
			const forged = [status("codex-deep-review", state, "someone-else", "2099-01-01T00:00:00Z")];
			expect(await selectStatus(forged, "codex-deep-review")).toBe("missing");
		}
		// A workflow token posts as the Actions bot, and a status can have no creator at all.
		const bot = [status("codex-deep-review", "success", "github-actions[bot]", T1)];
		expect(await selectStatus(bot, "codex-deep-review")).toBe("missing");
		const anonymous = [status("codex-deep-review", "success", null, T1)];
		expect(await selectStatus(anonymous, "codex-deep-review")).toBe("missing");
		const noCreator = [{ context: "codex-deep-review", state: "success" }];
		expect(await selectStatus(noCreator, "codex-deep-review")).toBe("missing");
	});

	it("neither masks nor replaces the real status: the latest one among the allowed authors wins", async () => {
		const real = status("codex-deep-review", "success", "raphpool", T1);
		const forgedFailure = status("codex-deep-review", "failure", "someone-else", T3);
		const forgedSuccess = status("codex-deep-review", "success", "someone-else", T3);
		expect(await selectStatus([forgedFailure, real], "codex-deep-review")).toBe("success");
		expect(await selectStatus([real, forgedSuccess], "codex-deep-review")).toBe("success");
		// The author re-posts: the newest of its own statuses counts, in whatever order the API lists them.
		const repost = status("codex-deep-review", "failure", "raphpool", T2);
		expect(await selectStatus([real, forgedSuccess, repost], "codex-deep-review")).toBe("failure");
		expect(await selectStatus([repost, forgedSuccess, real], "codex-deep-review")).toBe("failure");
		// Same second: the later id wins.
		const first = status("codex-review", "pending", "raphpool", T1);
		const second = status("codex-review", "success", "raphpool", T1);
		expect(await selectStatus([second, first], "codex-review")).toBe("success");
		expect(await selectStatus([first, second], "codex-review")).toBe("success");
	});

	it("compares logins case-insensitively and honors the whole list", async () => {
		const statuses = [status("codex-review", "success", "RaphPool", T1)];
		expect(await selectStatus(statuses, "codex-review")).toBe("success");
		expect(await selectStatus(statuses, "codex-review", ["other", "RAPHPOOL"])).toBe("success");
		expect(await selectStatus(statuses, "codex-review", ["other"])).toBe("missing");
		// An empty list allows nobody.
		expect(await selectStatus(statuses, "codex-review", [])).toBe("missing");
	});

	const policy = async (deep: string): Promise<string> => {
		const input = JSON.stringify({
			paths: [".github/workflows/review-gate.yml"],
			labels: [],
			ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
			deep,
			risk: 1,
		});
		const { stdout } = await exec("npx", ["--no-install", "tsx", "scripts/ci/review-gate-policy.ts", input]);
		return (JSON.parse(stdout) as { verdict: string }).verdict;
	};

	it("a forged `codex-deep-review: success` does not satisfy a tier/3, the genuine one does", async () => {
		const forged = [status("codex-deep-review", "success", "someone-else", T1)];
		const genuineStatus = [status("codex-deep-review", "success", "raphpool", T1)];
		expect(await policy(await selectStatus(forged, "codex-deep-review"))).toBe("wait");
		expect(await policy(await selectStatus(genuineStatus, "codex-deep-review"))).toBe("pass");
		// Control: the old behavior, which took the status whoever posted it, would have passed.
		expect(await policy("success")).toBe("pass");
		// A forged failure cannot hold a legitimate head either.
		const both = [...genuineStatus, status("codex-deep-review", "failure", "someone-else", T3)];
		expect(await policy(await selectStatus(both, "codex-deep-review"))).toBe("pass");
	}, 60_000);

	const loader = () => stepScript("Load the review policy from the default branch");
	const loaderEnv = (runnerTemp: string, defaultBranch = "main") => ({
		PATH: process.env.PATH ?? "",
		RUNNER_TEMP: runnerTemp,
		DEFAULT_BRANCH: defaultBranch,
	});
	const git = (cwd: string, ...args: string[]) =>
		exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd });

	/** A repository whose default branch holds `authors` and whose checked-out branch holds `prAuthors`. */
	async function checkout(name: string, authors: string | null, prAuthors: string) {
		const origin = join(scratch, `${name}-origin.git`);
		const work = join(scratch, `${name}-work`);
		const runnerTemp = join(scratch, `${name}-runner-temp`);
		mkdirSync(runnerTemp);
		await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
		await exec("git", ["clone", origin, work]);
		mkdirSync(join(work, "scripts", "ci"), { recursive: true });
		mkdirSync(join(work, ".github"));
		copyFileSync("scripts/ci/review-gate-policy.ts", join(work, "scripts", "ci", "review-gate-policy.ts"));
		if (authors !== null) writeFileSync(join(work, ".github", "review-gate-authors.txt"), authors);
		await git(work, "add", ".");
		await git(work, "commit", "-m", "main");
		await git(work, "push", "origin", "HEAD:main");
		await git(work, "fetch", "origin");
		await git(work, "checkout", "-b", "pr");
		writeFileSync(join(work, ".github", "review-gate-authors.txt"), prAuthors);
		await git(work, "add", ".");
		await git(work, "commit", "-m", "pr");
		return { work, runnerTemp };
	}

	const loadedAuthors = (runnerTemp: string): unknown =>
		JSON.parse(readFileSync(join(runnerTemp, "review-gate-policy", "authors.json"), "utf8"));

	it("reads the allowed authors from the default branch, so a PR cannot add its own login", async () => {
		const { work, runnerTemp } = await checkout(
			"authors-ok",
			"# comment\nraphpool # trailing\n\n",
			"raphpool\nforger\n",
		);
		await exec("bash", ["-c", loader()], { cwd: work, env: loaderEnv(runnerTemp) });
		expect(loadedAuthors(runnerTemp)).toEqual(["raphpool"]);
	}, 60_000);

	it("ships a list that names the account publishing the real statuses", () => {
		const lines = readFileSync(".github/review-gate-authors.txt", "utf8")
			.split("\n")
			.map((line) => line.replace(/#.*$/, "").trim())
			.filter((line) => line !== "");
		expect(lines).toEqual(["raphpool"]);
	});

	it.each([
		["no list on the default branch", null],
		["an empty list", "# nobody\n"],
		["a malformed login", "raphpool\nnot a login\n"],
		["a login with a separator", "raphpool,forger\n"],
	])(
		"fails closed, and leaves no list behind, with %s",
		async (label, authors) => {
			const { work, runnerTemp } = await checkout(
				`authors-bad-${label.replaceAll(" ", "-")}`,
				authors,
				"raphpool\n",
			);
			// A stale list from a previous job of the same runner must not survive a failed load.
			mkdirSync(join(runnerTemp, "review-gate-policy"));
			writeFileSync(join(runnerTemp, "review-gate-policy", "authors.json"), '["raphpool"]');
			await expect(
				exec("bash", ["-c", loader()], { cwd: work, env: loaderEnv(runnerTemp) }),
			).rejects.toMatchObject({
				code: expect.any(Number),
			});
			expect(existsSync(join(runnerTemp, "review-gate-policy", "authors.json"))).toBe(false);
		},
		60_000,
	);

	it("reads every page of the head's statuses through files, and no longer the combined status", () => {
		expect(code).toContain('gh api --paginate "repos/$REPOSITORY/commits/$SHA/statuses?per_page=100"');
		expect(code).toContain('--slurpfile statuses "$api/statuses.json"');
		expect(code).toContain('--slurpfile allowed "$authors"');
		expect(code).not.toMatch(/commits\/\$SHA\/status["?]/);
		expect(code).not.toMatch(/--argjson (statuses|allowed)\b/);
		expect(code).toContain('git show "origin/$DEFAULT_BRANCH:.github/review-gate-authors.txt"');
	});
});
