// TRA-510 (2026-10-15): the merge queue runs `gh pr update-branch` on every PR, which pushes a merge commit
// (`synchronize`) and used to restart the whole AI review (~4-5 min, ~0.84 USD) although the PR's own diff had not
// moved. This module decides whether the verdict of the previous head can be reused.
//
// Two constraints shape it:
// - It must stay free of imports and use erasable TypeScript syntax only: ai-review.yml runs it with
//   `node --experimental-strip-types`, from the base branch's copy, without `npm ci`. The job already holds the
//   review secrets, so it does not install or execute anything coming from the PR.
// - Every doubt resolves to "full" (fail closed): an unreadable API answer, an ambiguous record or a missing review
//   only ever costs one more review, never a skipped one.

export type Decision = "reuse" | "full";

export interface ReuseResult {
	decision: Decision;
	reason: string;
	previousSha: string | null;
	patchId: string | null;
}

export interface ReviewCheckRun {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	startedAt: string;
	appSlug: string | null;
	headSha: string;
	checkSuiteId: number;
}

/** A pull request as `pulls` and the `pull_requests[]` of a workflow run list it: its number and its base branch. */
export interface PullRef {
	number: number;
	baseRef: string;
}

/** A pull request of the head branch, as `pulls?head=` lists it: where its head stood when it was last updated. */
export interface HeadPull extends PullRef {
	headSha: string;
}

/** The pull request being updated, as `pulls/<number>` describes it. */
export interface PullRequestIdentity extends HeadPull {
	headRef: string;
	/** `<owner>/<name>` of the repository the head branch lives in (a fork for a fork's PR). */
	headRepository: string;
}

/** A workflow run of the previous head, as `actions/runs` lists it. */
export interface WorkflowRun {
	id: number;
	path: string;
	event: string;
	headSha: string;
	checkSuiteId: number;
	/** Head branch and repository of the run; null when the API gives none (a deleted fork). */
	headBranch: string | null;
	headRepository: string | null;
	/**
	 * `pull_requests[]` of the run. Empty on many real runs, so it can reject a run but is never required. It is
	 * recomputed at every read (open PRs of the head branch, with their CURRENT base): it says nothing about the base
	 * the run was made against, which only the `review-base` record of the review carries (TRA-529).
	 */
	pullRequests: readonly PullRef[];
}

/** A job of a workflow run, as `actions/runs/<id>/jobs` lists it. */
export interface WorkflowJob {
	id: number;
	name: string;
	runId: number;
}

// Must stay equal to the annotation the `Gate` step of ai-review.yml emits and review-gate.yml matches.
export const BLOCKING_ANNOTATION = "Findings bloquants — voir les commentaires inline.";
export const RECORD_VERSION = "v1";
export const RECORD_PREFIX = `review-patch-id ${RECORD_VERSION} `;
// Part of the selection rule of review-gate.yml, NOT a security boundary on its own: any workflow step also runs as
// this app and can write a `review` check-run or annotation. What binds a check-run to the AI review is
// `latestReview` (the job of a run of ai-review.yml); what protects the record from the PR itself is the `.github/`
// check in `precheck`.
export const REVIEW_APP_SLUG = "github-actions";
// The `path` of a `pull_request` run of ai-review.yml (no `@ref` suffix, which other events carry) and the name of
// its job: the same constants as the `select_review` program of review-gate.yml.
export const AI_REVIEW_PATH = ".github/workflows/ai-review.yml";
export const REVIEW_JOB_NAME = "review";
// Page size of the listings, and how many pages are read before giving up: an unfinished listing may hide the
// genuine review (or a blocking annotation), so running out of pages means a full review.
export const PAGE_SIZE = 100;
export const MAX_PAGES = 10;
// Runs of ai-review.yml whose jobs are listed: a handful exist per head (ready_for_review, reopened, re-runs).
const MAX_RUNS_LISTED = 10;

