export type Tier = 1 | 2 | 3;
export type ReviewState = "missing" | "pending" | "success" | "failure" | "error" | "stale";
export type GateVerdict = "pass" | "wait" | "block";

export interface OrdinaryReview {
	claude: ReviewState;
	codex: ReviewState;
	claudeBlocking: boolean;
}

export interface GateInput {
	risk: Tier;
	ordinary: OrdinaryReview;
	deep: ReviewState;
}

const sensitivePath =
	/(^|\/)(auth|payment[s]?|migrations|infra|deploy)\/|^\.github\/|^scripts\/(deploy-|ci\/review-gate-policy)|^\.codex\/scripts\/publish-review-status\.sh$|\.sql$|secrets/;

export const classifyRisk = (paths: readonly string[], labels: readonly string[]): Tier => {
	if (paths.some((path) => sensitivePath.test(path)) || labels.includes("tier/3")) return 3;
	if (labels.includes("tier/2")) return 2;
	return 1;
};

const ordinaryVerdict = (review: OrdinaryReview): GateVerdict => {
	if (review.codex === "failure" || review.claudeBlocking) return "block";
	if (review.claude === "success") return "pass";
	if (review.claude !== "missing" && review.codex === "success") return "pass";
	return "wait";
};

export const evaluateReviewGate = (input: GateInput): GateVerdict => {
	const ordinary = ordinaryVerdict(input.ordinary);
	if (ordinary !== "pass") return ordinary;
	if (input.risk < 3) return "pass";
	if (input.deep === "failure") return "block";
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
