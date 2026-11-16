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

/** The `run: |` script of a step, unindented, from its `- name:` line (in review-gate.yml unless `source` is given). */
function stepScript(name: string, source = gate): string {
	const lines = source.split("\n");
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

// The pull request the gate evaluates (TRA-526): what the job reads from the event and passes to the jq program.
const PR = {
	number: 42,
	baseRef: "main",
	headRef: "rdoulonne/tra-1-feature",
	headRepo: "raphpool/odyssey-music",
};

// A workflow run as the job slims it down. `pull_requests` is empty here, as on many real runs: the binding to the
// pull request must not depend on it. Other tests fill it in.
const workflowRun = (id: number, suite: number, overrides: Record<string, unknown> = {}) => ({
	id,
	path: AI_REVIEW,
	event: "pull_request",
	head_sha: HEAD,
	check_suite_id: suite,
	head_branch: PR.headRef,
	head_repository: PR.headRepo,
	pull_requests: [],
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
	/** The pull requests (any state) whose head is the evaluated one; just the evaluated PR by default. */
	pulls?: unknown[];
}

const ownPull = { number: PR.number, base_ref: PR.baseRef, head_sha: HEAD };

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
	const files = (["checks", "runs", "jobs", "pulls"] as const).map((kind) => {
		const path = join(scratch, `${kind}-${fixture}.json`);
		// Like the workflow's files: one JSON value per item, an empty file for an empty list.
		stream(path, kind === "pulls" ? (api.pulls ?? [ownPull]) : api[kind]);
		return path;
	});
	const [checks, runs, jobs, pulls] = files as [string, string, string, string];
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
		"--slurpfile",
		"pulls",
		pulls,
		"--argjson",
		"pr",
		JSON.stringify(PR),
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

// TRA-526 (2026-10-24): a `review` check-run was bound to the head sha, not to the pull request. A PR B opened on the
// same sha as the PR A under evaluation, against another base (the parent of the faulty commit, or a branch whose
// ai-review.yml is weakened), produces a genuine `pull_request` run of ai-review.yml on that sha; a `labeled` event on
// A then re-ran the gate, which kept B's success. `pull_requests[]` is empty on many real runs, so it can only reject
// (a run that names other pull requests), never be required: the binding rests on the head branch, the head
// repository and the list of the pull requests that share the head.
describe("review-gate.yml: the review must be the one of the evaluated pull request (TRA-526)", () => {
	const own = ownPull;
	// A PR against another base on the same head branch and the same sha.
	const otherPr = { number: 77, base_ref: "release/1.0", head_sha: HEAD };
	// The genuine review of PR B: same sha, produced by a real run of ai-review.yml, and it succeeded.
	const reviewOfB = (runOverrides: Record<string, unknown>): Api => ({
		checks: [checkRun(99, 200, { started_at: "2026-10-15T10:00:00Z" })],
		runs: [workflowRun(5200, 200, runOverrides)],
		jobs: [job(99, 5200)],
	});

	it("does not retain the success of a run produced for a PR from another branch on the same sha", async () => {
		const ofB = reviewOfB({ head_branch: "someone/else" });
		expect(await select(ofB)).toBe("0\tmissing");
		// Next to the review of the evaluated PR it never wins, even when it is more recent.
		const failure = genuine(11, 100, { conclusion: "failure", started_at: "2026-10-15T09:00:00Z" });
		expect(await select(merge(failure, ofB))).toBe("11\tfailure");
	});

	it("does not retain the success of a run produced for a fork whose branch has the same name", async () => {
		expect(await select(reviewOfB({ head_repository: "attacker/odyssey-music" }))).toBe("0\tmissing");
		expect(await select(reviewOfB({ head_repository: null }))).toBe("0\tmissing");
	});

	it.each([
		["another PR, against another base", [otherPr]],
		["the evaluated PR and another one against another base", [own, otherPr]],
		["the evaluated number against another base", [{ number: PR.number, base_ref: "release/1.0" }]],
	])("does not retain a run whose pull_requests name %s", async (_label, pullRequests) => {
		expect(await select(reviewOfB({ pull_requests: pullRequests }))).toBe("0\tmissing");
	});

	it("keeps the review of the PR itself, whether the run lists it or lists nothing (as many real runs do)", async () => {
		expect(await select(genuine(11, 100))).toBe("11\tsuccess");
		const listed = { ...genuine(11, 100), runs: [workflowRun(5100, 100, { pull_requests: [own] })] };
		expect(await select(listed)).toBe("11\tsuccess");
		// Another PR against the same base on the same head does not change what the verdict applies to.
		const sameBase = { number: 78, base_ref: PR.baseRef, head_sha: HEAD };
		expect(await select({ ...listed, pulls: [own, sameBase] })).toBe("11\tsuccess");
	});

	it("reports missing when another PR shares the head branch against another base, even if the run lists nothing", async () => {
		// Same branch, so the head branch cannot tell the two runs apart and `pull_requests[]` is empty: unknown.
		// A closed PR counts too: the review it produced stays attached to the sha.
		expect(await select({ ...genuine(11, 100), pulls: [own, otherPr] })).toBe("0\tmissing");
		expect(await select({ ...genuine(11, 100), pulls: [otherPr, own] })).toBe("0\tmissing");
	});

	it("ignores a PR of the same branch name left on an older sha: it says nothing about this one", async () => {
		// E.g. the branch was first opened against a stack parent, closed, then reopened against the default branch.
		const stale = { ...otherPr, head_sha: OTHER_HEAD };
		expect(await select({ ...genuine(11, 100), pulls: [stale, own] })).toBe("11\tsuccess");
		// Whereas a closed PR whose last head is this very sha keeps the head ambiguous.
		expect(await select({ ...genuine(11, 100), pulls: [{ ...otherPr, head_sha: HEAD }, own] })).toBe(
			"0\tmissing",
		);
	});

	it.each([
		["no PR at all", []],
		["only another PR", [{ number: 78, base_ref: "main", head_sha: HEAD }]],
	])(
		"reports missing when the PRs of the head are %s: the evaluated one is not established",
		async (_label, pulls) => {
			expect(await select({ ...genuine(11, 100), pulls })).toBe("0\tmissing");
		},
	);

	it("still judges the latest genuine review of the PR: a re-run of the PR is found, the one of PR B is not", async () => {
		const first = genuine(11, 100, { conclusion: "failure", started_at: "2026-10-15T09:00:00Z" });
		const rerun = {
			checks: [checkRun(12, 100, { conclusion: "success", started_at: "2026-10-15T09:10:00Z" })],
			jobs: [job(12, 5100)],
		};
		const ofB = reviewOfB({ head_branch: "someone/else" });
		expect(await select(merge(first, rerun, ofB))).toBe("12\tsuccess");
		expect(await select(merge(first, ofB))).toBe("11\tfailure");
	});

	it("passes the facts of the event through env, and lists the PRs of the head with pagination", () => {
		for (const name of ["PR_NUMBER", "BASE_REF", "HEAD_REF", "HEAD_REPO"]) expect(code).toContain(`${name}:`);
		expect(code).toContain('gh api --paginate --method GET "repos/$REPOSITORY/pulls"');
		expect(code).toContain('--slurpfile pulls "$api/pulls.json"');
		// A deleted fork leaves no head repository: no request with a filter GitHub could ignore, an empty list.
		expect(code).toMatch(/if \[ -n "\$HEAD_REPO" \]; then\s+gh api --paginate --method GET/);
		// The branch name is chosen by the PR author: it reaches the shell and the query only through variables.
		expect(stepScript("Evaluate combined review policy")).not.toMatch(/\$\{\{[^}]*(\.ref|full_name)/);
	});
});

// TRA-524: the conclusion of the selected check-run reaches the policy, which treats anything but a verdict as
// "no review". The job `review` of ai-review.yml is cancelled by its concurrency group or stopped by its 25-minute
// timeout without any Claude review having completed.
describe("review-gate.yml: only a conclusion that carries a verdict counts as a review (TRA-524)", () => {
	it.each(["success", "failure", "neutral"])("passes the conclusion %s on as it is", async (conclusion) => {
		expect(await select(genuine(11, 100, { conclusion }))).toBe(`11\t${conclusion}`);
	});

	it.each([
		"cancelled",
		"timed_out",
		"skipped",
		"stale",
		"action_required",
		"something_github_adds_later",
		"",
	])("reports the conclusion %j as missing", async (conclusion) => {
		expect(await select(genuine(11, 100, { conclusion }))).toBe("11\tmissing");
	});

	it("judges the latest run: a cancelled re-run does not fall back on the success it replaced", async () => {
		const first = genuine(11, 100, { conclusion: "success", started_at: "2026-10-15T09:00:00Z" });
		const cancelled = genuine(13, 101, { conclusion: "cancelled", started_at: "2026-10-15T09:20:00Z" });
		expect(await select(merge(first, cancelled))).toBe("13\tmissing");
	});

	const verdict = async (claude: string, codex: string): Promise<string> => {
		const input = JSON.stringify({
			paths: ["src/graph.ts"],
			labels: [],
			ordinary: { claude, codex, claudeBlocking: false },
			deep: "missing",
			risk: 1,
		});
		const { stdout } = await exec("npx", ["--no-install", "tsx", "scripts/ci/review-gate-policy.ts", input]);
		return (JSON.parse(stdout) as { verdict: string }).verdict;
	};

	// The selected conclusion is piped into the policy like the job does, with `codex-review: success`.
	it.each(["cancelled", "timed_out", "skipped", "stale", "action_required"])(
		"does not pass a PR whose review check-run is %s, even with codex-review in success",
		async (conclusion) => {
			const [, claude] = (await select(genuine(11, 100, { conclusion }))).split("\t");
			expect(await verdict(claude ?? "", "success")).toBe("wait");
		},
	);

	it("still passes with a Claude review that completed (success, non-blocking failure) and codex-review in success", async () => {
		for (const conclusion of ["success", "failure", "neutral"]) {
			const [, claude] = (await select(genuine(11, 100, { conclusion }))).split("\t");
			expect(await verdict(claude ?? "", "success")).toBe("pass");
		}
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
		expect(lines).toContain("raphpool");
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

// TRA-553: static checks on what the workflows pass to git and to the Claude action. Comment lines are dropped, so
// the explanations next to a flag cannot make a test pass.
describe("review workflows hardening (TRA-553)", () => {
	const uncommented = (path: string): string =>
		readFileSync(path, "utf8")
			.replaceAll("\r\n", "\n")
			.split("\n")
			.filter((line) => !/^\s*#/.test(line))
			.join("\n");
	const aiReview = uncommented(AI_REVIEW);

	/**
	 * The lines of the `claude_args: |` block of the "Review Claude" step, read from the raw file: inside a block
	 * scalar a `#` line is content, so it is an argument for the action and must not be hidden from the checks.
	 */
	const claudeArgs = (): string[] => {
		const lines = readFileSync(AI_REVIEW, "utf8").replaceAll("\r\n", "\n").split("\n");
		const start = lines.findIndex((line) => line.trim() === "claude_args: |");
		if (start === -1) throw new Error("claude_args block not found in ai-review.yml");
		const indent = (lines[start]?.length ?? 0) - (lines[start]?.trimStart().length ?? 0) + 2;
		const body: string[] = [];
		for (const line of lines.slice(start + 1)) {
			if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
			body.push(line.trim());
		}
		return body.filter((line) => line !== "");
	};

	it("restricts the Claude action to the user setting source, so the PR's own config loads nothing", () => {
		// The action defaults to "user,project,local" and takes this value from claude_args (parse-sdk-options.ts).
		expect(claudeArgs()).toContain("--setting-sources user");
		expect(claudeArgs().filter((line) => line.startsWith("--setting-sources"))).toHaveLength(1);
		// No other way to bring the project source back or to point the agent at settings of the PR.
		expect(aiReview).not.toMatch(/--setting-sources[ =][^\n]*(project|local)/);
		expect(aiReview).not.toMatch(/^\s*settings:/m);
		expect(aiReview).not.toMatch(/--settings\b/);
		// Every line of the block is a flag or the value of the previous one: no stray `#` line.
		expect(claudeArgs().filter((line) => line.startsWith("#"))).toEqual([]);
	});

	it("uses only the MCP servers the action adds itself, so a PR's .mcp.json starts nothing", () => {
		// The action keeps `enableAllProjectMcpServers: true` in the user settings it writes, which
		// `--setting-sources user` does not remove: only --strict-mcp-config ignores the project's .mcp.json.
		expect(claudeArgs()).toContain("--strict-mcp-config");
	});

	it("keeps the tool allowlist on the command line, where the project settings cannot widen it", () => {
		expect(claudeArgs().some((line) => line.startsWith("--allowedTools "))).toBe(true);
		expect(aiReview).not.toMatch(/Bash\((npx|gh pr|npm)\b/);
	});

	it.each([".github/workflows/review-gate.yml", ".github/workflows/ci.yml"])(
		"lists the changed paths of %s with --no-renames and -z, on every name-only diff",
		(path) => {
			const calls = uncommented(path).match(/git diff [^\n|)]*--name-only[^\n|)]*/g) ?? [];
			expect(calls.length).toBeGreaterThanOrEqual(1);
			for (const call of calls) {
				expect(call, call).toContain("--no-renames");
				// NUL-separated, so that git does not quote a non-ASCII path (the quote defeats the `^` anchors).
				expect(call, call).toMatch(/git diff -z /);
			}
			expect(uncommented(path)).toContain("tr '\\0' '\\n'");
		},
	);
});

// TRA-529 (2026-10-24): the verdict must have been produced for THIS pull request against the default branch. The
// selection above cannot tell: `pull_requests[]` and `pulls?head=` are recomputed at every read (they show the base a
// PR has NOW), and `pulls?head=` ignores a PR B that left the sha. ai-review.yml therefore writes
// `review-base v1 <pr> <base>` on its job from the event, and the "Evaluate" step reads it on the selected check-run.
// These tests run that step itself, as the job runs it: `gh` serves the simulated API answers, `git` and `sleep` do
// nothing, `seq` makes one attempt of the 24, and `node` runs the real policy through tsx (the repository tests run on
// node 20, which has no type stripping).
describe("review-gate.yml: the review must have been produced for this PR against the default branch (TRA-529)", () => {
	const REPO = "raphpool/odyssey-music";
	const BASE_COMMIT = "a".repeat(40);
	const base = (number: number, baseRef: string): string => `review-base v1 ${number} ${baseRef}`;
	const OWN_RECORD = base(PR.number, PR.baseRef);
	const PATCH_RECORD = `review-patch-id v1 ${"1".repeat(40)}-${"2".repeat(40)}`;
	const BLOCKING = "Findings bloquants — voir les commentaires inline.";

	const bin = join(scratch, "tra529-bin");
	mkdirSync(bin);
	const tool = (name: string, body: string): void => {
		writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
	};
	// `--jq` is not applied: the fixtures are already what the projections produce.
	tool(
		"gh",
		`shift
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq|--method|-f|-X|-H) shift 2 ;;
    --paginate) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "$FIXTURES/calls.log"
case "$url" in
  */annotations*) id="\${url#*check-runs/}"; f="annotations-\${id%%/*}" ;;
  */issues/*/labels*) f=labels ;;
  */commits/*/check-runs*) f=checks ;;
  */commits/*/statuses*) f=statuses ;;
  */actions/runs/*/jobs*) id="\${url#*actions/runs/}"; f="jobs-\${id%%/*}" ;;
  */actions/runs\\?*) f=runs ;;
  */pulls) f=pulls ;;
  *) echo "fake gh: unexpected $url" >&2; exit 1 ;;
esac
if [ -f "$FIXTURES/$f.json" ]; then cat "$FIXTURES/$f.json"; fi`,
	);
	tool("git", `if [ "$1" = diff ]; then printf 'src/graph.ts\\0'; fi`);
	tool("sleep", "exit 0");
	tool("seq", "echo 1");
	// tsx is itself a node script (`#!/usr/bin/env node`): it is started by the real node, or this shim would call itself.
	tool(
		"node",
		'while case "$1" in --*) true ;; *) false ;; esac; do shift; done\nexec "$REAL_NODE" "$TSX" "$@"',
	);

	interface Scenario {
		api: Api;
		/** Annotations (messages) of each check-run, by check-run id. */
		notes?: Record<number, string[]>;
		/** The facts of the event; the PR of the other tests by default. */
		pr?: { number: number; baseRef: string };
		defaultBranch?: string;
	}

	/** The "Evaluate" step on simulated API answers: its exit code, its output, and the API paths it requested. */
	async function evaluate({ api, notes = {}, pr = PR, defaultBranch = "main" }: Scenario) {
		fixture += 1;
		const dir = join(scratch, `tra529-${fixture}`);
		const fx = join(dir, "fixtures");
		const runnerTemp = join(dir, "runner-temp");
		mkdirSync(fx, { recursive: true });
		mkdirSync(join(runnerTemp, "review-gate-policy"), { recursive: true });
		copyFileSync(
			"scripts/ci/review-gate-policy.ts",
			join(runnerTemp, "review-gate-policy", "review-gate-policy.ts"),
		);
		writeFileSync(join(runnerTemp, "review-gate-policy", "authors.json"), JSON.stringify(["raphpool"]));
		stream(join(fx, "checks.json"), api.checks);
		stream(join(fx, "runs.json"), api.runs);
		stream(join(fx, "pulls.json"), api.pulls ?? [{ ...ownPull, number: pr.number, base_ref: pr.baseRef }]);
		stream(join(fx, "statuses.json"), [
			{
				id: 1,
				context: "codex-review",
				state: "success",
				created_at: "2026-10-15T09:30:00Z",
				creator: { login: "raphpool" },
			},
		]);
		writeFileSync(join(fx, "labels.json"), "");
		for (const runId of new Set((api.jobs as { run_id: number }[]).map((j) => j.run_id))) {
			stream(
				join(fx, `jobs-${runId}.json`),
				api.jobs.filter((j) => (j as { run_id: number }).run_id === runId),
			);
		}
		for (const [id, messages] of Object.entries(notes)) {
			stream(
				join(fx, `annotations-${id}.json`),
				messages.map((message) => ({ message })),
			);
		}
		// The three expressions the script interpolates (`${{ … }}` is not shell): the base commit and the PR number.
		const script = stepScript("Evaluate combined review policy")
			.replaceAll(expr("github.event.pull_request.base.sha"), BASE_COMMIT)
			.replaceAll(expr("github.event.pull_request.number"), String(pr.number));
		expect(script).not.toContain("${{");
		const env = {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			RUNNER_TEMP: runnerTemp,
			FIXTURES: fx,
			REAL_NODE: process.execPath,
			TSX: join(process.cwd(), "node_modules", ".bin", "tsx"),
			GH_TOKEN: "test",
			REPOSITORY: REPO,
			SHA: HEAD,
			DEFAULT_BRANCH: defaultBranch,
			PR_NUMBER: String(pr.number),
			BASE_REF: pr.baseRef,
			HEAD_REF: PR.headRef,
			HEAD_REPO: PR.headRepo,
		};
		const done = await exec("bash", ["-c", script], { env, timeout: 25_000, killSignal: "SIGKILL" }).then(
			({ stdout }) => ({ code: 0, stdout }),
			(error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
		);
		const calls = existsSync(join(fx, "calls.log"))
			? readFileSync(join(fx, "calls.log"), "utf8").split("\n")
			: [];
		return { ...done, calls: calls.filter((call) => call !== "") };
	}

	const passes = (outcome: { code: number; stdout: string }): boolean =>
		outcome.code === 0 && outcome.stdout.includes('"verdict":"pass"');

	it("passes a review that recorded this PR against the default branch (control)", async () => {
		const outcome = await evaluate({ api: genuine(11, 100), notes: { 11: [OWN_RECORD, PATCH_RECORD] } });
		expect(passes(outcome), outcome.stdout).toBe(true);
	}, 30_000);

	// Criterion 2 of the ticket, and the scenario of its description: the review ran against the stack parent `x`,
	// then the PR was retargeted to main (`pull_requests[]` and `pulls?head=` now say main) and updated.
	it("does not retain a review produced against another base, once the PR targets the default branch", async () => {
		const api = genuine(11, 100);
		// The selection of TRA-526 alone retains it: this is the gap the record closes.
		expect(await select(api)).toBe("11\tsuccess");
		const outcome = await evaluate({ api, notes: { 11: [base(PR.number, "feature/x"), PATCH_RECORD] } });
		expect(passes(outcome)).toBe(false);
		expect(outcome.code).toBe(1);
		expect(outcome.stdout).toContain("n'a pas enregistré cette PR contre la branche par défaut");
		expect(outcome.stdout).toContain("Aucun fournisseur");
	}, 30_000);

	// The nit of the review of TRA-526: B (same branch, base `evil`) got a genuine success on this sha, moved to
	// another sha and was closed; the sha came back through a force-push and A was opened on it, ready.
	it.each([
		["against its own base", base(77, "evil")],
		["on main too", base(77, "main")],
	])(
		"does not retain the review of a closed PR of the same branch left on another sha (%s)",
		async (_label, record) => {
			const closedB = { number: 77, base_ref: "evil", head_sha: OTHER_HEAD };
			const api = { ...genuine(99, 200), pulls: [closedB, ownPull] };
			expect(await select(api)).toBe("99\tsuccess");
			const outcome = await evaluate({ api, notes: { 99: [record, PATCH_RECORD] } });
			expect(passes(outcome)).toBe(false);
			expect(outcome.stdout).toContain("n'a pas enregistré cette PR");
			// Control: the same listing with the record of A passes.
			expect(passes(await evaluate({ api, notes: { 99: [OWN_RECORD, PATCH_RECORD] } }))).toBe(true);
		},
		60_000,
	);

	it("treats a review from before TRA-529 (no base record) as missing, and says how to get a new one", async () => {
		const outcome = await evaluate({ api: genuine(11, 100), notes: { 11: [PATCH_RECORD] } });
		expect(passes(outcome)).toBe(false);
		expect(outcome.stdout).toContain("::warning::La review (check-run 11)");
		expect(outcome.stdout).toContain("fermer puis rouvrir la PR");
	}, 30_000);

	it("does not pass a stacked PR, even with the record of its own base: only a review against the default branch counts", async () => {
		const pr = { number: PR.number, baseRef: "feature/parent" };
		const outcome = await evaluate({
			api: genuine(11, 100),
			pr,
			notes: { 11: [base(pr.number, pr.baseRef)] },
		});
		expect(passes(outcome)).toBe(false);
	}, 30_000);

	it.each([
		["two different records", [OWN_RECORD, base(PR.number, "feature/x")]],
		["the record of this PR and of another one", [OWN_RECORD, base(43, "main")]],
		["a record of another version next to the v1", [OWN_RECORD, `review-base v2 ${PR.number} main`]],
		["a record that is not the exact message", [`review-base v1 0${PR.number} main`]],
	])(
		"does not retain a review with %s",
		async (_label, records) => {
			expect(passes(await evaluate({ api: genuine(11, 100), notes: { 11: records } }))).toBe(false);
		},
		30_000,
	);

	it("judges the latest review: a newer one without record does not fall back on the older one that has it", async () => {
		const older = genuine(11, 100, { started_at: "2026-10-15T09:00:00Z" });
		const newer = genuine(12, 101, { started_at: "2026-10-15T10:00:00Z" });
		const outcome = await evaluate({
			api: merge(older, newer) as Api,
			notes: { 11: [OWN_RECORD], 12: [PATCH_RECORD] },
		});
		expect(passes(outcome)).toBe(false);
		expect(outcome.stdout).toContain("check-run 12");
		// And the other way round, the newer one with the record is the review.
		const both = await evaluate({
			api: merge(older, newer) as Api,
			notes: { 11: [PATCH_RECORD], 12: [OWN_RECORD] },
		});
		expect(passes(both)).toBe(true);
	}, 60_000);

	// TRA-524 and the blocking path keep working: a failure carries the record too (it is the first step of the job).
	it("still blocks on a blocking review that recorded this PR, and only reads the annotations of the selected check-run", async () => {
		const outcome = await evaluate({
			api: genuine(11, 100, { conclusion: "failure" }),
			notes: { 11: [OWN_RECORD, BLOCKING] },
		});
		expect(outcome.code).toBe(1);
		expect(outcome.stdout).toContain("Un fournisseur de review a détecté des findings bloquants");
		expect(outcome.calls.filter((call) => call.includes("/annotations"))).toEqual([
			`repos/${REPO}/check-runs/11/annotations?per_page=100`,
		]);
	}, 30_000);

	it("does not let a blocking review without a record block: it is no review, as for a success", async () => {
		const outcome = await evaluate({
			api: genuine(11, 100, { conclusion: "failure" }),
			notes: { 11: [BLOCKING] },
		});
		expect(outcome.stdout).not.toContain("findings bloquants");
		expect(passes(outcome)).toBe(false);
	}, 30_000);

	it("still passes a failure that is not blocking when it recorded this PR, as before", async () => {
		const outcome = await evaluate({
			api: genuine(11, 100, { conclusion: "failure" }),
			notes: { 11: [OWN_RECORD, "Error: something else"] },
		});
		expect(passes(outcome), outcome.stdout).toBe(true);
	}, 30_000);

	it("reads no annotations while no review has a verdict", async () => {
		const outcome = await evaluate({
			api: genuine(11, 100, { conclusion: null }),
			notes: { 11: [OWN_RECORD] },
		});
		expect(passes(outcome)).toBe(false);
		expect(outcome.calls.some((call) => call.includes("/annotations"))).toBe(false);
	}, 30_000);

	it("reads the annotations with pagination and through a file, and checks the base before the policy runs", () => {
		const evaluateStep = stepScript("Evaluate combined review policy");
		expect(code).toContain(
			'gh api --paginate "repos/$REPOSITORY/check-runs/$claude_id/annotations?per_page=100"',
		);
		expect(code).toContain('--slurpfile notes "$api/annotations.json"');
		expect(code).toContain(`DEFAULT_BRANCH: ${expr("github.event.repository.default_branch")}`);
		expect(evaluateStep.indexOf('"$validate_base"')).toBeGreaterThan(
			evaluateStep.indexOf('"$select_review"'),
		);
		expect(evaluateStep.indexOf('"$validate_base"')).toBeLessThan(
			evaluateStep.indexOf("node --experimental-strip-types"),
		);
		// Fail closed: a review that does not validate is `missing` with no id, never left as read.
		expect(evaluateStep).toMatch(/claude=missing\s+claude_id=0/);
	});
});

// TRA-754 (2026-11-16): the jobs that run the deep review (comment lines dropped, as elsewhere in this file).
describe("ai-review.yml: the `deep-review` jobs (TRA-754)", () => {
	const raw = readFileSync(AI_REVIEW, "utf8").replaceAll("\r\n", "\n");
	const uncommented = raw
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
	const jobOf = (key: string): string =>
		uncommented.split(/\n(?= {2}[a-z][a-z-]*:\n)/).find((part) => part.startsWith(`  ${key}:\n`)) ?? "";
	const [reviewJob = "", tierJob = "", deepJob = ""] = ["review", "deep-review-tier", "deep-review"].map(
		jobOf,
	);
	const steps = (job: string): string[] => job.split("\n      - ").slice(1);
	const permissions = (job: string): string =>
		job.slice(job.indexOf("    permissions:"), job.indexOf("    steps:"));

	// Fail closed: a `deep-review` that succeeded without reviewing would be read `success` once a `tier/3` label appears.
	it("is skipped, never run, below tier 3 or when the tier job fails, and has no step that can be skipped", () => {
		expect(deepJob).toContain("\n    needs: deep-review-tier\n");
		expect(deepJob).toContain("&& needs.deep-review-tier.outputs.tier == '3'\n");
		expect(tierJob).toContain(`tier: ${expr("steps.tier.outputs.tier")}`);
		// A status function or continue-on-error would run it anyway or hide a failure; a step `if` would skip a step.
		expect(tierJob + deepJob).not.toMatch(/always\(|failure\(|cancelled\(|success\(|continue-on-error/);
		expect(steps(deepJob).join("\n")).not.toMatch(/\bif:/);
	});

	it("computes the tier with the default branch's classifier on the gate's paths, the module path not in argv", () => {
		expect(tierJob).toContain('git show "origin/$DEFAULT_BRANCH:scripts/ci/review-gate-policy.ts"');
		expect(tierJob).toContain("git diff -z --name-only --no-renames");
		// 2026-11-16: the policy runs its CLI when argv[1] ends with its own name; a path in argv made the import throw.
		expect(tierJob).toContain("import(process.env.POLICY)");
		expect(tierJob).not.toContain("process.argv");
	});

	it("runs on hosted runners, with the permissions of `review`, and writes its review-base record first", () => {
		for (const job of [tierJob, deepJob]) expect(job).toContain("    runs-on: ubuntu-latest\n");
		expect(permissions(deepJob)).toBe(permissions(reviewJob));
		const record = steps(reviewJob).find((step) => step.startsWith("name: Record the pull request"));
		expect(record).toContain("::notice::review-base v1 $PR_NUMBER $BASE_REF");
		expect(steps(deepJob)[0]).toBe(record);
	});

	it("reviews with the default branch's rubric, never reuses a verdict, and keeps the hardening of `review`", () => {
		expect(deepJob).toContain('git show "origin/$DEFAULT_BRANCH:REVIEW.md"');
		expect(deepJob).toContain(`claude_code_oauth_token: ${expr("secrets.CLAUDE_CODE_OAUTH_TOKEN")}`);
		// The whole `claude_args` block (model, tools, setting sources, MCP) is the one of `review`, which TRA-553 hardened.
		const args = (job: string) => /claude_args: \|\n((?: {12}\S.*\n)+)/.exec(job)?.[1];
		expect(args(deepJob)).toContain("--allowedTools");
		expect(args(deepJob)).toBe(args(reviewJob));
		expect(deepJob).not.toMatch(/reuse|patch-id|steps\.decide/i);
	});

	// The "Gate on the deep verdict" step, run as the job runs it: any doubt is a failed job.
	const ok = { verdict: "pass", blocking: 0, nits: 0, summary: "ok", findings: [] };
	const json = JSON.stringify;
	it.each([
		["passes a pass verdict with no blocking finding", json(ok), true],
		["fails on no verdict file", undefined, false],
		["fails on a verdict that is not JSON", "not json", false],
		["fails on a block verdict", json({ ...ok, verdict: "block", blocking: 1 }), false],
		["fails on a pass verdict that counts a blocking finding", json({ ...ok, blocking: 1 }), false],
		[
			"fails on a pass verdict that lists a block finding",
			json({ ...ok, findings: [{ severity: "block" }] }),
			false,
		],
		["fails on a verdict with no counts", json({ verdict: "pass" }), false],
	])("%s", async (_label, content, succeeds) => {
		fixture += 1;
		const dir = join(scratch, `deep-verdict-${fixture}`);
		mkdirSync(dir);
		if (content !== undefined) writeFileSync(join(dir, "deep-review.json"), content);
		const env = { PATH: process.env.PATH ?? "", RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, "s.md") };
		const script = stepScript("Gate on the deep verdict", raw);
		expect(
			await exec("bash", ["-e", "-c", script], { env }).then(
				() => true,
				() => false,
			),
		).toBe(succeeds);
	});
});
