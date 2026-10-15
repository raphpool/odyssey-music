import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	AI_REVIEW_PATH,
	BLOCKING_ANNOTATION,
	type DecisionInput,
	decideReuse,
	type Facts,
	latestReview,
	MAX_PAGES,
	PAGE_SIZE,
	RECORD_PREFIX,
	type ReviewCheckRun,
	recordMessage,
	resolveDecision,
	reuseMessage,
	type WorkflowJob,
	type WorkflowRun,
} from "../scripts/ci/review-reuse.js";

const PREVIOUS = "a".repeat(40);
const PATCH = `${"1".repeat(40)}-${"2".repeat(40)}`;
const OTHER_PATCH = `${"3".repeat(40)}-${"2".repeat(40)}`;
const LATER = "2026-10-15T11:00:00Z";

const SUITE = 100;
const RUN_ID = 5100;

// TRA-525: a `review` check-run only counts when it is the job of a `pull_request` run of ai-review.yml on the
// previous head. `run`, `workflowRun` and `job` below are the three records that, together, make one genuine review.
const run = (overrides: Partial<ReviewCheckRun> = {}): ReviewCheckRun => ({
	id: 7,
	name: "review",
	status: "completed",
	conclusion: "success",
	startedAt: "2026-10-15T10:00:00Z",
	appSlug: "github-actions",
	headSha: PREVIOUS,
	checkSuiteId: SUITE,
	...overrides,
});

const workflowRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
	id: RUN_ID,
	path: AI_REVIEW_PATH,
	event: "pull_request",
	headSha: PREVIOUS,
	checkSuiteId: SUITE,
	...overrides,
});

const job = (overrides: Partial<WorkflowJob> = {}): WorkflowJob => ({
	id: 7,
	name: "review",
	runId: RUN_ID,
	...overrides,
});

/** Several genuine reviews of the previous head: each check-run comes with the job of the same id. */
const genuine = (...runs: ReviewCheckRun[]): Partial<DecisionInput> => ({
	checkRuns: runs,
	jobs: runs.map((r) => job({ id: r.id })),
});

// What the workflow establishes before asking: a first-attempt synchronize on a PR against the default branch,
// whose head is the update-branch merge of a previous head that left .github/ alone.
const facts = (overrides: Partial<Facts> = {}): Facts => ({
	action: "synchronize",
	runAttempt: 1,
	patchId: PATCH,
	previousSha: PREVIOUS,
	baseRef: "main",
	defaultBranch: "main",
	previousLeavesWorkflowsAlone: true,
	headIsUpdateMerge: true,
	...overrides,
});

const input = (overrides: Partial<DecisionInput> = {}): DecisionInput => ({
	...facts(),
	checkRuns: [run()],
	workflowRuns: [workflowRun()],
	jobs: [job()],
	annotations: [recordMessage(PATCH)],
	...overrides,
});

const evidenceOf = (value: DecisionInput) => ({
	checkRuns: value.checkRuns ?? [],
	workflowRuns: value.workflowRuns ?? [],
	jobs: value.jobs ?? [],
});

