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
}

// Must stay equal to the annotation the `Gate` step of ai-review.yml emits and review-gate.yml matches.
export const BLOCKING_ANNOTATION = "Findings bloquants — voir les commentaires inline.";
export const RECORD_VERSION = "v1";
export const RECORD_PREFIX = `review-patch-id ${RECORD_VERSION} `;
// Check-runs of Actions jobs belong to this app; a `review` check-run published by anything else is not trusted.
export const REVIEW_APP_SLUG = "github-actions";
// Page size of the annotations and check-runs queries: a full page may hide a blocking annotation.
export const PAGE_SIZE = 100;

// "<git patch-id --verbatim>-<hash of the mode/create/delete summary>", computed by the workflow on the git tree.
const PATCH_ID = /^[0-9a-f]{40}-[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

export const isPatchId = (value: unknown): value is string =>
	typeof value === "string" && PATCH_ID.test(value);
export const isSha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);

export const recordMessage = (patchId: string): string => `${RECORD_PREFIX}${patchId}`;

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

/** The review the gate reads for a head: the last `review` check-run by start time (review-gate.yml). */
export const latestReview = (checkRuns: readonly ReviewCheckRun[]): ReviewCheckRun | null => {
	const reviews = checkRuns.filter((run) => run.name === "review");
	let last: ReviewCheckRun | null = null;
	for (const run of reviews) if (last === null || run.startedAt >= last.startedAt) last = run;
	return last;
};

export interface DecisionInput {
	/** `github.event.action` of the pull_request event. */
	action: string;
	/** Patch-id of the current head, or null when the workflow could not compute it. */
	patchId: string | null;
	/** `github.event.before`: the head the synchronize replaced. */
	previousSha: string | null;
	/** `review` check-runs of the previous head; null when the API call failed. */
	checkRuns: readonly ReviewCheckRun[] | null;
	/** True when the check-runs listing may be truncated. */
	checkRunsTruncated: boolean;
	/** Annotation messages of the previous review's check-run; null when they could not be read. */
	annotations: readonly string[] | null;
}

/** Conditions that rule reuse out before the previous review is even looked up; null when none applies. */
export const precheck = (
	action: string,
	patchId: string | null,
	previousSha: string | null,
): ReuseResult | null => {
	if (action !== "synchronize")
		return full(`event ${action} always gets a full review`, previousSha, patchId);
	if (!isPatchId(patchId)) return full("patch-id of the current head unavailable", previousSha, null);
	if (!isSha(previousSha)) return full("previous head unknown", null, patchId);
	return null;
};

/** Pure decision, once the previous head's data has been fetched. */
export const decideReuse = (input: DecisionInput): ReuseResult => {
	const { patchId, previousSha } = input;
	const early = precheck(input.action, patchId, previousSha);
	if (early !== null) return early;
	const no = (reason: string): ReuseResult => full(reason, previousSha, patchId);
	if (patchId === null || previousSha === null) return no("prechecked values missing");
	if (input.checkRuns === null || input.checkRunsTruncated) return no("previous review could not be listed");
	const review = latestReview(input.checkRuns);
	if (review === null) return no("no previous review");
	if (review.appSlug !== REVIEW_APP_SLUG) return no("previous review not published by Actions");
	if (review.status !== "completed") return no("previous review not finished");
	if (review.conclusion !== "success")
		return no(`previous review concluded ${review.conclusion ?? "nothing"}`);
	if (input.annotations === null) return no("previous review annotations unreadable");
	if (input.annotations.includes(BLOCKING_ANNOTATION)) return no("previous review had blocking findings");
	const recorded = recordedPatchId(input.annotations);
	if (recorded === null) return no("previous review recorded no usable patch-id");
	if (recorded !== patchId) return no("PR diff changed since the previous review");
	return { decision: "reuse", reason: reuseMessage(previousSha, patchId), previousSha, patchId };
};

export interface DecisionContext {
	action: string;
	patchId: string | null;
	previousSha: string | null;
	repository: string;
	/** GET a GitHub REST path and return the parsed JSON body; rejects on any non-2xx answer. */
	get: (path: string) => Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const parseCheckRuns = (body: unknown): { runs: ReviewCheckRun[]; truncated: boolean } => {
	if (!isRecord(body) || !Array.isArray(body.check_runs)) throw new Error("unexpected check-runs payload");
	const runs = body.check_runs.map((raw: unknown): ReviewCheckRun => {
		if (!isRecord(raw)) throw new Error("unexpected check-run entry");
		const { id, name, status, conclusion, started_at: startedAt, app } = raw;
		if (typeof id !== "number" || typeof name !== "string" || typeof status !== "string") {
			throw new Error("unexpected check-run fields");
		}
		if (typeof startedAt !== "string") throw new Error("check-run without start time");
		return {
			id,
			name,
			status,
			conclusion: typeof conclusion === "string" ? conclusion : null,
			startedAt,
			appSlug: isRecord(app) && typeof app.slug === "string" ? app.slug : null,
		};
	});
	const total = typeof body.total_count === "number" ? body.total_count : Number.POSITIVE_INFINITY;
	return { runs, truncated: runs.length >= PAGE_SIZE || total > runs.length };
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
	const { action, patchId, previousSha, repository } = ctx;
	// Cheap checks first, so a `ready_for_review` or a missing patch-id never touches the API.
	const early = precheck(action, patchId, previousSha);
	if (early !== null) return early;
	try {
		if (!REPOSITORY.test(repository)) throw new Error("invalid repository");
		const base = `repos/${repository}`;
		const listing = await ctx.get(
			`${base}/commits/${previousSha}/check-runs?check_name=review&filter=all&per_page=${PAGE_SIZE}`,
		);
		const { runs, truncated } = parseCheckRuns(listing);
		const review = latestReview(runs);
		const annotations =
			review !== null && review.status === "completed" && review.conclusion === "success"
				? parseAnnotations(await ctx.get(`${base}/check-runs/${review.id}/annotations?per_page=${PAGE_SIZE}`))
				: null;
		return decideReuse({
			action,
			patchId,
			previousSha,
			checkRuns: runs,
			checkRunsTruncated: truncated,
			annotations,
		});
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
	const result = await resolveDecision({
		action: env.EVENT_ACTION ?? "",
		patchId: env.PATCH_ID === undefined || env.PATCH_ID === "" ? null : env.PATCH_ID,
		previousSha: env.PREVIOUS_SHA === undefined || env.PREVIOUS_SHA === "" ? null : env.PREVIOUS_SHA,
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