// "<git patch-id --verbatim>-<hash of the mode/create/delete summary>", computed by the workflow on the git tree.
const PATCH_ID = /^[0-9a-f]{40}-[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

export const isPatchId = (value: unknown): value is string =>
	typeof value === "string" && PATCH_ID.test(value);
export const isSha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);

export const recordMessage = (patchId: string): string => `${RECORD_PREFIX}${patchId}`;

// TRA-529 (2026-10-24): which pull request, and against which base, a review ran. ai-review.yml writes this notice on
// the `review` job as its first step, from the event of the run, so it is frozen when the run starts. The base of a
// pull request is not: `pull_requests[]` of a run is recomputed at every read, so after a retarget a run made against
// an unreviewed base shows the new one. Same standing as the patch-id record: a notice any workflow step of the PR
// could also write, not a proof (the PR of TRA-529 says what it does and does not stop).
export const BASE_RECORD_FAMILY = "review-base ";
export const baseRecordMessage = (pullNumber: number | string, baseRef: string): string =>
	`${BASE_RECORD_FAMILY}${RECORD_VERSION} ${pullNumber} ${baseRef}`;

/**
 * Whether the annotations of a review say it ran for pull request `pullNumber` against `defaultBranch`, and only that:
 * exactly one distinct `review-base` record (any version counts as one, so a v2 next to the v1 is ambiguous), equal
 * to the expected message. No record (a run from before TRA-529), another PR, another base or two records: false.
 * Same rule as the `validate_base` program of review-gate.yml (message compared to message, nothing parsed).
 */
export const hasBaseRecord = (
	messages: readonly string[],
	pullNumber: number,
	defaultBranch: string,
): boolean => {
	if (defaultBranch === "") return false;
	const records = new Set(messages.filter((message) => message.startsWith(BASE_RECORD_FAMILY)));
	return records.size === 1 && records.has(baseRecordMessage(pullNumber, defaultBranch));
};

export const reuseMessage = (previousSha: string, patchId: string): string =>
	`verdict réutilisé de ${previousSha}, patch-id ${patchId}`;

const full = (reason: string, previousSha: string | null, patchId: string | null): ReuseResult => ({
	decision: "full",
	reason,
	previousSha,
	patchId,
});

/** The patch-id recorded by a review, or null when the annotations hold none or several different ones. */
export const recordedPatchId = (messages: readonly string[]): string | null => {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!message.startsWith(RECORD_PREFIX)) continue;
		const id = message.slice(RECORD_PREFIX.length);
		if (!isPatchId(id)) return null;
		ids.add(id);
	}
	if (ids.size !== 1) return null;
	return [...ids][0] ?? null;
};

/** A `pull_request` run of ai-review.yml on exactly `sha` (`path` has no `@ref` suffix for that event). */
const isAiReviewRun = (run: WorkflowRun, sha: string): boolean =>
	run.path === AI_REVIEW_PATH && run.event === "pull_request" && run.headSha === sha;

/**
 * Whether a run of ai-review.yml was produced for `pullRequest` and not for another PR that shares its head sha
 * (TRA-526, 2026-10-24). Same shape as the `select_review` program of review-gate.yml, but NOT equal to it (TRA-529,
 * 2026-10-24: this comment used to say "to be kept equal"). It is deliberately stricter, so that a verdict is never
 * reused when the gate would refuse it: it also counts the PRs sitting on the PR's current head, where the gate has
 * a single head to look at. The test "ignores a PR against another base left on an older sha" pins that difference.
 * What it checks:
 * - `headPulls` lists the pull requests, open or not, whose head is this branch of this repository. Those sitting on
 *   the sha of the run (or on the PR's current head) count: if one targets another base, the two runs cannot be told
 *   apart (same branch, same sha, and `pull_requests[]` may be empty); a list that does not hold the PR means it is
 *   not established: both are "no". A PR of the same branch name left on an older sha says nothing and is ignored;
 * - the run was made for this head branch of this head repository (a PR from another branch, or from a fork whose
 *   branch has the same name, is another PR);
 * - `pull_requests[]`, when it is not empty, holds this PR and only PRs against this base (their current one: a
 *   retarget is caught by the `review-base` record, not here).
 */