describe("decideReuse (TRA-510, TRA-525)", () => {
	it("reuses the verdict: synchronize, same patch-id, previous review succeeded without blocking findings", () => {
		expect(decideReuse(input())).toEqual({
			decision: "reuse",
			reason: `verdict réutilisé de ${PREVIOUS}, patch-id ${PATCH}`,
			previousSha: PREVIOUS,
			patchId: PATCH,
		});
	});

	// Each case below must cost a full review: a different diff, a review that is not a clean success,
	// no review at all, an event that always reviews, and every input that cannot be trusted (fail closed).
	const full: [string, Partial<DecisionInput>][] = [
		["patch-id differs", { annotations: [recordMessage(OTHER_PATCH)] }],
		["previous review failed", { checkRuns: [run({ conclusion: "failure" })] }],
		["previous review cancelled", { checkRuns: [run({ conclusion: "cancelled" })] }],
		["previous review timed out", { checkRuns: [run({ conclusion: "timed_out" })] }],
		["previous review unfinished", { checkRuns: [run({ status: "in_progress", conclusion: null })] }],
		[
			"success carrying the blocking annotation",
			{ annotations: [recordMessage(PATCH), BLOCKING_ANNOTATION] },
		],
		["no previous review", { checkRuns: [] }],
		["only other check-runs", { checkRuns: [run({ name: "typecheck" })] }],
		["ready_for_review", { action: "ready_for_review" }],
		["reopened", { action: "reopened" }],
		["opened", { action: "opened" }],
		["re-run of the workflow", { runAttempt: 2 }],
		["unknown run attempt", { runAttempt: null }],
		["PR stacked on another branch", { baseRef: "feature/parent" }],
		["unknown default branch", { defaultBranch: "" }],
		["previous head modifies .github/", { previousLeavesWorkflowsAlone: false }],
		["previous head's .github/ not checkable", { previousLeavesWorkflowsAlone: null }],
		["head is not a merge (plain commit)", { headIsUpdateMerge: false }],
		["head's merge not checkable", { headIsUpdateMerge: null }],
		["listing failed", { checkRuns: null }],
		["workflow runs listing failed", { workflowRuns: null }],
		["jobs listing failed", { jobs: null }],
		["annotations unreadable", { annotations: null }],
		["no patch-id computed", { patchId: null }],
		["malformed patch-id", { patchId: "not-a-patch-id" }],
		["previous head unknown", { previousSha: null }],
		["previous head malformed", { previousSha: "abc123" }],
		["previous review recorded nothing", { annotations: [] }],
		["record with garbage", { annotations: [`${RECORD_PREFIX}garbage`] }],
		["record of another version", { annotations: [`review-patch-id v0 ${PATCH}`] }],
		["two different records", { annotations: [recordMessage(PATCH), recordMessage(OTHER_PATCH)] }],
		["review not published by Actions", { checkRuns: [run({ appSlug: "some-other-app" })] }],
		["review without app", { checkRuns: [run({ appSlug: null })] }],
		// TRA-525: the rule of review-gate.yml (TRA-520). The name and the app are forgeable by any workflow step.
		["review that is no job at all (created through the API)", { jobs: [] }],
		["review with the id of no job of the run", { jobs: [job({ id: 8 })] }],
		["no run of ai-review.yml", { workflowRuns: [] }],
		["run of another workflow", { workflowRuns: [workflowRun({ path: ".github/workflows/other.yml" })] }],
		[
			"run of ai-review.yml from another ref (path with a suffix)",
			{ workflowRuns: [workflowRun({ path: `${AI_REVIEW_PATH}@refs/heads/main` })] },
		],
		["run that is not a pull_request one", { workflowRuns: [workflowRun({ event: "push" })] }],
		["run on another sha", { workflowRuns: [workflowRun({ headSha: "d".repeat(40) })] }],
		[
			"two genuine reviews that started together (the gate cannot tell which it reads)",
			genuine(run({ id: 1 }), run({ id: 2, conclusion: "failure" })),
		],
	];
	it.each(full)("runs a full review: %s", (_label, overrides) => {
		expect(decideReuse(input(overrides)).decision).toBe("full");
	});

	it("judges the last genuine review by start time, like review-gate.yml does", () => {
		const failedLater = genuine(run({ id: 1 }), run({ id: 2, conclusion: "failure", startedAt: LATER }));
		expect(decideReuse(input(failedLater)).decision).toBe("full");
		const succeededLater = genuine(run({ id: 1, conclusion: "failure" }), run({ id: 2, startedAt: LATER }));
		expect(decideReuse(input(succeededLater)).decision).toBe("reuse");
		expect(latestReview(PREVIOUS, evidenceOf(input(succeededLater)))?.id).toBe(2);
	});

	it("accepts the same record twice (a reused review records it again)", () => {
		expect(decideReuse(input({ annotations: [recordMessage(PATCH), recordMessage(PATCH)] })).decision).toBe(
			"reuse",
		);
	});
});

const checkRunsBody = (runs: ReviewCheckRun[], total = runs.length) => ({
	total_count: total,
	check_runs: runs.map((r) => ({
		id: r.id,
		name: r.name,
		status: r.status,
		conclusion: r.conclusion,
		started_at: r.startedAt,
		head_sha: r.headSha,
		app: r.appSlug && { slug: r.appSlug },
		check_suite: { id: r.checkSuiteId },
	})),
});

const runsBody = (runs: WorkflowRun[], total = runs.length) => ({
	total_count: total,
	workflow_runs: runs.map((r) => ({
		id: r.id,
		path: r.path,
		event: r.event,
		head_sha: r.headSha,
		check_suite_id: r.checkSuiteId,
	})),
});

