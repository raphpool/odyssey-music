import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	type CheckConclusion,
	classifyRisk,
	evaluateReviewGate,
	type FileChange,
	gateIntegrityPath,
	isL10nOnlyAddition,
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
			// Prefix match like sensitivePath (a new file next to the policy is part of the gate), and case-insensitive.
			"scripts/ci/review-gate-policy.test-helper.ts",
			"scripts/ci/review-reuse-cache.ts",
			"review.md",
		])("recognizes %s", (path) => {
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

		// The JSON carries no touchesGate here: a pass proves the CLI derived it from `paths`.
		it("passes a tier/3 PR that does not touch the gate on deepClaude success", () => {
			expect(run(["infra/app.yml"])).toEqual({ risk: 3, verdict: "pass" });
		});

		it("waits when any path is a gate file, even if the JSON claims touchesGate is false", () => {
			expect(run(["infra/app.yml", ".github/workflows/ai-review.yml"], { touchesGate: false }).verdict).toBe(
				"wait",
			);
		});
	});

	// TRA-841 (2026-11-26): a tier/3 data PR that only adds `l10n` blocks needs no deep review (#738 hit the 60-turn
	// limit twice); anything else under tier/3 keeps it.
	describe("l10n-only cache PR (TRA-841)", () => {
		const node = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
			id: "project:abbey-road",
			type: "project",
			name: "Abbey Road",
			year: 1969,
			links: [{ rel: "wikipedia", url: "https://en.wikipedia.org/wiki/Abbey_Road" }],
			...extra,
		});
		// The shape of `nodeTranslationSchema` (src/schemas.ts).
		const fr = {
			teaser: "Un album des Beatles.",
			article: "Un long article en français.",
			facts: { genre: "rock" },
			source_sha256: "a".repeat(64),
			model: "gemini-3.1-flash-lite",
			translated_at: "2026-11-26T10:00:00.000Z",
		};
		const modified = (
			base: unknown,
			head: unknown,
			path = "cache/nodes/project/abbey-road.json",
		): FileChange => ({
			path,
			status: "M",
			base: JSON.stringify(base),
			head: JSON.stringify(head),
		});

		describe("isL10nOnlyAddition", () => {
			it("accepts a node that only gains l10n.fr, whatever the key order", () => {
				const reordered = {
					year: 1969,
					links: node().links,
					name: "Abbey Road",
					type: "project",
					id: "project:abbey-road",
				};
				expect(isL10nOnlyAddition([modified(node(), node({ l10n: { fr } }))])).toBe(true);
				expect(isL10nOnlyAddition([modified(node(), { ...reordered, l10n: { fr } })])).toBe(true);
			});

			it("accepts a case like #738: 30 project nodes that only gain l10n.fr", () => {
				const changes = Array.from({ length: 30 }, (_, i) =>
					modified(
						node({ id: `project:p${i}` }),
						node({ id: `project:p${i}`, l10n: { fr } }),
						`cache/nodes/project/p${i}.json`,
					),
				);
				expect(isL10nOnlyAddition(changes)).toBe(true);
			});

			it("accepts a block without the optional facts", () => {
				const { facts: _facts, ...withoutFacts } = fr;
				expect(isL10nOnlyAddition([modified(node(), node({ l10n: { fr: withoutFacts } }))])).toBe(true);
			});

			// A hand-edited file does not go through Zod: the shape of the added block is checked here too.
			it.each([
				["a locale the schema does not declare", { es: fr }],
				["a locale next to fr", { fr, es: fr }],
				["a key the schema does not declare", { fr: { ...fr, injected: "x" } }],
				["a non-string value", { fr: { ...fr, teaser: 1 } }],
				["a non-string fact", { fr: { ...fr, facts: { genre: ["rock"] } } }],
				["facts that is not an object", { fr: { ...fr, facts: "rock" } }],
				["a block that is an array", { fr: [fr] }],
			])("refuses %s", (_label, l10n) => {
				expect(isL10nOnlyAddition([modified(node(), node({ l10n }))])).toBe(false);
			});

			it.each([
				["a changed field", node({ year: 1970, l10n: { fr } })],
				["a removed field", { ...node(), links: undefined, l10n: { fr } }],
				["an added field", node({ edges: [], l10n: { fr } })],
				["a changed link", node({ links: [], l10n: { fr } })],
			])("refuses %s next to the l10n block", (_label, head) => {
				expect(isL10nOnlyAddition([modified(node(), head)])).toBe(false);
			});

			it("refuses a rewritten or removed locale", () => {
				const base = node({ l10n: { fr } });
				expect(
					isL10nOnlyAddition([modified(base, node({ l10n: { fr: { ...fr, teaser: "Autre." } } }))]),
				).toBe(false);
				expect(isL10nOnlyAddition([modified(base, node({ l10n: { es: fr } }))])).toBe(false);
				expect(isL10nOnlyAddition([modified(base, node())])).toBe(false);
			});

			it("refuses a diff that adds no l10n block, or a block that is not an object", () => {
				expect(isL10nOnlyAddition([modified(node(), node())])).toBe(false);
				expect(isL10nOnlyAddition([modified(node(), node({ l10n: {} }))])).toBe(false);
				expect(isL10nOnlyAddition([modified(node(), node({ l10n: { fr: "Bonjour" } }))])).toBe(false);
				expect(isL10nOnlyAddition([modified(node(), node({ l10n: "fr" }))])).toBe(false);
				expect(isL10nOnlyAddition([modified(node({ l10n: null }), node({ l10n: { fr } }))])).toBe(false);
			});

			it("refuses an added, deleted, copied or type-changed file", () => {
				const head = JSON.stringify(node({ l10n: { fr } }));
				const path = "cache/nodes/project/abbey-road.json";
				for (const status of ["A", "D", "C", "T", "R"]) {
					expect(isL10nOnlyAddition([{ path, status, base: JSON.stringify(node()), head }])).toBe(false);
				}
				expect(isL10nOnlyAddition([{ path, status: "M", base: null, head }])).toBe(false);
				expect(isL10nOnlyAddition([{ path, status: "M", base: JSON.stringify(node()), head: null }])).toBe(
					false,
				);
			});

			it("refuses one bad file among good ones, and an empty diff", () => {
				const good = modified(node(), node({ l10n: { fr } }));
				const bad = modified(node(), node({ name: "Other", l10n: { fr } }), "cache/nodes/project/other.json");
				expect(isL10nOnlyAddition([good, bad])).toBe(false);
				expect(isL10nOnlyAddition([])).toBe(false);
			});

			it("refuses unreadable JSON and non-object roots", () => {
				const path = "cache/nodes/project/abbey-road.json";
				expect(isL10nOnlyAddition([{ path, status: "M", base: "{", head: "{}" }])).toBe(false);
				expect(isL10nOnlyAddition([{ path, status: "M", base: "[]", head: "[]" }])).toBe(false);
				expect(isL10nOnlyAddition([{ path, status: "M", base: "null", head: "null" }])).toBe(false);
			});

			it.each([
				"cache/youtube/abbey-road.json",
				"cache/nodes/project/abbey-road.txt",
				"cache/Nodes/project/abbey-road.json",
				"web/data.json",
				"src/schemas.ts",
				"scripts/ci/review-gate-policy.ts",
			])("refuses a file outside cache/nodes/**.json: %s", (path) => {
				expect(isL10nOnlyAddition([modified(node(), node({ l10n: { fr } }), path)])).toBe(false);
			});
		});

		describe("classifyRisk", () => {
			const nodePaths = ["cache/nodes/project/a.json", "cache/nodes/track/b.json"];

			it("lowers a tier/3 label to tier 2 when the diff only adds l10n", () => {
				expect(classifyRisk(nodePaths, ["tier/3"], { l10nOnly: true })).toBe(2);
			});

			it("keeps tier 3 without the flag, with a false flag, or without the label's cause being l10n", () => {
				expect(classifyRisk(nodePaths, ["tier/3"])).toBe(3);
				expect(classifyRisk(nodePaths, ["tier/3"], { l10nOnly: false })).toBe(3);
				expect(classifyRisk(nodePaths, ["tier/3"], {})).toBe(3);
			});

			it("does not raise a diff that was not tier/3", () => {
				expect(classifyRisk(nodePaths, [], { l10nOnly: true })).toBe(1);
				expect(classifyRisk(nodePaths, ["tier/2"], { l10nOnly: true })).toBe(2);
			});

			it("ignores the flag when any path is not a cache node file", () => {
				expect(classifyRisk([...nodePaths, "src/schemas.ts"], ["tier/3"], { l10nOnly: true })).toBe(3);
				expect(classifyRisk([...nodePaths, "cache/youtube/x.json"], ["tier/3"], { l10nOnly: true })).toBe(3);
				expect(classifyRisk([], ["tier/3"], { l10nOnly: true })).toBe(3);
			});

			// The control is part of the gate: a PR that edits it (or the workflows that call it) stays sensitive, flag or not.
			it.each([
				"scripts/ci/review-gate-policy.ts",
				"scripts/ci/review-gate-policy.test-helper.ts",
				".github/workflows/ai-review.yml",
				".github/workflows/review-gate.yml",
			])("keeps tier 3 for a PR that touches %s, whatever the flag", (path) => {
				expect(classifyRisk([...nodePaths, path], ["tier/3"], { l10nOnly: true })).toBe(3);
				expect(classifyRisk([...nodePaths, path], [], { l10nOnly: true })).toBe(3);
			});
		});

		describe("evaluateReviewGate", () => {
			const ordinary = { claude: "success", codex: "missing", claudeBlocking: false } as const;
			const nodePaths = ["cache/nodes/project/a.json"];

			it("passes on the ordinary review alone, with the deep review skipped", () => {
				const risk = classifyRisk(nodePaths, ["tier/3"], { l10nOnly: true });
				expect(
					evaluateReviewGate({ risk, ordinary, deep: "missing", deepClaude: "missing", touchesGate: false }),
				).toBe("pass");
			});

			it("still blocks on an ordinary blocking finding or a failing codex review", () => {
				const risk = classifyRisk(nodePaths, ["tier/3"], { l10nOnly: true });
				expect(
					evaluateReviewGate({
						risk,
						ordinary: { claude: "failure", codex: "success", claudeBlocking: true },
						deep: "missing",
						touchesGate: false,
					}),
				).toBe("block");
				expect(
					evaluateReviewGate({
						risk,
						ordinary: { claude: "success", codex: "failure", claudeBlocking: false },
						deep: "missing",
						touchesGate: false,
					}),
				).toBe("block");
			});

			it("still waits for the deep review when the diff is not l10n-only", () => {
				const risk = classifyRisk(nodePaths, ["tier/3"]);
				expect(
					evaluateReviewGate({ risk, ordinary, deep: "missing", deepClaude: "missing", touchesGate: false }),
				).toBe("wait");
			});
		});

		// The gate really runs the default branch's copy of this file as a CLI, on a real checkout.
		describe("CLI against a git history", () => {
			const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
			const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
			let repo = "";
			const git = (...args: string[]): string =>
				execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
			const write = (path: string, value: unknown): void => {
				mkdirSync(dirname(join(repo, path)), { recursive: true });
				writeFileSync(join(repo, path), `${JSON.stringify(value, null, "\t")}\n`);
			};
			// The policy runs with the temporary repository as its working directory (it is git's), so tsx cannot be found
			// by `npx` from there: it is started by absolute path, resolved from the project like the test itself.
			const runPolicy = (...args: string[]): string =>
				execFileSync(
					process.execPath,
					[tsxCli, join(projectRoot, "scripts/ci/review-gate-policy.ts"), ...args],
					{ cwd: repo, encoding: "utf8" },
				).trim();
			const l10nOnly = (base: string, head: string): string => runPolicy("l10n-only", base, head);
			const commit = (message: string): string => {
				git("add", "-A");
				git("commit", "-q", "-m", message);
				return git("rev-parse", "HEAD");
			};

			let base = "";
			beforeAll(() => {
				repo = mkdtempSync(join(tmpdir(), "tra841-"));
				git("init", "-q", "-b", "main");
				git("config", "user.email", "ci@example.test");
				git("config", "user.name", "ci");
				git("config", "commit.gpgsign", "false");
				for (let i = 0; i < 3; i++) write(`cache/nodes/project/p${i}.json`, node({ id: `project:p${i}` }));
				write("cache/nodes/track/t0.json", node({ id: "track:t0", type: "track" }));
				base = commit("base");
			});
			afterAll(() => rmSync(repo, { recursive: true, force: true }));
			beforeEach(() => {
				git("checkout", "-q", "-f", base);
				git("clean", "-q", "-fd");
			});

			it("prints true for a PR like #738 (only l10n.fr added, main moved on meanwhile)", () => {
				git("checkout", "-q", "-b", "pr738");
				for (let i = 0; i < 3; i++)
					write(`cache/nodes/project/p${i}.json`, node({ id: `project:p${i}`, l10n: { fr } }));
				const head = commit("l10n");
				git("checkout", "-q", "main");
				write("cache/nodes/track/t0.json", node({ id: "track:t0", type: "track", year: 2000 }));
				const newMain = commit("main moves on");
				expect(l10nOnly(newMain, head)).toBe("true");
				git("reset", "-q", "--hard", base);
			});

			it.each([
				[
					"a changed field",
					() => write("cache/nodes/project/p0.json", node({ id: "project:p0", year: 1, l10n: { fr } })),
				],
				[
					"an added file",
					() => write("cache/nodes/project/new.json", node({ id: "project:new", l10n: { fr } })),
				],
				["a file outside the cache", () => write("docs/note.json", { a: 1 })],
				["a deleted file", () => rmSync(join(repo, "cache/nodes/project/p1.json"))],
			])("prints false for %s", (_label, change) => {
				git("checkout", "-q", "-b", `pr-${Math.random().toString(36).slice(2)}`);
				write("cache/nodes/project/p2.json", node({ id: "project:p2", l10n: { fr } }));
				change();
				const head = commit("change");
				expect(l10nOnly(base, head)).toBe("false");
			});

			it("prints false on an unknown revision, an empty diff and missing arguments", () => {
				expect(l10nOnly(base, "does-not-exist")).toBe("false");
				expect(l10nOnly(base, base)).toBe("false");
				expect(runPolicy("l10n-only")).toBe("false");
			});

			it("carries the flag through the JSON CLI: tier/3 label, l10nOnly true, deep review skipped, gate passes", () => {
				const result = JSON.parse(
					runPolicy(
						JSON.stringify({
							paths: ["cache/nodes/project/p0.json"],
							labels: ["tier/3"],
							l10nOnly: true,
							ordinary: { claude: "success", codex: "missing", claudeBlocking: false },
							deep: "missing",
							deepClaude: "missing",
						}),
					),
				);
				expect(result).toEqual({ risk: 2, verdict: "pass" });
			});
		});
	});
});
