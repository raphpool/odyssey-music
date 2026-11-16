import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
	type CheckConclusion,
	classifyRisk,
	evaluateReviewGate,
	gateIntegrityPath,
} from "../scripts/ci/review-gate-policy.js";

describe("review gate policy", () => {
	it("requires a deep review for a sensitive diff despite a tier/1 label and ordinary success", () => {
		const risk = classifyRisk([".github/workflows/ci.yml"], ["tier/1"]);
		const verdict = evaluateReviewGate({
			risk,
			ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
			deep: "missing",
			touchesGate: false,
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
				touchesGate: false,
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
				touchesGate: false,
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
					touchesGate: false,
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
					touchesGate: false,
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
				touchesGate: false,
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
					touchesGate: false,
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
				touchesGate: false,
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
				touchesGate: false,
			}),
		).toBe("pass");
	});

	it("never masks a deep blocking verdict after a tier is lowered", () => {
		expect(
			evaluateReviewGate({
				risk: 1,
				ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
				deep: "failure",
				touchesGate: false,
			}),
		).toBe("block");
	});

	// TRA-704 (2026-11-16): a Claude deep review run by Actions (`deepClaude`) replaces the Mac-published
	// `codex-deep-review` (`deep`), except for a PR that edits the gate itself, which would be judged by its own copy.
	describe("deepClaude (tier/3)", () => {
		const ordinary = { claude: "success", codex: "missing", claudeBlocking: false } as const;

		it("passes on deepClaude success when the PR does not touch the gate", () => {
			expect(
				evaluateReviewGate({ risk: 3, ordinary, deep: "missing", deepClaude: "success", touchesGate: false }),
			).toBe("pass");
		});

		it("waits on deepClaude success when the PR touches the gate", () => {
			expect(
				evaluateReviewGate({ risk: 3, ordinary, deep: "missing", deepClaude: "success", touchesGate: true }),
			).toBe("wait");
		});

		// Per the TRA-704 contract: a failed deep-review job blocks even over a codex deep success (re-run to recover).
		it.each(["missing", "pending", "success", "failure", "error", "stale"] as const)(
			"blocks on deepClaude failure whatever deep is (%s)",
			(deep) => {
				for (const touchesGate of [false, true]) {
					expect(evaluateReviewGate({ risk: 3, ordinary, deep, deepClaude: "failure", touchesGate })).toBe(
						"block",
					);
				}
			},
		);

		it("passes on codex deep success even when the PR touches the gate", () => {
			expect(
				evaluateReviewGate({ risk: 3, ordinary, deep: "success", deepClaude: "missing", touchesGate: true }),
			).toBe("pass");
		});

		it.each([
			"missing",
			"pending",
			"cancelled",
			"timed_out",
			"skipped",
			"neutral",
			"stale",
			"error",
		] as const)("waits on deepClaude %s", (deepClaude) => {
			expect(evaluateReviewGate({ risk: 3, ordinary, deep: "missing", deepClaude, touchesGate: false })).toBe(
				"wait",
			);
		});

		it("behaves as before when deepClaude is absent (old review-gate.yml)", () => {
			expect(evaluateReviewGate({ risk: 3, ordinary, deep: "missing", touchesGate: false })).toBe("wait");
			expect(evaluateReviewGate({ risk: 3, ordinary, deep: "success", touchesGate: false })).toBe("pass");
			expect(evaluateReviewGate({ risk: 3, ordinary, deep: "failure", touchesGate: false })).toBe("block");
		});

		it("never lets deepClaude success mask an ordinary blocking finding", () => {
			expect(
				evaluateReviewGate({
					risk: 3,
					ordinary: { claude: "failure", codex: "success", claudeBlocking: true },
					deep: "missing",
					deepClaude: "success",
					touchesGate: false,
				}),
			).toBe("block");
		});

		it("ignores deepClaude below tier/3", () => {
			for (const risk of [1, 2] as const) {
				expect(
					evaluateReviewGate({ risk, ordinary, deep: "missing", deepClaude: "failure", touchesGate: false }),
				).toBe("pass");
			}
		});
	});

	describe("gateIntegrityPath", () => {
		it.each([
			".github/workflows/ai-review.yml",
			".github/workflows/review-gate.yml",
			".github/review-gate-authors.txt",
			"scripts/ci/review-gate-policy.ts",
			"scripts/ci/review-reuse.ts",
			"REVIEW.md",
			".codex/scripts/publish-review-status.sh",
		])("recognizes %s", (path) => {
			expect(gateIntegrityPath.test(path)).toBe(true);
		});

		// Prefix match, like sensitivePath: a new file next to the policy is part of the gate too.
		it.each([
			"scripts/ci/review-gate-policy.test-helper.ts",
			"scripts/ci/review-reuse-cache.ts",
			"review.md",
		])("recognizes %s (prefix match, case-insensitive)", (path) => {
			expect(gateIntegrityPath.test(path)).toBe(true);
		});

		// A gate file that sensitivePath did not escalate would never reach the tier/3 rule that reads touchesGate.
		it.each([
			".github/workflows/ai-review.yml",
			".github/workflows/review-gate.yml",
			".github/review-gate-authors.txt",
			"scripts/ci/review-gate-policy.ts",
			"scripts/ci/review-reuse.ts",
			"REVIEW.md",
			".codex/scripts/publish-review-status.sh",
		])("%s is also tier/3 for sensitivePath", (path) => {
			expect(classifyRisk([path], [])).toBe(3);
		});

		// APFS of the self-hosted runners ignores case (TRA-553); the pattern follows sensitivePath.
		it("matches case-insensitively", () => {
			expect(gateIntegrityPath.test(".GITHUB/workflows/AI-Review.yml")).toBe(true);
		});

		it.each([
			".github/workflows/ci.yml",
			".github/workflows/ai-review.yaml",
			"foo/REVIEW.md",
			"docs/REVIEW.md",
			"REVIEW.md.bak",
			"scripts/ci/threshold-ratchet.ts",
			".github/review-gate-authors.txt.bak",
		])("does not recognize %s", (path) => {
			expect(gateIntegrityPath.test(path)).toBe(false);
		});
	});

	// The CLI is what the gate really runs: it must derive touchesGate from `paths` itself and ignore whatever the
	// JSON says, otherwise a caller (or a forged input) could clear it.
	describe("CLI wiring of touchesGate", () => {
		const run = (paths: string[], extra: Record<string, unknown> = {}): { risk: number; verdict: string } =>
			JSON.parse(
				execFileSync(
					"npx",
					[
						"--no-install",
						"tsx",
						"scripts/ci/review-gate-policy.ts",
						JSON.stringify({
							paths,
							labels: [],
							ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
							deep: "missing",
							deepClaude: "success",
							...extra,
						}),
					],
					{ encoding: "utf8" },
				),
			);

		it("passes a tier/3 PR that does not touch the gate on deepClaude success", () => {
			expect(run(["infra/app.yml"])).toEqual({ risk: 3, verdict: "pass" });
		});

		it("waits when any path is a gate file, even if the JSON claims touchesGate is false", () => {
			expect(run(["infra/app.yml", ".github/workflows/ai-review.yml"], { touchesGate: false }).verdict).toBe(
				"wait",
			);
		});

		it("derives touchesGate from paths when the JSON omits it", () => {
			expect(run(["scripts/ci/review-gate-policy.ts"]).verdict).toBe("wait");
		});
	});
});
