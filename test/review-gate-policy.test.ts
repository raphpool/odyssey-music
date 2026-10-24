import { describe, expect, it } from "vitest";

import { type CheckConclusion, classifyRisk, evaluateReviewGate } from "../scripts/ci/review-gate-policy.js";

describe("review gate policy", () => {
	it("requires a deep review for a sensitive diff despite a tier/1 label and ordinary success", () => {
		const risk = classifyRisk([".github/workflows/ci.yml"], ["tier/1"]);
		const verdict = evaluateReviewGate({
			risk,
			ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
			deep: "missing",
		});

		expect(risk).toBe(3);
		expect(verdict).toBe("wait");
	});

	it("passes tier/3 only when ordinary and deep reviews both pass", () => {
		const risk = classifyRisk(["infra/app.yml"], []);
		expect(
			evaluateReviewGate({
				risk,
				ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
				deep: "success",
			}),
		).toBe("pass");
	});

	// TRA-498: these files decide whether the integrity job can ever go red; a tier/1 PR must not change them.
	it.each(["data/integrity-thresholds.json", "scripts/ci/threshold-ratchet.ts", "scripts/audit-cache.ts"])(
		"classifies a PR that only touches %s as tier/3, whatever its label",
		(path) => {
			expect(classifyRisk([path], [])).toBe(3);
			expect(classifyRisk([path], ["tier/1"])).toBe(3);
		},
	);

	// TRA-522 / TRA-521 / TRA-553: the review prompt's calibration file and the script that decides verdict reuse.
	// `review.md` is `REVIEW.md` on the case-insensitive APFS of the self-hosted runners.
	it.each([
		"REVIEW.md",
		"review.md",
		"Review.MD",
		"scripts/ci/review-reuse.ts",
		"Scripts/CI/Review-Reuse.ts",
	])("classifies a PR that only touches %s as tier/3, whatever its label", (path) => {
		expect(classifyRisk([path], [])).toBe(3);
		expect(classifyRisk([path], ["tier/1"])).toBe(3);
		expect(classifyRisk([path], ["tier/2"])).toBe(3);
	});

	it("does not escalate on lookalike paths", () => {
		expect(classifyRisk(["data/genre-catalog.json", "scripts/audit-cache-notes.md"], [])).toBe(1);
		expect(classifyRisk(["docs/REVIEW.md", "REVIEW.md.bak"], [])).toBe(1);
	});

	it("does not allow deep success to mask an ordinary blocking finding", () => {
		expect(
			evaluateReviewGate({
				risk: 3,
				ordinary: { claude: "failure", codex: "success", claudeBlocking: true },
				deep: "success",
			}),
		).toBe("block");
	});

	it.each(["missing", "pending", "failure", "error", "stale"] as const)(
		"blocks incomplete deep review state %s",
		(deep) => {
			expect(
				evaluateReviewGate({
					risk: 3,
					ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
					deep,
				}),
			).toBe(deep === "failure" ? "block" : "wait");
		},
	);

	// TRA-524: a Claude review that never completed is not a review. Before the fix `cancelled` and `timed_out`
	// counted as present and, with codex-review in success, the gate passed. The set also covers the states
	// that the job never reports (`pending`) and a conclusion that GitHub could add.
	it.each([
		"missing",
		"pending",
		"cancelled",
		"timed_out",
		"skipped",
		"stale",
		"action_required",
		"error",
	] as const)("waits when the Claude review is %s, even with codex-review in success", (claude) => {
		for (const risk of [1, 2] as const) {
			expect(
				evaluateReviewGate({
					risk,
					ordinary: { claude, codex: "success", claudeBlocking: false },
					deep: "missing",
				}),
			).toBe("wait");
		}
	});

	it("waits on a conclusion it does not know, instead of reading it as a review", () => {
		const unknown = "something_github_adds_later" as unknown as CheckConclusion;
		expect(
			evaluateReviewGate({
				risk: 1,
				ordinary: { claude: unknown, codex: "success", claudeBlocking: false },
				deep: "missing",
			}),
		).toBe("wait");
	});

	it.each(["failure", "neutral"] as const)(
		"passes a completed Claude review (%s, non blocking) with codex-review in success",
		(claude) => {
			expect(
				evaluateReviewGate({
					risk: 1,
					ordinary: { claude, codex: "success", claudeBlocking: false },
					deep: "missing",
				}),
			).toBe("pass");
		},
	);

	it("does not let a cancelled Claude review hide a codex failure", () => {
		expect(
			evaluateReviewGate({
				risk: 1,
				ordinary: { claude: "cancelled", codex: "failure", claudeBlocking: false },
				deep: "missing",
			}),
		).toBe("block");
	});

	it("keeps tier/1 and tier/2 on the ordinary review policy", () => {
		expect(classifyRisk(["src/graph.ts"], ["tier/2"])).toBe(2);
		expect(
			evaluateReviewGate({
				risk: 2,
				ordinary: { claude: "failure", codex: "success", claudeBlocking: false },
				deep: "missing",
			}),
		).toBe("pass");
	});

	it("never masks a deep blocking verdict after a tier is lowered", () => {
		expect(
			evaluateReviewGate({
				risk: 1,
				ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
				deep: "failure",
			}),
		).toBe("block");
	});
});