export const belongsToPullRequest = (
	run: WorkflowRun,
	pullRequest: PullRequestIdentity,
	headPulls: readonly HeadPull[],
): boolean => {
	const sameBase = (pull: PullRef): boolean => pull.baseRef === pullRequest.baseRef;
	const relevant = headPulls.filter(
		(pull) =>
			pull.number === pullRequest.number ||
			pull.headSha === run.headSha ||
			pull.headSha === pullRequest.headSha,
	);
	const unambiguous = relevant.some((pull) => pull.number === pullRequest.number) && relevant.every(sameBase);
	if (!unambiguous) return false;
	if (run.headBranch !== pullRequest.headRef || run.headRepository !== pullRequest.headRepository)
		return false;
	return (
		run.pullRequests.length === 0 ||
		(run.pullRequests.some((pull) => pull.number === pullRequest.number) && run.pullRequests.every(sameBase))
	);
};

export interface ReviewEvidence {
	checkRuns: readonly ReviewCheckRun[];
	workflowRuns: readonly WorkflowRun[];
	jobs: readonly WorkflowJob[];
	/** The pull request being updated, and the pull requests that share its head (TRA-526). */
	pullRequest: PullRequestIdentity;
	headPulls: readonly HeadPull[];
}

/**
 * The review the gate reads for `sha`: the last by start time among the `review` check-runs that are the job of a
 * `pull_request` run of ai-review.yml on that exact sha, made for the pull request (review-gate.yml, TRA-520 and
 * TRA-526). A check-run counts only when the Actions app reported it, it belongs to the check suite of that run, and its id is the id of one of that run's jobs
 * named `review`. An API-created check-run has no job, whatever its name, app or start time. TRA-525 (2026-10-15):
 * the selection used to be the name and the app alone, so a `review` check-run written through the API on the
 * previous head by a workflow of any branch, with a valid record, was inherited by the next head.
 * Null when none qualifies, or when the latest two started together: which one the gate reads is then unknown
 * (the gate takes the last of the list there; reuse prefers a full review to a guess).
 */
export const latestReview = (sha: string, evidence: ReviewEvidence): ReviewCheckRun | null => {
	const trusted = evidence.workflowRuns.filter(
		(run) => isAiReviewRun(run, sha) && belongsToPullRequest(run, evidence.pullRequest, evidence.headPulls),
	);
	const isJobOfTrustedRun = (check: ReviewCheckRun): boolean =>
		trusted.some(
			(run) =>
				run.checkSuiteId === check.checkSuiteId &&
				evidence.jobs.some(
					(job) => job.runId === run.id && job.id === check.id && job.name === REVIEW_JOB_NAME,
				),
		);
	let last: ReviewCheckRun | null = null;
	let tied = false;
	for (const check of evidence.checkRuns) {
		if (check.name !== REVIEW_JOB_NAME || check.headSha !== sha || check.appSlug !== REVIEW_APP_SLUG)
			continue;
		if (!isJobOfTrustedRun(check)) continue;
		if (last === null || check.startedAt > last.startedAt) {
			last = check;
			tied = false;
		} else if (check.startedAt === last.startedAt && check.id !== last.id) tied = true;
	}
	return tied ? null : last;
};

