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
	BASE_RECORD_FAMILY,
	BLOCKING_ANNOTATION,
	baseRecordMessage,
	belongsToPullRequest,
	type DecisionInput,
	decideReuse,
	type Facts,
	type HeadPull,
	hasBaseRecord,
	latestReview,
	MAX_PAGES,
	PAGE_SIZE,
	type PullRequestIdentity,
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

// TRA-526: a run only counts when it belongs to the pull request being updated. This is that pull request, and the
// list of the pull requests sharing its head (just itself, in the ordinary case).
const HEAD_SHA = "e".repeat(40);
const PULL: PullRequestIdentity = {
	number: 42,
	headSha: HEAD_SHA,
	baseRef: "main",
	headRef: "rdoulonne/tra-1-feature",
	headRepository: "raphpool/odyssey-music",
};
const OWN: HeadPull = { number: PULL.number, baseRef: PULL.baseRef, headSha: HEAD_SHA };
// A PR against another base whose last head is the previous head (closed there), or the current one (open).
const OTHER_BASE: HeadPull = { number: 77, baseRef: "release/1.0", headSha: PREVIOUS };
// TRA-529: what ai-review.yml records on the review of a run made for PULL against the default branch.
const BASE = baseRecordMessage(PULL.number, "main");

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
	headBranch: PULL.headRef,
	headRepository: PULL.headRepository,
	// Empty, as on many real runs: it can reject a run, never be required.
	pullRequests: [],
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
	annotations: [BASE, recordMessage(PATCH)],
	pullRequest: PULL,
	headPulls: [OWN],
	...overrides,
});

