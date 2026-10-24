export type Tier = 1 | 2 | 3;
export type ReviewState = "missing" | "pending" | "success" | "failure" | "error" | "stale";
export type GateVerdict = "pass" | "wait" | "block";

// Conclusions of a GitHub check-run (plus `missing` for "no conclusion yet"). The `review` check-run of
// ai-review.yml is not a commit status, so it can end in states that a ReviewState does not model.
export type CheckConclusion =
	| ReviewState
	| "neutral"
	| "cancelled"
	| "timed_out"
	| "skipped"
	| "action_required";

export interface OrdinaryReview {
	claude: CheckConclusion;
	codex: ReviewState;
	claudeBlocking: boolean;
}

export interface GateInput {
	risk: Tier;
	ordinary: OrdinaryReview;
	deep: ReviewState;
}

// TRA-498 (2026-10-14): the integrity gate (audit, ratchet, committed ceilings) is only worth anything if a
// tier/1 PR cannot weaken it, so its three files escalate like the workflow that runs it. TRA-521 (2026-10-15):
// scripts/ci/review-reuse.ts decides whether the AI review verdict is reused (TRA-510), so it escalates the same
// way (prefix match, like review-gate-policy). TRA-522 (2026-10-15): ai-review.yml checks out the PR merge ref and
// its prompt reads the root REVIEW.md, so a tier/1 PR editing it would be reviewed under its own calibration
// rules; it escalates too, anchored at the root (docs/REVIEW.md does not). TRA-553 (2026-10-15): the pattern is
// case-insensitive (flag `i`) because the self-hosted runners are on macOS, whose default APFS volume ignores
// case: `review.md` checks out over `REVIEW.md` and would otherwise dodge the escalation. Keep in sync with
// the grep of the `tier-guard` job in .github/workflows/ci.yml, which is this pattern with `\/` written `/` and
// the flag `i` written `-i` (test/ci-integrity-job.test.ts compares the two text-for-text and on a corpus of paths).
export const sensitivePath =
	/(^|\/)(auth|payment[s]?|migrations|infra|deploy)\/|^\.github\/|^scripts\/(deploy-|ci\/review-gate-policy|ci\/review-reuse|ci\/threshold-ratchet\.ts$|audit-cache\.ts$)|^data\/integrity-thresholds\.json$|^\.codex\/scripts\/publish-review-status\.sh$|^REVIEW\.md$|\.sql$|secrets/i;

export const classifyRisk = (paths: readonly string[], labels: readonly string[]): Tier => {
	if (paths.some((path) => sensitivePath.test(path)) || labels.includes("tier/3")) return 3;
	if (labels.includes("tier/2")) return 2;
	return 1;
};

// TRA-524 (2026-10-24): a Claude review "is there" only if the job ran to a verdict. `cancelled` and `timed_out`
// (the 25-minute timeout of ai-review.yml) used to count as present, so with `codex-review: success` the gate
// passed although no Claude review had completed. `skipped`, `stale` and `action_required` did not review
// anything either. The allowlist fails closed: a conclusion GitHub adds later waits instead of passing.
// `failure` stays present: the review ran and `claudeBlocking` already carries its blocking findings.
// `neutral` stays present on purpose (TRA-524 decision): ai-review.yml never ends a job that way (a job
// concludes success, failure, cancelled, skipped or timed_out), so it has no effect in practice.
// The same three conclusions are listed in the `select_review` jq program of review-gate.yml, which maps the
// others to `missing` before they get here. The list is deliberately held twice: this copy is the one executed
// from the default branch, so it also protects a PR whose own review-gate.yml still forwards the raw conclusion.
// Keep the two in sync (test/review-gate-workflow.test.ts runs both on every conclusion).
const completedClaudeReview: ReadonlySet<CheckConclusion> = new Set(["success", "failure", "neutral"]);

const ordinaryVerdict = (review: OrdinaryReview): GateVerdict => {
	if (review.codex === "failure" || review.claudeBlocking) return "block";
	if (review.claude === "success") return "pass";
	if (completedClaudeReview.has(review.claude) && review.codex === "success") return "pass";
	return "wait";
};

export const evaluateReviewGate = (input: GateInput): GateVerdict => {
	const ordinary = ordinaryVerdict(input.ordinary);
	if (ordinary !== "pass") return ordinary;
	if (input.deep === "failure") return "block";
	if (input.risk < 3) return "pass";
	return input.deep === "success" ? "pass" : "wait";
};

const main = (): void => {
	const encoded = process.argv[2];
	if (encoded === undefined) throw new Error("Usage: review-gate-policy.ts <json-input>");
	const input = JSON.parse(encoded) as GateInput & { paths: string[]; labels: string[] };
	const risk = classifyRisk(input.paths, input.labels);
	console.log(JSON.stringify({ risk, verdict: evaluateReviewGate({ ...input, risk }) }));
};

if (process.argv[1]?.endsWith("review-gate-policy.ts")) main();