/** What the workflow establishes with git and its context before asking; null/false means "could not tell". */
export interface Facts {
	/** `github.event.action` of the pull_request event. */
	action: string;
	/** `github.run_attempt`: a re-run never reuses. */
	runAttempt: number | null;
	/** Patch-id of the current head, or null when the workflow could not compute it. */
	patchId: string | null;
	/** `github.event.before`: the head the synchronize replaced. */
	previousSha: string | null;
	/** The PR's base branch and the repository's default branch (reuse only on the latter). */
	baseRef: string;
	defaultBranch: string;
	/** True when the previous head changed nothing under `.github/` compared with the default branch. */
	previousLeavesWorkflowsAlone: boolean | null;
	/** True when the head is a merge commit of `previousSha` (^1) and of a commit of the default branch (^2). */
	headIsUpdateMerge: boolean | null;
}

export interface DecisionInput extends Facts {
	/** `review` check-runs of the previous head; null when the API call failed or the listing is incomplete. */
	checkRuns: readonly ReviewCheckRun[] | null;
	/** `pull_request` runs of the previous head, and the jobs of those of ai-review.yml; null on the same terms. */
	workflowRuns: readonly WorkflowRun[] | null;
	jobs: readonly WorkflowJob[] | null;
	/** The pull request being updated and those sharing its head (TRA-526); null when they could not be read. */
	pullRequest: PullRequestIdentity | null;
	headPulls: readonly HeadPull[] | null;
	/** Annotation messages of the previous review's check-run; null when they could not be read. */
	annotations: readonly string[] | null;
}

/** Conditions that rule reuse out before the previous review is even looked up; null when none applies. */
export const precheck = (facts: Facts): ReuseResult | null => {
	const { patchId, previousSha } = facts;
	const no = (reason: string): ReuseResult => full(reason, previousSha, patchId);
	if (facts.action !== "synchronize") return no(`event ${facts.action} always gets a full review`);
	if (facts.runAttempt !== 1) return no("a re-run never reuses a verdict");
	if (!isPatchId(patchId)) return full("patch-id of the current head unavailable", previousSha, null);
	if (!isSha(previousSha)) return full("previous head unknown", null, patchId);
	// A stacked PR's base is unreviewed code: its updates are not "merge main", whatever their patch-id says.
	if (facts.defaultBranch === "" || facts.baseRef !== facts.defaultBranch)
		return no("base is not the default branch");
	// The record lives in an annotation any workflow step of the PR could have written (TRA-510 deep review):
	// a head that touched .github/ may have forged it, so its verdict is never inherited.
	if (facts.previousLeavesWorkflowsAlone !== true)
		return no("previous head touches .github/ or could not be checked");
	// "Only merges main" is verified, not assumed: a plain commit can move a hunk and keep the patch-id.
	if (facts.headIsUpdateMerge !== true)
		return no("head is not a merge of the default branch into the previous head");
	return null;
};

/** Pure decision, once the previous head's data has been fetched. */
export const decideReuse = (input: DecisionInput): ReuseResult => {
	const { patchId, previousSha } = input;
	const early = precheck(input);
	if (early !== null) return early;
	const no = (reason: string): ReuseResult => full(reason, previousSha, patchId);
	if (patchId === null || previousSha === null) return no("prechecked values missing");
	const { checkRuns, workflowRuns, jobs, pullRequest, headPulls } = input;
	if (checkRuns === null || workflowRuns === null || jobs === null)
		return no("previous review could not be listed");
	if (pullRequest === null || headPulls === null) return no("pull request could not be established");
	const review = latestReview(previousSha, { checkRuns, workflowRuns, jobs, pullRequest, headPulls });
	if (review === null) return no("no unambiguous previous review produced by ai-review.yml");
	if (review.status !== "completed") return no("previous review not finished");
	if (review.conclusion !== "success")
		return no(`previous review concluded ${review.conclusion ?? "nothing"}`);
	if (input.annotations === null) return no("previous review annotations unreadable");
	if (input.annotations.includes(BLOCKING_ANNOTATION)) return no("previous review had blocking findings");
	// TRA-529: the review must say it ran for this PR against the default branch. A review made against another
	// base (a stack parent later retargeted) or for another PR is not the review of this diff against the default branch.
	if (!hasBaseRecord(input.annotations, pullRequest.number, input.defaultBranch))
		return no("previous review did not record this pull request against the default branch");
	const recorded = recordedPatchId(input.annotations);
	if (recorded === null) return no("previous review recorded no usable patch-id");
	if (recorded !== patchId) return no("PR diff changed since the previous review");
	return { decision: "reuse", reason: reuseMessage(previousSha, patchId), previousSha, patchId };
};