const evidenceOf = (value: DecisionInput) => ({
	checkRuns: value.checkRuns ?? [],
	workflowRuns: value.workflowRuns ?? [],
	jobs: value.jobs ?? [],
	pullRequest: PULL,
	headPulls: value.headPulls ?? [],
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
		["patch-id differs", { annotations: [BASE, recordMessage(OTHER_PATCH)] }],
		["previous review failed", { checkRuns: [run({ conclusion: "failure" })] }],
		["previous review cancelled", { checkRuns: [run({ conclusion: "cancelled" })] }],
		["previous review timed out", { checkRuns: [run({ conclusion: "timed_out" })] }],
		["previous review unfinished", { checkRuns: [run({ status: "in_progress", conclusion: null })] }],
		[
			"success carrying the blocking annotation",
			{ annotations: [BASE, recordMessage(PATCH), BLOCKING_ANNOTATION] },
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
		["record with garbage", { annotations: [BASE, `${RECORD_PREFIX}garbage`] }],
		["record of another version", { annotations: [BASE, `review-patch-id v0 ${PATCH}`] }],
		["two different records", { annotations: [BASE, recordMessage(PATCH), recordMessage(OTHER_PATCH)] }],
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
		// TRA-526: the run must be the one of this pull request, not just of this sha.
		["pull request not identified", { pullRequest: null }],
		["pull requests of the head not listed", { headPulls: null }],
		[
			"run produced for a PR from another branch on the same sha",
			{ workflowRuns: [workflowRun({ headBranch: "someone/else" })] },
		],
		["run without a head branch", { workflowRuns: [workflowRun({ headBranch: null })] }],
		[
			"run produced for a fork with a branch of the same name",
			{ workflowRuns: [workflowRun({ headRepository: "attacker/odyssey-music" })] },
		],
		["run without a head repository", { workflowRuns: [workflowRun({ headRepository: null })] }],
		["run that names only another PR", { workflowRuns: [workflowRun({ pullRequests: [OTHER_BASE] })] }],
		[
			"run that names this PR and another one against another base",
			{ workflowRuns: [workflowRun({ pullRequests: [OWN, OTHER_BASE] })] },
		],
		[
			"run that names this PR against another base",
			{ workflowRuns: [workflowRun({ pullRequests: [{ number: PULL.number, baseRef: "release/1.0" }] })] },
		],
		[
			"head shared with a PR against another base (the two runs cannot be told apart)",
			{ headPulls: [OWN, OTHER_BASE] },
		],
		[
			"this PR absent from the pull requests of the head",
			{ headPulls: [{ number: 78, baseRef: "main", headSha: PREVIOUS }] },
		],
		["no pull request on the head at all", { headPulls: [] }],
		// TRA-529: the review must say it ran for this PR against the default branch.
		[
			"review from before TRA-529: patch-id recorded, no base record",
			{ annotations: [recordMessage(PATCH)] },
		],
		[
			"review made against another base (the stack parent, since retargeted to main)",
			{ annotations: [baseRecordMessage(PULL.number, "feature/parent"), recordMessage(PATCH)] },
		],
		[
			"review made for another PR of the same branch (closed on another sha)",
			{ annotations: [baseRecordMessage(OTHER_BASE.number, "main"), recordMessage(PATCH)] },
		],
		[
			"two different base records",
			{ annotations: [BASE, baseRecordMessage(PULL.number, "feature/parent"), recordMessage(PATCH)] },
		],
		[
			"a base record of another version next to the v1",
			{ annotations: [BASE, `${BASE_RECORD_FAMILY}v2 ${PULL.number} main`, recordMessage(PATCH)] },
		],
		[
			"a base record that is not the exact message (leading zero)",
			{ annotations: [`${BASE_RECORD_FAMILY}v1 0${PULL.number} main`, recordMessage(PATCH)] },
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

	it("keeps the review of the PR itself whether its run lists the PR or lists nothing, and a sibling PR on the same base", () => {
		expect(decideReuse(input({ workflowRuns: [workflowRun({ pullRequests: [OWN] })] })).decision).toBe(
			"reuse",
		);
		const sibling: HeadPull = { number: 78, baseRef: PULL.baseRef, headSha: PREVIOUS };
		expect(decideReuse(input({ headPulls: [OWN, sibling] })).decision).toBe("reuse");
	});

	it("ignores a PR against another base left on an older sha (a closed stack parent reopened against main)", () => {
		const stale: HeadPull = { ...OTHER_BASE, headSha: "d".repeat(40) };
		expect(decideReuse(input({ headPulls: [stale, OWN] })).decision).toBe("reuse");
		// Open on the branch, it sits on the current head and keeps the head ambiguous.
		const openOnHead: HeadPull = { ...OTHER_BASE, headSha: HEAD_SHA };
		expect(decideReuse(input({ headPulls: [openOnHead, OWN] })).decision).toBe("full");
	});

	it("does not let the success of a PR B on the same sha win over the review of the PR", () => {
		const ofB = {
			check: run({ id: 99, startedAt: LATER, checkSuiteId: 200 }),
			run: workflowRun({ id: 5200, checkSuiteId: 200, headBranch: "someone/else" }),
		};
		const failedOwn = run({ id: 1, conclusion: "failure" });
		const evidence = input({
			checkRuns: [failedOwn, ofB.check],
			workflowRuns: [workflowRun(), ofB.run],
			jobs: [job({ id: 1 }), job({ id: 99, runId: 5200 })],
		});
		expect(latestReview(PREVIOUS, evidenceOf(evidence))?.id).toBe(1);
		expect(decideReuse(evidence).decision).toBe("full");
	});

	it("applies the rule on its own: same head, same repository, nothing contradicting", () => {
		expect(belongsToPullRequest(workflowRun(), PULL, [OWN])).toBe(true);
		expect(belongsToPullRequest(workflowRun(), PULL, [OWN, OTHER_BASE])).toBe(false);
		expect(belongsToPullRequest(workflowRun({ headBranch: "other" }), PULL, [OWN])).toBe(false);
	});

	it("accepts the same record twice (a reused review records it again)", () => {
		expect(
			decideReuse(input({ annotations: [BASE, BASE, recordMessage(PATCH), recordMessage(PATCH)] })).decision,
		).toBe("reuse");
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
		head_branch: r.headBranch,
		head_repository: r.headRepository === null ? null : { full_name: r.headRepository },
		pull_requests: r.pullRequests.map((pull) => ({ number: pull.number, base: { ref: pull.baseRef } })),
	})),
});

/** `GET pulls/<n>`: the pull request being updated. */
const pullBody = (pull: PullRequestIdentity = PULL) => ({
	number: pull.number,
	base: { ref: pull.baseRef },
	head: { ref: pull.headRef, sha: pull.headSha, repo: { full_name: pull.headRepository } },
});

/** `GET pulls?head=…`: a bare array, not a `{ total_count, … }` envelope. */
const headPullsBody = (pulls: HeadPull[]) =>
	pulls.map((pull) => ({ number: pull.number, base: { ref: pull.baseRef }, head: { sha: pull.headSha } }));

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
	overrides: Partial<Facts & { repository: string; pullNumber: number | null }> = {},
) => ({
	...facts(),
	repository: "raphpool/odyssey-music",
	pullNumber: PULL.number,
	get,
	...overrides,
});