const jobsBody = (jobs: WorkflowJob[], total = jobs.length) => ({
	total_count: total,
	jobs: jobs.map((j) => ({ id: j.id, name: j.name, run_id: j.runId })),
});

const annotationsBody = (messages: string[]) => messages.map((message) => ({ message }));

type Answer = unknown | ((path: string) => unknown);

/** A GitHub API stub: the answer of the first key contained in the requested path; Errors are thrown. */
const fakeApi = (answers: Record<string, Answer>) => {
	const paths: string[] = [];
	const get = async (path: string): Promise<unknown> => {
		paths.push(path);
		const key = Object.keys(answers).find((candidate) => path.includes(candidate));
		const found = key === undefined ? new Error("GitHub API answered 404") : answers[key];
		const answer = typeof found === "function" ? found(path) : found;
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { get, paths };
};

const ctx = (
	get: (path: string) => Promise<unknown>,
	overrides: Partial<Facts & { repository: string }> = {},
) => ({
	...facts(),
	repository: "raphpool/odyssey-music",
	get,
	...overrides,
});

describe("resolveDecision (API lookups)", () => {
	const listing = `commits/${PREVIOUS}/check-runs`;
	const runsListing = `actions/runs?head_sha=${PREVIOUS}&event=pull_request`;
	const jobsListing = `actions/runs/${RUN_ID}/jobs`;
	const happy = (): Record<string, Answer> => ({
		[listing]: checkRunsBody([run()]),
		[runsListing]: runsBody([workflowRun()]),
		[jobsListing]: jobsBody([job()]),
		"check-runs/7/annotations": annotationsBody([recordMessage(PATCH)]),
	});

	it("reads the previous head's review, the run and the job that produced it, and its annotations", async () => {
		const api = fakeApi(happy());
		expect((await resolveDecision(ctx(api.get))).decision).toBe("reuse");
		const repo = "repos/raphpool/odyssey-music";
		expect(api.paths[0]).toContain(`${repo}/${listing}?check_name=review&filter=all`);
		expect(api.paths[1]).toContain(`${repo}/${runsListing}`);
		expect(api.paths[2]).toContain(`${repo}/${jobsListing}?filter=all`);
		expect(api.paths[3]).toContain(`${repo}/check-runs/7/annotations`);
		expect(api.paths).toHaveLength(4);
	});

	it("only asks for the jobs of runs of ai-review.yml that own a listed check-run", async () => {
		const api = fakeApi({
			...happy(),
			[runsListing]: runsBody([
				workflowRun({ id: 1, path: ".github/workflows/other.yml" }),
				workflowRun({ id: 2, checkSuiteId: 555 }),
				workflowRun(),
			]),
		});
		expect((await resolveDecision(ctx(api.get))).decision).toBe("reuse");
		expect(api.paths.filter((path) => path.includes("/jobs"))).toHaveLength(1);
	});

	const firstCheck = checkRunsBody([run()]).check_runs[0];
	const firstRun = runsBody([workflowRun()]).workflow_runs[0];
	it.each([
		["the listing call fails", { [listing]: new Error("GitHub API answered 503") }],
		["the runs call fails", { [runsListing]: new Error("GitHub API answered 403") }],
		["the jobs call fails", { [jobsListing]: new Error("GitHub API answered 502") }],
		["the annotations call fails", { "check-runs/7/annotations": new Error("GitHub API answered 500") }],
		["the listing has the wrong shape", { [listing]: { total_count: 1, check_runs: "nope" } }],
		["the listing has no total", { [listing]: { check_runs: [] } }],
		[
			"a check-run has no start time",
			{ [listing]: { total_count: 1, check_runs: [{ id: 1, name: "review", status: "x" }] } },
		],
		[
			"a check-run has no check suite",
			{ [listing]: { total_count: 1, check_runs: [{ ...firstCheck, check_suite: null }] } },
		],
		[
			"a run has no check suite",
			{ [runsListing]: { total_count: 1, workflow_runs: [{ ...firstRun, check_suite_id: undefined }] } },
		],
		["a job has no run", { [jobsListing]: { total_count: 1, jobs: [{ id: 7, name: "review" }] } }],
		[
			"the annotations page is full (a blocking one could be on the next page)",
			{
				"check-runs/7/annotations": annotationsBody([
					recordMessage(PATCH),
					...Array(PAGE_SIZE - 1).fill("notice"),
				]),
			},
		],
	])("runs a full review when %s", async (_label, answers) => {
		expect((await resolveDecision(ctx(fakeApi({ ...happy(), ...answers }).get))).decision).toBe("full");
	});

	it("does not fetch annotations of a review that did not succeed", async () => {
		const api = fakeApi({ ...happy(), [listing]: checkRunsBody([run({ conclusion: "failure" })]) });
		expect((await resolveDecision(ctx(api.get))).decision).toBe("full");
		expect(api.paths.some((path) => path.includes("/annotations"))).toBe(false);
	});

	// Criterion of TRA-525: a `review` check-run created through the API (or by another workflow, on another
	// branch) on the previous head, with a valid record, must not make the next head inherit a verdict.
	it("runs a full review for a forged check-run with a valid record, without reading its annotations", async () => {
		const forged = run({ id: 99, startedAt: LATER });
		const noGenuineRun: WorkflowRun[][] = [
			[],
			[workflowRun({ event: "push" })],
			[workflowRun({ path: ".github/workflows/x.yml" })],
		];
		for (const runs of noGenuineRun) {
			const api = fakeApi({
				...happy(),
				[listing]: checkRunsBody([forged]),
				[runsListing]: runsBody(runs),
				"check-runs/99/annotations": annotationsBody([recordMessage(PATCH)]),
			});
			expect((await resolveDecision(ctx(api.get))).decision).toBe("full");
			expect(api.paths.some((path) => path.includes("/annotations"))).toBe(false);
		}
	});

	it("follows the pagination of every listing to the end", async () => {
		const flood = Array.from({ length: PAGE_SIZE }, (_, i) => run({ id: 1000 + i, startedAt: LATER }));
		const pages = (key: string, first: unknown[], second: unknown[], total: number) => (path: string) => ({
			total_count: total,
			[key]: /[?&]page=1$/.test(path) ? first : second,
		});
		const api = fakeApi({
			...happy(),
			[listing]: pages(
				"check_runs",
				checkRunsBody(flood).check_runs,
				checkRunsBody([run()]).check_runs,
				PAGE_SIZE + 1,
			),
			[runsListing]: pages(
				"workflow_runs",
				runsBody([workflowRun({ id: 1, event: "push" })]).workflow_runs,
				runsBody([workflowRun()]).workflow_runs,
				2,
			),
		});
		expect((await resolveDecision(ctx(api.get))).decision).toBe("reuse");
		expect(api.paths.filter((path) => path.includes(listing))).toHaveLength(2);
	});

	it.each([
		["a page is missing (total_count never reached)", () => ({ total_count: 3, check_runs: [] })],
		[`there are more than ${MAX_PAGES} pages`, () => checkRunsBody([run()], PAGE_SIZE * (MAX_PAGES + 5))],
	])("runs a full review when %s", async (_label, answer) => {
		const api = fakeApi({ ...happy(), [listing]: answer });
		expect((await resolveDecision(ctx(api.get))).decision).toBe("full");
		expect(api.paths.length).toBeLessThanOrEqual(MAX_PAGES);
	});

	it.each([
		{ action: "ready_for_review" },
		{ action: "reopened" },
		{ patchId: null },
		{ previousSha: null },
		{ runAttempt: 2 },
		{ baseRef: "feature/parent" },
		{ previousLeavesWorkflowsAlone: false },
		{ headIsUpdateMerge: false },
		{ repository: "not a repository" },
	])("never calls the API when the answer is already full (%j)", async (overrides) => {
		const api = fakeApi({});
		expect((await resolveDecision(ctx(api.get, overrides))).decision).toBe("full");
		expect(api.paths).toHaveLength(0);
	});
});

// TRA-525: the selection must be the one review-gate.yml makes. Scenarios are written as the GitHub API returns
// them, run through the jq program the gate executes (once TRA-520 has put it on the default branch) and through
// resolveDecision; both must agree on whether the genuine review is the one that counts.
describe("the selection is the one of review-gate.yml", () => {
	const exec = promisify(execFile);
	const gateWorkflow = readFileSync(".github/workflows/review-gate.yml", "utf8").replaceAll("\r\n", "\n");

	const gateProgram = (): string | null => {
		const lines = gateWorkflow.split("\n");
		const start = lines.findIndex((line) => line.includes("select_review=$(cat <<'JQ'"));
		if (start === -1) return null;
		const end = lines.findIndex((line, index) => index > start && line.trim() === "JQ");
		if (end === -1) throw new Error("unterminated select_review heredoc in review-gate.yml");
		return lines.slice(start + 1, end).join("\n");
	};

	type Item = Record<string, unknown>;
	interface Api {
		checks: Item[];
		runs: Item[];
		jobs: Item[];
	}

	const apiCheck = (id: number, suite: number, overrides: Item = {}): Item => ({
		id,
		name: "review",
		status: "completed",
		conclusion: "success",
		started_at: "2026-10-15T09:00:00Z",
		head_sha: PREVIOUS,
		app: { slug: "github-actions" },
		check_suite: { id: suite },
		...overrides,
	});
	const apiRun = (id: number, suite: number, overrides: Item = {}): Item => ({
		id,
		path: AI_REVIEW_PATH,
		event: "pull_request",
		head_sha: PREVIOUS,
		check_suite_id: suite,
		...overrides,
	});
	const apiJob = (id: number, runId: number, overrides: Item = {}): Item => ({
		id,
		name: "review",
		run_id: runId,
		...overrides,
	});
	/** The genuine `review` of a run of ai-review.yml: its check-run, its run, its job. */
	const reviewOf = (id: number, suite: number, overrides: Item = {}): Api => ({
		checks: [apiCheck(id, suite, overrides)],
		runs: [apiRun(5000 + suite, suite)],
		jobs: [apiJob(id, 5000 + suite)],
	});
	const together = (...apis: Api[]): Api => ({
		checks: apis.flatMap((api) => api.checks),
		runs: apis.flatMap((api) => api.runs),
		jobs: apis.flatMap((api) => api.jobs),
	});
	/** A check-run with a job-less run next to it, as an API-created one looks like. */
	const apiOnly = (check: Item): Api => ({ checks: [check], runs: [apiRun(5100, 100)], jobs: [] });
	/** One check-run and one job of run 5100 / suite 100, each with its own deviation. */
	const oneOff = (deviation: { check?: Item; run?: Item; job?: Item }): Api => ({
		checks: [apiCheck(11, 100, deviation.check)],
		runs: [apiRun(5100, 100, deviation.run)],
		jobs: [apiJob(11, 5100, deviation.job)],
	});
	const FORGED = { started_at: "2099-01-01T00:00:00Z" };
	const OTHER_SHA = "d".repeat(40);

	// [label, API state, does the genuine success count (reuse)?]
	const scenarios: [string, Api, boolean][] = [
		["a genuine success", reviewOf(11, 100), true],
		["a genuine failure", reviewOf(11, 100, { conclusion: "failure" }), false],
		["an API-created check-run in the suite of the run (no job)", apiOnly(apiCheck(99, 100, FORGED)), false],
		["an API-created check-run in another suite", apiOnly(apiCheck(99, 200, FORGED)), false],
		[
			"a forged success starting after a genuine failure",
			together(reviewOf(11, 100, { conclusion: "failure" }), apiOnly(apiCheck(99, 200, FORGED))),
			false,
		],
		[
			"a forged failure starting after a genuine success",
			together(reviewOf(11, 100), apiOnly(apiCheck(99, 200, { ...FORGED, conclusion: "failure" }))),
			true,
		],
		["a check-run of a run of another workflow", oneOff({ run: { path: ".github/workflows/x.yml" } }), false],
		["a check-run of a push run", oneOff({ run: { event: "push" } }), false],
		["a check-run of a run on another sha", oneOff({ run: { head_sha: OTHER_SHA } }), false],
		[
			"a check-run outside the check suite of the run",
			oneOff({ check: { check_suite: { id: 101 } } }),
			false,
		],
		["a job of another id", oneOff({ job: { id: 12 } }), false],
		["a job named otherwise", oneOff({ job: { name: "typecheck" } }), false],
		["a job of another run", oneOff({ job: { run_id: 5999 } }), false],
		["a check-run of another app", oneOff({ check: { app: { slug: "some-other-app" } } }), false],
		["a check-run of another sha", oneOff({ check: { head_sha: OTHER_SHA } }), false],
		[
			"a genuine success then a genuine failure (re-run)",
			together(
				reviewOf(11, 100),
				reviewOf(12, 101, { conclusion: "failure", started_at: "2026-10-15T10:00:00Z" }),
			),
			false,
		],
		[
			"a genuine failure then a genuine success (re-run)",
			together(
				reviewOf(11, 100, { conclusion: "failure" }),
				reviewOf(12, 101, { started_at: "2026-10-15T10:00:00Z" }),
			),
			true,
		],
	];

	const decisionOf = async (api: Api): Promise<string> => {
		const stub = fakeApi({
			[`commits/${PREVIOUS}/check-runs`]: { total_count: api.checks.length, check_runs: api.checks },
			[`actions/runs?head_sha=${PREVIOUS}`]: { total_count: api.runs.length, workflow_runs: api.runs },
			"/jobs": (path: string) => {
				const runId = Number(/actions\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
				const jobs = api.jobs.filter((j) => j.run_id === runId);
				return { total_count: jobs.length, jobs };
			},
			"/annotations": annotationsBody([recordMessage(PATCH)]),
		});
		return (await resolveDecision(ctx(stub.get))).decision;
	};

	it.each(scenarios)("reuse decision for %s", async (_label, api, counts) => {
		expect(await decisionOf(api)).toBe(counts ? "reuse" : "full");
	});

	const program = gateProgram();
	// Until TRA-520 is merged the gate still selects by name alone and has no program to compare with.
	it.runIf(program !== null)("agrees with the jq program of the gate on every scenario", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "review-reuse-parity-"));
		try {
			for (const [label, api, counts] of scenarios) {
				const [checks, runs, jobs] = (["checks", "runs", "jobs"] as const).map((kind) => {
					const path = join(scratch, `${kind}.json`);
					writeFileSync(path, api[kind].map((item) => JSON.stringify(item)).join("\n"));
					return path;
				}) as [string, string, string];
				const args = ["-nr", "--arg", "sha", PREVIOUS, "--arg", "path", AI_REVIEW_PATH];
				const { stdout } = await exec("jq", [
					...args,
					...["--slurpfile", "checks", checks, "--slurpfile", "runs", runs, "--slurpfile", "jobs", jobs],
					program as string,
				]);
				const [, conclusion] = stdout.trimEnd().split("\t");
				expect(conclusion === "success", label).toBe(counts);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("review-reuse.ts as the workflow runs it", () => {
	const exec = promisify(execFile);

	/** Runs the script against a local API stub, with the environment the workflow gives it. */
	const runScript = async (
		status: number,
		body: (url: string) => unknown,
		extraEnv: Record<string, string> = {},
	) => {
		const seen: (string | undefined)[] = [];
		const server = createServer((req, res) => {
			seen.push(req.headers.authorization);
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body(req.url ?? "")));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const env = {
			PATH: process.env.PATH ?? "",
			GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			GH_TOKEN: "test-token",
			REPOSITORY: "raphpool/odyssey-music",
			EVENT_ACTION: "synchronize",
			RUN_ATTEMPT: "1",
			PREVIOUS_SHA: PREVIOUS,
			PATCH_ID: PATCH,
			BASE_REF: "main",
			DEFAULT_BRANCH: "main",
			PREVIOUS_LEAVES_WORKFLOWS_ALONE: "true",
			HEAD_IS_UPDATE_MERGE: "true",
			...extraEnv,
		};
		try {
			const { stdout } = await exec("npx", ["--no-install", "tsx", "scripts/ci/review-reuse.ts"], { env });
			return { result: JSON.parse(stdout) as { decision: string; reason: string }, seen };
		} finally {
			server.close();
		}
	};

	it("prints reuse for an unchanged diff and authenticates with GH_TOKEN", async () => {
		const answer = (url: string) => {
			if (url.includes("/annotations")) return annotationsBody([recordMessage(PATCH)]);
			if (url.includes("/jobs")) return jobsBody([job()]);
			if (url.includes("/actions/runs")) return runsBody([workflowRun()]);
			return checkRunsBody([run()]);
		};
		const { result, seen } = await runScript(200, answer);
		expect(result.decision).toBe("reuse");
		expect(seen).toEqual(Array(4).fill("Bearer test-token"));
	}, 30_000);

	it("prints full, and still exits 0, when the API is down", async () => {
		const { result } = await runScript(500, () => ({}));
		expect(result.decision).toBe("full");
		expect(result.reason).toMatch(/500/);
	}, 30_000);

	it("prints full without calling the API when the head is not a verified update-branch merge", async () => {
		const { result, seen } = await runScript(200, () => ({}), { HEAD_IS_UPDATE_MERGE: "" });
		expect(result.decision).toBe("full");
		expect(seen).toHaveLength(0);
	}, 30_000);

	it("stays loadable by `node --experimental-strip-types` on the runner: no import, no runtime-only TS syntax", () => {
		const code = readFileSync("scripts/ci/review-reuse.ts", "utf8")
			.split("\n")
			.filter((line) => !/^\s*\/\//.test(line))
			.join("\n");
		expect(code).not.toMatch(
			/^\s*import\s|\benum\s+\w+|\bnamespace\s+\w+|constructor\s*\([^)]*\b(public|private|protected)\b/m,
		);
	});
});

/** A GitHub Actions expression, built here so the source does not hold a literal template placeholder. */
const expr = (inner: string): string => `\${{ ${inner} }}`;

// The workflow is read as text, like ci-integrity-job.test.ts does: no YAML parser is added.
const workflowCode = readFileSync(".github/workflows/ai-review.yml", "utf8")
	.replaceAll("\r\n", "\n")
	.split("\n")
	.filter((line) => !/^\s*#/.test(line))
	.join("\n");

/** A step's text, from its `- name:` / `- uses:` line up to the next step. */
function stepBlock(marker: string): string {
	const start = workflowCode.indexOf(marker);
	if (start === -1) throw new Error(`step ${marker} not found in ai-review.yml`);
	const next = workflowCode.indexOf("\n      - ", start);
	return workflowCode.slice(
		workflowCode.lastIndexOf("\n      - ", start) + 1,
		next === -1 ? undefined : next,
	);
}

describe("ai-review.yml reuse wiring (TRA-510)", () => {
	const record = `echo "::notice::${RECORD_PREFIX}$PATCH_ID"`;

	it("calls claude-code-action, and gates its verdict, only when the decision is not reuse", () => {
		for (const marker of [
			"uses: anthropics/claude-code-action@v1",
			"- name: Clear any previous verdict",
			"- name: Gate",
			"- name: Record the reviewed patch-id",
		]) {
			expect(stepBlock(marker), marker).toContain("steps.decide.outputs.decision != 'reuse'");
		}
		// `!= 'reuse'` rather than `== 'full'`: a failed or missing decision step must mean a full review.
		expect(workflowCode).not.toContain("== 'full'");
		for (const marker of ["- name: Decide whether", "- name: Compute the patch-id"]) {
			expect(stepBlock(marker), marker).toContain("continue-on-error: true");
		}
	});

	it("never reuses on anything but the first attempt of a synchronize", () => {
		const decide = stepBlock("- name: Decide whether");
		const condition = "if: github.event.action == 'synchronize' && github.run_attempt == 1";
		expect(decide).toContain(condition);
		expect(stepBlock("uses: actions/setup-node@v4")).toContain(condition);
		expect(decide).toContain(`EVENT_ACTION: ${expr("github.event.action")}`);
		expect(decide).toContain(`RUN_ATTEMPT: ${expr("github.run_attempt")}`);
		expect(stepBlock("- name: Reuse the previous verdict")).toContain(
			"if: steps.decide.outputs.decision == 'reuse'",
		);
	});

	it("publishes the previous sha and the patch-id when it reuses, and records the same patch-id for the next head", () => {
		const reuse = stepBlock("- name: Reuse the previous verdict");
		expect(reuse).toContain('message="verdict réutilisé de $PREVIOUS_SHA, patch-id $PATCH_ID"');
		expect(reuseMessage("$PREVIOUS_SHA", "$PATCH_ID")).toBe(
			"verdict réutilisé de $PREVIOUS_SHA, patch-id $PATCH_ID",
		);
		expect(reuse).toContain('echo "::notice::$message"');
		expect(reuse).toContain(record);
		expect(reuse).toContain(`PREVIOUS_SHA: ${expr("steps.decide.outputs.previous_sha")}`);
		expect(reuse).not.toMatch(/claude-code-action|review\.json/);
		expect(stepBlock("- name: Record the reviewed patch-id")).toContain(record);
	});

	it("keeps the exact annotation that links the review to review-gate.yml", () => {
		expect(stepBlock("- name: Gate")).toContain(`echo "::error::${BLOCKING_ANNOTATION}"`);
		expect(readFileSync(".github/workflows/review-gate.yml", "utf8")).toContain(
			`.message == "${BLOCKING_ANNOTATION}"`,
		);
	});

	it("leaves the check-run the gate reads untouched: the job's own `review` check-run, no second one", () => {
		const gate = readFileSync(".github/workflows/review-gate.yml", "utf8");
		expect(gate).toContain("check_name=review");
		expect(gate).toContain('select(.name == "review")');
		// The check-run is the job itself: it keeps the key `review`, is not renamed, and no API call publishes another.
		expect(workflowCode).toMatch(/^jobs:\n {2}review:\n/m);
		expect(workflowCode).not.toMatch(/^ {4}name:|gh api|check-runs/m);
	});

	it("reads checks but cannot write them, and keeps the other permissions", () => {
		const permissions = workflowCode.slice(
			workflowCode.indexOf("    permissions:"),
			workflowCode.indexOf("    steps:"),
		);
		expect(permissions).toContain("checks: read");
		expect(permissions).not.toMatch(/checks:\s*write|statuses:/);
		for (const kept of [
			"contents: read",
			"pull-requests: write",
			"issues: read",
			"id-token: write",
			"actions: read",
		]) {
			expect(permissions).toContain(kept);
		}
	});

	it("runs the decision code of the default branch, not the checkout's nor the PR base's, and installs nothing", () => {
		const decide = stepBlock("- name: Decide whether");
		expect(decide).toContain('git show "origin/$DEFAULT_BRANCH:scripts/ci/review-reuse.ts"');
		expect(decide).not.toContain("origin/$BASE_REF");
		expect(decide).toContain(`DEFAULT_BRANCH: ${expr("github.event.repository.default_branch")}`);
		expect(decide).toContain(`BASE_REF: ${expr("github.event.pull_request.base.ref")}`);
		expect(decide).toContain('node --experimental-strip-types --no-warnings "$trusted/review-reuse.ts"');
		expect(decide).not.toMatch(/npm |npx |tsx|secrets\./);
		expect(decide).toContain(`GH_TOKEN: ${expr("github.token")}`);
	});

	it("establishes the git facts the script relies on, failing to an empty (full) answer", () => {
		const decide = stepBlock("- name: Decide whether");
		// The previous head must leave .github/ alone, measured from its merge-base with the default branch.
		expect(decide).toContain('git merge-base "origin/$DEFAULT_BRANCH" "$PREVIOUS_SHA"');
		expect(decide).toContain('git diff --quiet "$mb" "$PREVIOUS_SHA" -- .github/');
		expect(decide).toContain('leaves_workflows_alone=""');
		// The head must be the update-branch merge: ^1 is the previous head, ^2 is already in the default branch.
		expect(decide).toContain('git rev-list --parents -n 1 "$HEAD_SHA"');
		expect(decide).toContain('[ "$2" = "$PREVIOUS_SHA" ]');
		expect(decide).toContain('git merge-base --is-ancestor "$3" "origin/$DEFAULT_BRANCH"');
		expect(decide).toContain("head_is_update_merge=false");
		expect(decide).toContain(`HEAD_SHA: ${expr("github.event.pull_request.head.sha")}`);
		expect(decide).toContain("PREVIOUS_LEAVES_WORKFLOWS_ALONE=");
		expect(decide).toContain("HEAD_IS_UPDATE_MERGE=");
	});

	it("computes the patch-id on the git tree, after the merge-base, keeping whitespace and binaries significant", () => {
		const patch = stepBlock("- name: Compute the patch-id");
		for (const part of [
			'git merge-base "origin/$BASE_REF" HEAD',
			"git patch-id --verbatim",
			"--binary",
			"git diff --summary",
		]) {
			expect(patch).toContain(part);
		}
		expect(patch).toContain(`BASE_REF: ${expr("github.event.pull_request.base.ref")}`);
	});

	it("interpolates no expression into any run: script (values go through env:)", () => {
		const lines = workflowCode.split("\n");
		lines.forEach((line, i) => {
			const match = /^(\s*)(- )?run:\s*(.*)$/.exec(line);
			if (!match) return;
			const keyIndent = (match[1] as string).length + (match[2] === undefined ? 0 : 2);
			const body = [match[3] as string];
			for (let j = i + 1; /^[|>]/.test(match[3] as string) && j < lines.length; j++) {
				const next = lines[j] as string;
				if (next.trim() !== "" && next.length - next.trimStart().length <= keyIndent) break;
				body.push(next);
			}
			expect(body.join("\n"), `run script at line ${i + 1}`).not.toContain(expr("").slice(0, 3));
		});
	});
});
