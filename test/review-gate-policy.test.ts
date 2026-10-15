import { describe, expect, it } from "vitest";

import { classifyRisk, evaluateReviewGate } from "../scripts/ci/review-gate-policy.js";

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

	it("does not escalate on lookalike paths", () => {
		expect(classifyRisk(["data/genre-catalog.json", "scripts/audit-cache-notes.md"], [])).toBe(1);
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
