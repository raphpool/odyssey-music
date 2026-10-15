import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	BLOCKING_ANNOTATION,
	type DecisionInput,
	decideReuse,
	type Facts,
	latestReview,
	PAGE_SIZE,
	RECORD_PREFIX,
	type ReviewCheckRun,
	recordMessage,
	resolveDecision,
	reuseMessage,
} from "../scripts/ci/review-reuse.js";

const PREVIOUS = "a".repeat(40);
const PATCH = `${"1".repeat(40)}-${"2".repeat(40)}`;
const OTHER_PATCH = `${"3".repeat(40)}-${"2".repeat(40)}`;
const LATER = "2026-10-15T11:00:00Z";

const run = (overrides: Partial<ReviewCheckRun> = {}): ReviewCheckRun => ({
	id: 7,
	name: "review",
	status: "completed",
	conclusion: "success",
	startedAt: "2026-10-15T10:00:00Z",
	appSlug: "github-actions",
	...overrides,
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
	checkRunsTruncated: false,
	annotations: [recordMessage(PATCH)],
	...overrides,
});

describe("decideReuse (TRA-510)", () => {
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
		["listing truncated", { checkRunsTruncated: true }],
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
	];
	it.each(full)("runs a full review: %s", (_label, overrides) => {
		expect(decideReuse(input(overrides)).decision).toBe("full");
	});

	it("judges the last review by start time, like review-gate.yml does", () => {
		const failedLater = [run({ id: 1 }), run({ id: 2, conclusion: "failure", startedAt: LATER })];
		expect(decideReuse(input({ checkRuns: failedLater })).decision).toBe("full");
		const succeededLater = [run({ id: 1, conclusion: "failure" }), run({ id: 2, startedAt: LATER })];
		expect(decideReuse(input({ checkRuns: succeededLater })).decision).toBe("reuse");
		expect(latestReview(succeededLater)?.id).toBe(2);
	});

	it("accepts the same record twice (a reused review records it again)", () => {
		expect(decideReuse(input({ annotations: [recordMessage(PATCH), recordMessage(PATCH)] })).decision).toBe(
			"reuse",
		);
	});
});

const checkRunsBody = (runs: ReviewCheckRun[], total = runs.length) => ({
	total_count: total,
	check_runs: runs.map((r) => ({ ...r, started_at: r.startedAt, app: r.appSlug && { slug: r.appSlug } })),
});

const annotationsBody = (messages: string[]) => messages.map((message) => ({ message }));

/** A GitHub API stub: the answer of the first key contained in the requested path; Errors are thrown. */
const fakeApi = (answers: Record<string, unknown>) => {
	const paths: string[] = [];
	const get = async (path: string): Promise<unknown> => {
		paths.push(path);
		const key = Object.keys(answers).find((candidate) => path.includes(candidate));
		const answer = key === undefined ? new Error("GitHub API answered 404") : answers[key];
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

	it("reads the previous head's review and its annotations from the API", async () => {
		const api = fakeApi({
			[listing]: checkRunsBody([run()]),
			"check-runs/7/annotations": annotationsBody([recordMessage(PATCH)]),
		});
		expect((await resolveDecision(ctx(api.get))).decision).toBe("reuse");
		expect(api.paths[0]).toContain(`repos/raphpool/odyssey-music/${listing}?check_name=review&filter=all`);
		expect(api.paths[1]).toContain("repos/raphpool/odyssey-music/check-runs/7/annotations");
	});

	it.each([
		["the listing call fails", { [listing]: new Error("GitHub API answered 503") }],
		["the annotations call fails", { [listing]: checkRunsBody([run()]) }],
		["the listing has the wrong shape", { [listing]: { check_runs: "nope" } }],
		[
			"a check-run has no start time",
			{ [listing]: { total_count: 1, check_runs: [{ id: 1, name: "review", status: "x" }] } },
		],
		["the listing is truncated", { [listing]: checkRunsBody([run()], 250) }],
		[
			"the annotations page is full (a blocking one could be on the next page)",
			{
				[listing]: checkRunsBody([run()]),
				"/annotations": annotationsBody([recordMessage(PATCH), ...Array(PAGE_SIZE - 1).fill("notice")]),
			},
		],
	])("runs a full review when %s", async (_label, answers) => {
		expect((await resolveDecision(ctx(fakeApi(answers).get))).decision).toBe("full");
	});

	it("does not fetch annotations of a review that did not succeed", async () => {
		const api = fakeApi({ [listing]: checkRunsBody([run({ conclusion: "failure" })]) });
		expect((await resolveDecision(ctx(api.get))).decision).toBe("full");
		expect(api.paths).toHaveLength(1);
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
		const answer = (url: string) =>
			url.includes("/annotations") ? annotationsBody([recordMessage(PATCH)]) : checkRunsBody([run()]);
		const { result, seen } = await runScript(200, answer);
		expect(result.decision).toBe("reuse");
		expect(seen).toEqual(["Bearer test-token", "Bearer test-token"]);
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