describe("resolveDecision (API lookups)", () => {
	const listing = `commits/${PREVIOUS}/check-runs`;
	const runsListing = `actions/runs?head_sha=${PREVIOUS}&event=pull_request`;
	const jobsListing = `actions/runs/${RUN_ID}/jobs`;
	const pullLookup = `pulls/${PULL.number}`;
	const headPullsListing = "pulls?head=";
	const happy = (): Record<string, Answer> => ({
		[pullLookup]: pullBody(),
		[headPullsListing]: headPullsBody([OWN]),
		[listing]: checkRunsBody([run()]),
		[runsListing]: runsBody([workflowRun()]),
		[jobsListing]: jobsBody([job()]),
		"check-runs/7/annotations": annotationsBody([BASE, recordMessage(PATCH)]),
	});

	it("reads the previous head's review, the run and the job that produced it, and its annotations", async () => {
		const api = fakeApi(happy());
		expect((await resolveDecision(ctx(api.get))).decision).toBe("reuse");
		const repo = "repos/raphpool/odyssey-music";
		expect(api.paths[0]).toContain(`${repo}/${pullLookup}`);
		// `head` is `<owner>:<branch>`, encoded: a branch name is chosen by the PR author.
		expect(api.paths[1]).toContain(`${repo}/pulls?head=raphpool%3Ardoulonne%2Ftra-1-feature&state=all`);
		expect(api.paths[2]).toContain(`${repo}/${listing}?check_name=review&filter=all`);
		expect(api.paths[3]).toContain(`${repo}/${runsListing}`);
		expect(api.paths[4]).toContain(`${repo}/${jobsListing}?filter=all`);
		expect(api.paths[5]).toContain(`${repo}/check-runs/7/annotations`);
		expect(api.paths).toHaveLength(6);
	});

	// TRA-526: the pull request is established from the API, whose answer is the authority on its head and base.
	it.each([
		["the pull request lookup fails", { [pullLookup]: new Error("GitHub API answered 404") }],
		["the lookup answers another PR", { [pullLookup]: pullBody({ ...PULL, number: 43 }) }],
		// Both answers agree on the new base, so the only thing left to refuse the reuse is the comparison with the
		// base the event said: removing it lets this case through (the review of a retargeted PR is not reusable).
		[
			"the PR now targets another base than the event said",
			{
				[pullLookup]: pullBody({ ...PULL, baseRef: "release/1.0" }),
				[headPullsListing]: headPullsBody([{ ...OWN, baseRef: "release/1.0" }]),
			},
		],
		[
			"the PR has no head repository (deleted fork)",
			{ [pullLookup]: { ...pullBody(), head: { ref: PULL.headRef, repo: null } } },
		],
		[
			"the pull requests of the head cannot be listed",
			{ [headPullsListing]: new Error("GitHub API answered 500") },
		],
		["the pull requests of the head have the wrong shape", { [headPullsListing]: { not: "an array" } }],
		[
			"another PR shares the head against another base",
			{ [headPullsListing]: headPullsBody([OWN, OTHER_BASE]) },
		],
		["the listing of the head does not hold the PR", { [headPullsListing]: headPullsBody([]) }],
		[
			"the listing of the head never ends",
			{
				[headPullsListing]: () =>
					headPullsBody(
						Array.from({ length: PAGE_SIZE }, (_, i) => ({
							number: 1000 + i,
							baseRef: "main",
							headSha: PREVIOUS,
						})),
					),
			},
		],
	])("runs a full review when %s", async (_label, answers) => {
		expect((await resolveDecision(ctx(fakeApi({ ...happy(), ...answers }).get))).decision).toBe("full");
	});

	it("runs a full review without any call when the pull request number is unknown", async () => {
		const api = fakeApi(happy());
		expect((await resolveDecision(ctx(api.get, { pullNumber: null }))).decision).toBe("full");
		expect(api.paths).toHaveLength(0);
	});

	it("reads every page of the pull requests of the head", async () => {
		const pages = (path: string) =>
			/[?&]page=1$/.test(path)
				? headPullsBody(
						Array.from({ length: PAGE_SIZE }, (_, i) => ({
							number: 1000 + i,
							baseRef: PULL.baseRef,
							headSha: PREVIOUS,
						})),
					)
				: headPullsBody([OWN]);
		const api = fakeApi({ ...happy(), [headPullsListing]: pages });
		expect((await resolveDecision(ctx(api.get))).decision).toBe("reuse");
		expect(api.paths.filter((path) => path.includes(headPullsListing))).toHaveLength(2);
	});

	it("only asks for the jobs of runs of ai-review.yml that own a listed check-run", async () => {
		const api = fakeApi({
			...happy(),
			[runsListing]: runsBody([
				workflowRun({ id: 1, path: ".github/workflows/other.yml" }),
				workflowRun({ id: 2, checkSuiteId: 555 }),
				workflowRun({ id: 3, headBranch: "someone/else" }),
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
					BASE,
					recordMessage(PATCH),
					...Array(PAGE_SIZE - 2).fill("notice"),
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
				"check-runs/99/annotations": annotationsBody([BASE, recordMessage(PATCH)]),
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
		expect(api.paths.filter((path) => path.includes(listing)).length).toBeLessThanOrEqual(MAX_PAGES);
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
		/** The pull requests of the head, as the gate slims them down; just the PR itself by default. */
		pulls?: Item[];
	}
	const apiPull = (pull: HeadPull): Item => ({
		number: pull.number,
		base_ref: pull.baseRef,
		head_sha: pull.headSha,
	});

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
		head_branch: PULL.headRef,
		head_repository: PULL.headRepository,
		pull_requests: [],
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
		// TRA-526: the run is the one of this pull request, not just of this sha.
		["a run produced for a PR from another branch", oneOff({ run: { head_branch: "someone/else" } }), false],
		["a run produced for a fork", oneOff({ run: { head_repository: "attacker/odyssey-music" } }), false],
		["a run produced for a fork that was deleted", oneOff({ run: { head_repository: null } }), false],
		["a run that lists this PR", oneOff({ run: { pull_requests: [apiPull(OWN)] } }), true],
		["a run that lists only another PR", oneOff({ run: { pull_requests: [apiPull(OTHER_BASE)] } }), false],
		[
			"a run that lists this PR and another against another base",
			oneOff({ run: { pull_requests: [apiPull(OWN), apiPull(OTHER_BASE)] } }),
			false,
		],
		[
			"a run that lists this PR against another base",
			oneOff({ run: { pull_requests: [apiPull({ ...OWN, baseRef: "release/1.0" })] } }),
			false,
		],
		[
			"a head shared with a PR against another base",
			{ ...reviewOf(11, 100), pulls: [apiPull(OWN), apiPull(OTHER_BASE)] },
			false,
		],
		[
			"a head shared with a PR against the same base",
			{ ...reviewOf(11, 100), pulls: [apiPull(OWN), apiPull({ ...OWN, number: 78 })] },
			true,
		],
		[
			"a head shared with a PR against another base left on an older sha",
			{ ...reviewOf(11, 100), pulls: [apiPull({ ...OTHER_BASE, headSha: "d".repeat(40) }), apiPull(OWN)] },
			true,
		],
		["a head whose pull requests do not hold this PR", { ...reviewOf(11, 100), pulls: [] }, false],
		[
			"the success of a PR from another branch after a genuine failure",
			together(reviewOf(11, 100, { conclusion: "failure" }), {
				checks: [apiCheck(99, 200, { started_at: "2099-01-01T00:00:00Z" })],
				runs: [apiRun(5200, 200, { head_branch: "someone/else" })],
				jobs: [apiJob(99, 5200)],
			}),
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

	// The scenarios hold runs as the gate slims them down; the API lists `head_repository` and `pull_requests` in full.
	const rawRun = (slim: Item): Item => ({
		...slim,
		head_repository: slim.head_repository === null ? null : { full_name: slim.head_repository },
		pull_requests: (slim.pull_requests as Item[]).map((pull) => ({
			number: pull.number,
			base: { ref: pull.base_ref },
		})),
	});

	const decisionOf = async (api: Api): Promise<string> => {
		const stub = fakeApi({
			[`commits/${PREVIOUS}/check-runs`]: { total_count: api.checks.length, check_runs: api.checks },
			[`actions/runs?head_sha=${PREVIOUS}`]: {
				total_count: api.runs.length,
				workflow_runs: api.runs.map(rawRun),
			},
			"/jobs": (path: string) => {
				const runId = Number(/actions\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
				const jobs = api.jobs.filter((j) => j.run_id === runId);
				return { total_count: jobs.length, jobs };
			},
			"/annotations": annotationsBody([BASE, recordMessage(PATCH)]),
			[`pulls/${PULL.number}`]: pullBody(),
			"pulls?head=": headPullsBody(
				(api.pulls ?? [apiPull(OWN)]).map((p) => ({
					number: p.number as number,
					baseRef: p.base_ref as string,
					headSha: p.head_sha as string,
				})),
			),
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
			const pr = {
				number: PULL.number,
				baseRef: PULL.baseRef,
				headRef: PULL.headRef,
				headRepo: PULL.headRepository,
			};
			for (const [label, api, counts] of scenarios) {
				const [checks, runs, jobs, pulls] = (["checks", "runs", "jobs", "pulls"] as const).map((kind) => {
					const path = join(scratch, `${kind}.json`);
					const items = kind === "pulls" ? (api.pulls ?? [apiPull(OWN)]) : api[kind];
					writeFileSync(path, items.map((item) => JSON.stringify(item)).join("\n"));
					return path;
				}) as [string, string, string, string];
				const args = ["-nr", "--arg", "sha", PREVIOUS, "--arg", "path", AI_REVIEW_PATH];
				const { stdout } = await exec("jq", [
					...args,
					...["--slurpfile", "checks", checks, "--slurpfile", "runs", runs, "--slurpfile", "jobs", jobs],
					...["--slurpfile", "pulls", pulls, "--argjson", "pr", JSON.stringify(pr)],
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

// TRA-529: the verdict must say which pull request and which base it was produced for. `pull_requests[]` of a run and
// `pulls?head=` are recomputed at every read, so after a retarget they show the new base on an old run.
describe("the review must have been produced for this PR against the default branch (TRA-529)", () => {
	const exec = promisify(execFile);
	const listing = `commits/${PREVIOUS}/check-runs`;
	const runsListing = `actions/runs?head_sha=${PREVIOUS}&event=pull_request`;
	const jobsListing = `actions/runs/${RUN_ID}/jobs`;
	const answers = (annotations: string[], headPulls: HeadPull[] = [OWN]): Record<string, Answer> => ({
		[`pulls/${PULL.number}`]: pullBody(),
		"pulls?head=": headPullsBody(headPulls),
		[listing]: checkRunsBody([run()]),
		[runsListing]: runsBody([workflowRun()]),
		[jobsListing]: jobsBody([job()]),
		"check-runs/7/annotations": annotationsBody(annotations),
	});
	const decide = async (annotations: string[], headPulls?: HeadPull[]) =>
		resolveDecision(ctx(fakeApi(answers(annotations, headPulls)).get));

	it("runs a full review when the review ran against a stack parent that was then retargeted to main and updated", async () => {
		// Criterion 1 of the ticket. PR 42 was ready against `feature/parent` (a weakened ai-review.yml), then retargeted
		// to main, then update-branch pushed a merge of main. The API now says main everywhere, and the run lists nothing.
		const annotations = [baseRecordMessage(PULL.number, "feature/parent"), recordMessage(PATCH)];
		// The selection of TRA-526 alone still retains that run: this is the gap.
		expect(
			latestReview(PREVIOUS, {
				checkRuns: [run()],
				workflowRuns: [workflowRun()],
				jobs: [job()],
				pullRequest: PULL,
				headPulls: [OWN],
			}),
		).not.toBeNull();
		const result = await decide(annotations);
		expect(result.decision).toBe("full");
		expect(result.reason).toMatch(/did not record this pull request against the default branch/);
		// Control: the same review, had it been made against main, is reused.
		expect((await decide([BASE, recordMessage(PATCH)])).decision).toBe("reuse");
	});

	it("runs a full review when the review is the one of a closed PR of the same branch left on another sha", async () => {
		// The path of the nit of TRA-526: B (same branch, base `evil`) got a genuine success on this sha, then moved to
		// another one and was closed. `pulls?head=` ignores it (older sha), so the selection retains its run; only the
		// PR number of the record tells it apart.
		const closedB: HeadPull = { number: 77, baseRef: "evil", headSha: "d".repeat(40) };
		const ofB = [baseRecordMessage(closedB.number, "evil"), recordMessage(PATCH)];
		expect((await decide(ofB, [closedB, OWN])).decision).toBe("full");
		// Even a B against main: the record names the PR, and it is not this one.
		const ofBOnMain = [baseRecordMessage(closedB.number, "main"), recordMessage(PATCH)];
		expect((await decide(ofBOnMain, [closedB, OWN])).decision).toBe("full");
		expect((await decide([BASE, recordMessage(PATCH)], [closedB, OWN])).decision).toBe("reuse");
	});

	it("runs a full review for a review from before TRA-529, which recorded no base", async () => {
		expect((await decide([recordMessage(PATCH)])).decision).toBe("full");
	});

	const cases: [string, string[], number, string, boolean][] = [
		["the exact record", [BASE], 42, "main", true],
		["the record twice", [BASE, BASE], 42, "main", true],
		["the record among other notices", ["notice", recordMessage(PATCH), BASE], 42, "main", true],
		["no record", [], 42, "main", false],
		["another PR", [baseRecordMessage(43, "main")], 42, "main", false],
		["another base", [baseRecordMessage(42, "release/1.0")], 42, "main", false],
		["two different records", [BASE, baseRecordMessage(42, "release/1.0")], 42, "main", false],
		["the record and one of another PR", [BASE, baseRecordMessage(43, "main")], 42, "main", false],
		["another version next to the v1", [BASE, "review-base v2 42 main"], 42, "main", false],
		["only another version", ["review-base v2 42 main"], 42, "main", false],
		["a leading zero", ["review-base v1 042 main"], 42, "main", false],
		["extra spaces", ["review-base v1 42  main"], 42, "main", false],
		["a trailing space", ["review-base v1 42 main "], 42, "main", false],
		["a prefix of a longer base", ["review-base v1 42 main2"], 42, "main", false],
		[
			"the base of the record is a prefix of the default branch",
			["review-base v1 42 mai"],
			42,
			"main",
			false,
		],
		["no default branch", [baseRecordMessage(42, "")], 42, "", false],
	];
	it.each(cases)("hasBaseRecord: %s", (_label, messages, pullNumber, defaultBranch, expected) => {
		expect(hasBaseRecord(messages, pullNumber, defaultBranch)).toBe(expected);
	});

	// The gate applies the same rule with the `validate_base` jq program: both must agree message by message.
	const validateBase = ((): string | null => {
		const lines = readFileSync(".github/workflows/review-gate.yml", "utf8")
			.replaceAll("\r\n", "\n")
			.split("\n");
		const start = lines.findIndex((line) => line.includes("validate_base=$(cat <<'JQ'"));
		if (start === -1) return null;
		const end = lines.findIndex((line, index) => index > start && line.trim() === "JQ");
		return lines.slice(start + 1, end).join("\n");
	})();
	it.runIf(validateBase !== null)(
		"agrees with the validate_base program of the gate on every case",
		async () => {
			const scratch = mkdtempSync(join(tmpdir(), "review-reuse-base-"));
			try {
				for (const [label, messages, number, defaultBranch, expected] of cases) {
					const notes = join(scratch, "notes.json");
					writeFileSync(notes, messages.map((message) => JSON.stringify({ message })).join("\n"));
					const pr = { number, baseRef: defaultBranch, defaultBranch };
					const { stdout } = await exec("jq", [
						...["-nr", "--slurpfile", "notes", notes, "--argjson", "pr", JSON.stringify(pr)],
						validateBase as string,
					]);
					expect(stdout.trim() === "true", label).toBe(expected);
				}
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		},
	);
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
			// What the runner gives every step of a pull_request run: the PR number is read from there.
			GITHUB_REF: `refs/pull/${PULL.number}/merge`,
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
			if (url.includes("/pulls?head=")) return headPullsBody([OWN]);
			if (url.includes(`/pulls/${PULL.number}`)) return pullBody();
			if (url.includes("/annotations")) return annotationsBody([BASE, recordMessage(PATCH)]);
			if (url.includes("/jobs")) return jobsBody([job()]);
			if (url.includes("/actions/runs")) return runsBody([workflowRun()]);
			return checkRunsBody([run()]);
		};
		const { result, seen } = await runScript(200, answer);
		expect(result.decision).toBe("reuse");
		expect(seen).toEqual(Array(6).fill("Bearer test-token"));
	}, 30_000);

	it("prints full without calling the API when the runner gives no pull request ref", async () => {
		const { result, seen } = await runScript(200, () => ({}), { GITHUB_REF: "refs/heads/main" });
		expect(result.decision).toBe("full");
		expect(seen).toHaveLength(0);
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
		// TRA-749: the job name is an argument of the selection, and the gate's first call names `review`.
		expect(gate).toContain("select(.name == $job)");
		expect(gate).toContain("--arg job review");
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

// TRA-529: the first step of the job writes the record every conclusion of the review carries.
describe("ai-review.yml records the pull request and the base of the review (TRA-529)", () => {
	const exec = promisify(execFile);
	const name = "- name: Record the pull request and the base of this review";
	const step = stepBlock(name);

	/** The `run: |` script of that step, unindented, from the file as written (comments kept). */
	const script = (): string => {
		const lines = readFileSync(".github/workflows/ai-review.yml", "utf8")
			.replaceAll("\r\n", "\n")
			.split("\n");
		const start = lines.findIndex((line) => line.trim() === name);
		const runAt = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
		const indent = (lines[runAt]?.length ?? 0) - (lines[runAt]?.trimStart().length ?? 0) + 2;
		const body: string[] = [];
		for (const line of lines.slice(runAt + 1)) {
			if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
			body.push(line.slice(indent));
		}
		return body.join("\n");
	};

	it("is the first thing the job does after isolating HOME, unconditionally, so every conclusion and every reuse has it", () => {
		expect(step).not.toMatch(/\bif:/);
		expect(step).not.toContain("continue-on-error");
		const at = (marker: string) => workflowCode.indexOf(marker);
		expect(at("- name: Isolate HOME")).toBeLessThan(at(name));
		expect(at(name)).toBeLessThan(at("uses: actions/checkout@v6"));
		expect(at(name)).toBeLessThan(at("- name: Decide whether"));
	});

	it("takes the pull request and the base from the event, through env, and writes the notice the gate and reuse read", () => {
		expect(step).toContain(`PR_NUMBER: ${expr("github.event.pull_request.number")}`);
		expect(step).toContain(`BASE_REF: ${expr("github.event.pull_request.base.ref")}`);
		expect(step).toContain(`echo "::notice::${baseRecordMessage("$PR_NUMBER", "$BASE_REF")}"`);
		// Nothing but the event feeds it: no API call, no `pull_requests[]`, no checkout.
		expect(step).not.toMatch(/gh |curl|git |pull_requests/);
	});

	const record = async (prNumber: string, baseRef: string) => {
		const { stdout } = await exec("bash", ["-c", script()], {
			env: { PATH: process.env.PATH ?? "", PR_NUMBER: prNumber, BASE_REF: baseRef },
		});
		return stdout;
	};

	it.each([
		["42", "main"],
		["7", "release/1.0"],
		["1234", "feature/a_b-c.d"],
	])("writes the record of PR %s against %s", async (prNumber, baseRef) => {
		expect(await record(prNumber, baseRef)).toBe(`::notice::${baseRecordMessage(prNumber, baseRef)}\n`);
	});

	// A `%` is decoded by the runner into a newline or a carriage return inside a workflow command: the record would
	// be split. Anything outside the plain charset leaves no record (and a warning); the review itself still runs.
	it.each([
		["42", "main%0Areview-base v1 42 main"],
		["42", "a b"],
		["42", "weirdé"],
		["42", ""],
		["042", "main"],
		["0", "main"],
		["", "main"],
		["4 2", "main"],
	])("writes no record for PR %j against %j, and does not fail the job", async (prNumber, baseRef) => {
		const out = await record(prNumber, baseRef);
		expect(out).not.toContain("::notice::");
		expect(out).toContain("::warning::review-base non enregistré");
	});
});