export interface DecisionContext extends Facts {
	repository: string;
	/** Number of the pull request being updated (`GITHUB_REF` of the run); null when the run is not a PR's. */
	pullNumber: number | null;
	/** GET a GitHub REST path and return the parsed JSON body; rejects on any non-2xx answer. */
	get: (path: string) => Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const parseCheckRun = (raw: unknown): ReviewCheckRun => {
	if (!isRecord(raw)) throw new Error("unexpected check-run entry");
	const { id, name, status, conclusion, started_at: startedAt, app, head_sha: headSha } = raw;
	const suiteId = isRecord(raw.check_suite) ? raw.check_suite.id : undefined;
	if (typeof id !== "number" || typeof name !== "string" || typeof status !== "string") {
		throw new Error("unexpected check-run fields");
	}
	if (typeof startedAt !== "string") throw new Error("check-run without start time");
	if (!isSha(headSha) || typeof suiteId !== "number") throw new Error("check-run without sha or check suite");
	return {
		id,
		name,
		status,
		conclusion: typeof conclusion === "string" ? conclusion : null,
		startedAt,
		appSlug: isRecord(app) && typeof app.slug === "string" ? app.slug : null,
		headSha,
		checkSuiteId: suiteId,
	};
};

const parsePullRef = (raw: unknown): PullRef => {
	const base = isRecord(raw) ? raw.base : undefined;
	if (!isRecord(raw) || typeof raw.number !== "number" || !isRecord(base) || typeof base.ref !== "string") {
		throw new Error("unexpected pull request entry");
	}
	return { number: raw.number, baseRef: base.ref };
};

const parseHeadPull = (raw: unknown): HeadPull => {
	const head = isRecord(raw) ? raw.head : undefined;
	if (!isRecord(head) || !isSha(head.sha)) throw new Error("pull request without a head sha");
	return { ...parsePullRef(raw), headSha: head.sha };
};

const parsePullRequest = (raw: unknown): PullRequestIdentity => {
	const head = isRecord(raw) ? raw.head : undefined;
	const repo = isRecord(head) ? head.repo : undefined;
	if (
		!isRecord(head) ||
		typeof head.ref !== "string" ||
		!isRecord(repo) ||
		typeof repo.full_name !== "string"
	) {
		throw new Error("pull request without a head branch or repository");
	}
	return { ...parseHeadPull(raw), headRef: head.ref, headRepository: repo.full_name };
};

const parseWorkflowRun = (raw: unknown): WorkflowRun => {
	if (!isRecord(raw)) throw new Error("unexpected workflow run entry");
	const { id, path, event, head_sha: headSha, check_suite_id: checkSuiteId } = raw;
	if (typeof id !== "number" || typeof path !== "string" || typeof event !== "string") {
		throw new Error("unexpected workflow run fields");
	}
	if (!isSha(headSha) || typeof checkSuiteId !== "number") {
		throw new Error("workflow run without sha or check suite");
	}
	const { head_branch: headBranch, head_repository: headRepository, pull_requests: pullRequests } = raw;
	if (!Array.isArray(pullRequests)) throw new Error("workflow run without pull_requests");
	return {
		id,
		path,
		event,
		headSha,
		checkSuiteId,
		headBranch: typeof headBranch === "string" ? headBranch : null,
		headRepository:
			isRecord(headRepository) && typeof headRepository.full_name === "string"
				? headRepository.full_name
				: null,
		pullRequests: pullRequests.map(parsePullRef),
	};
};

const parseJob = (raw: unknown): WorkflowJob => {
	if (!isRecord(raw)) throw new Error("unexpected job entry");
	const { id, name, run_id: runId } = raw;
	if (typeof id !== "number" || typeof name !== "string" || typeof runId !== "number") {
		throw new Error("unexpected job fields");
	}
	return { id, name, runId };
};

/** Every item of a paginated GitHub listing; throws when it cannot be read to the end (never a partial list). */
const listAll = async <T>(
	get: (path: string) => Promise<unknown>,
	path: string,
	key: string,
	parse: (raw: unknown) => T,
): Promise<T[]> => {
	const items: T[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const separator = path.includes("?") ? "&" : "?";
		const body = await get(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
		const entries = isRecord(body) ? body[key] : undefined;
		if (!isRecord(body) || !Array.isArray(entries) || typeof body.total_count !== "number") {
			throw new Error(`unexpected ${key} payload`);
		}
		items.push(...entries.map(parse));
		if (items.length >= body.total_count) return items;
		if (entries.length === 0) throw new Error(`${key} listing ended before its total`);
	}
	throw new Error(`${key} listing exceeds ${MAX_PAGES} pages`);
};

/** Every pull request, open or not, whose head is the branch of `pull`; throws rather than return a partial list. */
const listHeadPulls = async (
	get: (path: string) => Promise<unknown>,
	base: string,
	pull: PullRequestIdentity,
): Promise<HeadPull[]> => {
	// `head` is `<owner>:<branch>`; the branch name is chosen by the PR author, so it is encoded.
	const head = encodeURIComponent(`${pull.headRepository.split("/")[0] ?? ""}:${pull.headRef}`);
	const items: HeadPull[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const body = await get(`${base}/pulls?head=${head}&state=all&per_page=${PAGE_SIZE}&page=${page}`);
		if (!Array.isArray(body)) throw new Error("unexpected pulls payload");
		items.push(...body.map(parseHeadPull));
		if (body.length < PAGE_SIZE) return items;
	}
	throw new Error(`pulls listing exceeds ${MAX_PAGES} pages`);
};

const parseAnnotations = (body: unknown): string[] => {
	if (!Array.isArray(body)) throw new Error("unexpected annotations payload");
	// A full page may hide a blocking annotation on the next one; a success review never has that many.
	if (body.length >= PAGE_SIZE) throw new Error("annotations may be truncated");
	return body.map((raw: unknown) => {
		if (!isRecord(raw) || typeof raw.message !== "string") throw new Error("unexpected annotation entry");
		return raw.message;
	});
};

/** Fetches the previous head's review from the GitHub API and decides. Any error is a full review. */
export const resolveDecision = async (ctx: DecisionContext): Promise<ReuseResult> => {
	const { repository, pullNumber, get, ...facts } = ctx;
	const { patchId, previousSha } = facts;
	// Cheap checks first, so a `ready_for_review` or a missing patch-id never touches the API.
	const early = precheck(facts);
	if (early !== null) return early;
	try {
		if (!REPOSITORY.test(repository)) throw new Error("invalid repository");
		if (!isSha(previousSha)) throw new Error("previous head unknown");
		if (pullNumber === null) throw new Error("not a pull request run");
		const base = `repos/${repository}`;
		// TRA-526: which pull request is updated, and which share its head, before any run is looked at.
		const pullRequest = parsePullRequest(await get(`${base}/pulls/${pullNumber}`));
		if (pullRequest.number !== pullNumber) throw new Error("unexpected pull request");
		// The event said which base the review ran against; a retargeted PR is no longer the one that was reviewed.
		if (pullRequest.baseRef !== facts.baseRef) throw new Error("pull request base differs from the event's");
		const headPulls = await listHeadPulls(get, base, pullRequest);
		const checkRuns = await listAll(
			get,
			`${base}/commits/${previousSha}/check-runs?check_name=review&filter=all`,
			"check_runs",
			parseCheckRun,
		);
		const workflowRuns = await listAll(
			get,
			`${base}/actions/runs?head_sha=${previousSha}&event=pull_request`,
			"workflow_runs",
			parseWorkflowRun,
		);
		// Jobs are only listed for the runs that can matter: ai-review.yml, owning a check suite seen above.
		const suites = new Set(checkRuns.map((check) => check.checkSuiteId));
		const candidates = workflowRuns.filter(
			(run) =>
				isAiReviewRun(run, previousSha) &&
				belongsToPullRequest(run, pullRequest, headPulls) &&
				suites.has(run.checkSuiteId),
		);
		if (candidates.length > MAX_RUNS_LISTED) throw new Error("too many runs of ai-review.yml on the head");
		const jobs: WorkflowJob[] = [];
		for (const run of candidates) {
			// `filter=all` as the gate does: the check-run of a re-run attempt is the job of an earlier attempt.
			jobs.push(...(await listAll(get, `${base}/actions/runs/${run.id}/jobs?filter=all`, "jobs", parseJob)));
		}
		const review = latestReview(previousSha, { checkRuns, workflowRuns, jobs, pullRequest, headPulls });
		const annotations =
			review !== null && review.status === "completed" && review.conclusion === "success"
				? parseAnnotations(await get(`${base}/check-runs/${review.id}/annotations?per_page=${PAGE_SIZE}`))
				: null;
		return decideReuse({ ...facts, checkRuns, workflowRuns, jobs, pullRequest, headPulls, annotations });
	} catch (error) {
		return full(
			`lookup failed: ${error instanceof Error ? error.message : String(error)}`,
			previousSha,
			patchId,
		);
	}
};

const main = async (): Promise<void> => {
	const env = process.env;
	const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
	const get = async (path: string): Promise<unknown> => {
		const response = await fetch(`${apiUrl}/${path}`, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${env.GH_TOKEN ?? ""}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) throw new Error(`GitHub API answered ${response.status} for ${path.split("?")[0]}`);
		return response.json();
	};
	const text = (name: string): string | null =>
		env[name] === undefined || env[name] === "" ? null : (env[name] as string);
	// Facts that git could not establish arrive empty and stay null: only the exact words "true"/"false" count.
	const flag = (name: string): boolean | null =>
		env[name] === "true" ? true : env[name] === "false" ? false : null;
	const attempt = Number(env.RUN_ATTEMPT);
	// `GITHUB_REF` of a pull_request run is `refs/pull/<number>/merge`, set by the runner (the workflow passes no PR
	// number); anything else leaves the pull request unknown, which means a full review.
	const pullMatch = /^refs\/pull\/(\d+)\/merge$/.exec(env.GITHUB_REF ?? "");
	const result = await resolveDecision({
		pullNumber: pullMatch?.[1] === undefined ? null : Number(pullMatch[1]),
		action: env.EVENT_ACTION ?? "",
		runAttempt: Number.isInteger(attempt) ? attempt : null,
		patchId: text("PATCH_ID"),
		previousSha: text("PREVIOUS_SHA"),
		baseRef: env.BASE_REF ?? "",
		defaultBranch: env.DEFAULT_BRANCH ?? "",
		previousLeavesWorkflowsAlone: flag("PREVIOUS_LEAVES_WORKFLOWS_ALONE"),
		headIsUpdateMerge: flag("HEAD_IS_UPDATE_MERGE"),
		repository: env.REPOSITORY ?? "",
		get,
	});
	console.log(JSON.stringify(result));
};

if (process.argv[1]?.endsWith("review-reuse.ts")) {
	main().catch((error: unknown) => {
		console.log(JSON.stringify(full(`crashed: ${String(error)}`, null, null)));
	});
}
