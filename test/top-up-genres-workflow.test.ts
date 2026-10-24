import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scopedReleaseSlugsEnabled } from "../src/flags.js";
import { makeSlug } from "../src/slug.js";

// Structural checks on the workflow file itself (TRA-70). No YAML parser is added
// as a dependency: these are targeted text assertions on the committed source,
// plus a direct execution of the diff-size predicate extracted from the file so
// a change to the embedded bash logic is caught by a real run, not a re-implementation.
const workflowPath = ".github/workflows/top-up-genres.yml";
const workflow = readFileSync(workflowPath, "utf8");
// Steps are YAML list items indented "      - " under jobs.top-up.steps; splitting on
// that marker (rather than on "- name:") catches steps without a `name:` too
// (checkout, setup-node, npm ci).
const steps = workflow.split(/\n {6}- /).slice(1);

/** Dedents a step's `run: |` body so it can be executed standalone by bash. */
function runBodyOf(step: string): string {
	const marker = "\n        run: |\n";
	const index = step.indexOf(marker);
	if (index === -1) throw new Error(`run: | block not found in step: ${step.slice(0, 40)}`);
	return step
		.slice(index + marker.length)
		.split("\n")
		.map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
		.join("\n");
}

describe("top-up-genres workflow (TRA-70)", () => {
	it("triggers only on workflow_dispatch, never on schedule or push", () => {
		const onBlock = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\nconcurrency:"));
		expect(onBlock).toContain("workflow_dispatch:");
		expect(onBlock).not.toMatch(/\bschedule:/);
		expect(onBlock).not.toMatch(/\bpush:/);
	});

	it("requires max_nodes as a workflow_dispatch input", () => {
		const inputsBlock = workflow.slice(workflow.indexOf("inputs:"), workflow.indexOf("concurrency:"));
		const maxNodesBlock = inputsBlock.slice(inputsBlock.indexOf("max_nodes:"));
		expect(maxNodesBlock).toMatch(/required:\s*true/);
	});

	it("grants only contents:write and pull-requests:write at job level, nothing at workflow level", () => {
		const topLevelPermissions = workflow.slice(
			workflow.indexOf("\npermissions:"),
			workflow.indexOf("\nenv:"),
		);
		expect(topLevelPermissions).toContain("contents: read");
		const jobPermissions = workflow.slice(
			workflow.indexOf("    permissions:"),
			workflow.indexOf("    steps:"),
		);
		expect(jobPermissions).toContain("contents: write");
		expect(jobPermissions).toContain("pull-requests: write");
	});

	it("declares a concurrency group so two runs never race each other", () => {
		expect(workflow).toMatch(/concurrency:\s*\n\s*group:\s*top-up-genres/);
	});

	it("checks out without persisting git credentials, so only the push/PR steps hold the token", () => {
		const checkoutStep = steps.find((step) => step.startsWith("uses: actions/checkout"));
		expect(checkoutStep).toBeDefined();
		expect(checkoutStep).toMatch(/persist-credentials:\s*false/);
	});

	it("never interpolates github.event.inputs.* directly inside a run: step body (single- or multi-line)", () => {
		// A raw ${{ github.event.inputs.* }} inside a run: body risks shell injection.
		// Scoped to each step's `run:` field, not the whole file: the `env:` mapping
		// right above it legitimately reads github.event.inputs.* — that's the safe
		// pattern this test protects — flagging it too would be a false positive.
		// Covers single-line `run: ...` too, not just the `run: |` form checked before.
		const runBodies = steps
			.map((step) => {
				const index = step.search(/\n {8}run:/);
				return index === -1 ? null : step.slice(index);
			})
			.filter((body): body is string => body !== null);
		expect(runBodies.length).toBeGreaterThan(5);
		for (const body of runBodies) {
			expect(body).not.toMatch(/\$\{\{[^}]*github\.event\.inputs\./);
		}
	});

	it("only exposes the API secrets to the step that runs the crawler", () => {
		const secretNames = ["GEMINI_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY"];
		expect(steps.length).toBeGreaterThan(5); // sanity: unnamed steps (checkout, npm ci...) are included
		const stepsWithSecrets = steps.filter((step) =>
			secretNames.some((name) => step.includes(`secrets.${name}`)),
		);
		expect(stepsWithSecrets).toHaveLength(1);
		expect(stepsWithSecrets[0]).toMatch(/^name: Run genre top-up/);
	});

	it("derives the max_nodes/max_new bound from the diff caps instead of an independent constant, and max_new's default stays under it (TRA-70 review round 2)", () => {
		// The two limits used to be independent and could contradict each other: a
		// nominal max_nodes=20 run (the old default) wrote ~20 nodes at ~103 lines
		// each, blowing past TOPUP_DIFF_LINES_CAP=600 *after* paying for the API
		// calls. The fix derives the node bound from the diff caps themselves, so
		// that can no longer happen — this executes the real "Validate max_nodes"
		// step body (not a re-implementation) to prove it.
		const linesCap = Number(workflow.match(/TOPUP_DIFF_LINES_CAP:\s*"(\d+)"/)?.[1]);
		const filesCap = Number(workflow.match(/TOPUP_DIFF_FILES_CAP:\s*"(\d+)"/)?.[1]);
		const linesPerNode = Number(workflow.match(/TOPUP_LINES_PER_NODE:\s*"(\d+)"/)?.[1]);
		const filesPerNode = Number(workflow.match(/TOPUP_FILES_PER_NODE:\s*"(\d+)"/)?.[1]);
		const maxNewDefault = Number(
			workflow
				.slice(workflow.indexOf("max_new:"), workflow.indexOf("dry_run:"))
				.match(/default:\s*"(\d+)"/)?.[1],
		);
		for (const value of [linesCap, filesCap, linesPerNode, filesPerNode, maxNewDefault]) {
			expect(value).toBeGreaterThan(0);
		}
		const bound = Math.floor(Math.min(linesCap / linesPerNode, filesCap / filesPerNode));

		// Static invariant: the default alone must never need the oversized-diff
		// safety net.
		expect(maxNewDefault).toBeLessThanOrEqual(bound);
		expect(maxNewDefault * linesPerNode).toBeLessThanOrEqual(linesCap);
		expect(maxNewDefault * filesPerNode).toBeLessThanOrEqual(filesCap);

		// Dynamic: run the actual derivation-and-rejection logic from the workflow.
		const validateStep = steps.find((step) => step.startsWith("name: Validate max_nodes"));
		expect(validateStep).toBeDefined();
		const script = runBodyOf(validateStep as string);
		const run = (maxNodes: number, maxNew: number): number | null =>
			spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					TOPUP_DIFF_LINES_CAP: String(linesCap),
					TOPUP_DIFF_FILES_CAP: String(filesCap),
					TOPUP_LINES_PER_NODE: String(linesPerNode),
					TOPUP_FILES_PER_NODE: String(filesPerNode),
					MAX_NODES: String(maxNodes),
					MAX_NEW: String(maxNew),
				},
			}).status;

		expect(run(bound, bound)).toBe(0); // exactly at the derived bound: accepted
		expect(run(bound + 1, 1)).not.toBe(0); // max_nodes over the bound: rejected
		expect(run(1, bound + 1)).not.toBe(0); // max_new over the bound: rejected
		expect(run(20, 20)).not.toBe(0); // the old max_nodes/max_new=20 defaults: now rejected up front
	});

	it("rejects diffs over the declared cap and accepts diffs within it (nominal, limit, failure)", () => {
		// Caps pulled from the workflow's env: block, predicate from its own source:
		// this tracks real behavior instead of re-typing (and drifting from) constants.
		const lineCap = workflow.match(/TOPUP_DIFF_LINES_CAP:\s*"(\d+)"/)?.[1];
		const fileCap = workflow.match(/TOPUP_DIFF_FILES_CAP:\s*"(\d+)"/)?.[1];
		expect(lineCap).toBeDefined();
		expect(fileCap).toBeDefined();
		expect(workflow).toMatch(
			/if \[ "\$lines" -gt "\$TOPUP_DIFF_LINES_CAP" \] \|\| \[ "\$files" -gt "\$TOPUP_DIFF_FILES_CAP" \]/,
		);

		const predicate = (lines: number, files: number): string => {
			const script = `
				TOPUP_DIFF_LINES_CAP=${lineCap}; TOPUP_DIFF_FILES_CAP=${fileCap}
				lines=${lines}; files=${files}
				if [ "$lines" -gt "$TOPUP_DIFF_LINES_CAP" ] || [ "$files" -gt "$TOPUP_DIFF_FILES_CAP" ]; then echo oversized; else echo ok; fi
			`;
			return execFileSync("bash", ["-c", script]).toString().trim();
		};
		const line = Number(lineCap);
		const file = Number(fileCap);

		expect(predicate(1, 1)).toBe("ok"); // nominal
		expect(predicate(line, file)).toBe("ok"); // exactly at the cap: still accepted
		expect(predicate(line + 1, 1)).toBe("oversized"); // over the line cap
		expect(predicate(1, file + 1)).toBe("oversized"); // over the file cap
	});

	it("gates push on a successful top-up, falls back gracefully on PR-creation permission, and only cleans up on real failure", () => {
		const pushStep = steps.find((step) => step.startsWith("name: Push the proposal branch"));
		expect(pushStep).toMatch(/steps\.topup\.outcome == 'success'/);

		const prStep = steps.find((step) => step.startsWith("name: Open a draft PR"));
		expect(prStep).toMatch(/not permitted to create/);
		expect(prStep).toMatch(/GITHUB_STEP_SUMMARY/);
		expect(prStep).toMatch(/exit 1/); // any other gh pr create failure still fails the job

		const cleanupStep = steps.find((step) => step.startsWith("name: Delete the pushed branch"));
		expect(cleanupStep).toMatch(/if: failure\(\) && steps\.push\.outputs\.branch/);
	});

	it("never persists the token into the runner's git config: push passes the URL directly instead of git remote set-url (TRA-281)", () => {
		// 2026-09-19 (TRA-281): `git remote set-url origin "https://x-access-token:...@..."`
		// writes the token in plaintext into the runner's (ephemeral but still
		// avoidable) .git/config. GitHub masks the token in job logs regardless, so
		// the risk was low, but there's no reason to persist it anywhere at all —
		// passing the URL as the direct `git push` argument never touches the
		// remote config, and the token stops existing on disk the moment the step ends.
		const pushStep = steps.find((step) => step.startsWith("name: Push the proposal branch"));
		expect(pushStep).toBeDefined();
		const script = runBodyOf(pushStep as string);
		expect(script).not.toMatch(/git remote set-url/);
		expect(script).toMatch(
			/git push "https:\/\/x-access-token:\$\{GH_TOKEN\}@github\.com\/\$\{\{\s*github\.repository\s*\}\}\.git" "\$branch"/,
		);
	});
});

// TRA-572: TRA-509 switched the production server to scoped, transliterated slugs through its systemd
// unit. A process that mints slugs without the flag keeps writing the old form (`artist:mrk` for Mørk
// while the server writes `artist:mork`), so this workflow, which writes nodes and edges into cache/,
// must carry the same flag. Parity with deploy/deploy-server.sh is deliberately not asserted:
// test/scoped-slugs-deploy-flag.test.ts keeps that file rollback-able, and a parity check would make a
// server-only rollback to 0 fail the test step of deploy.yml before it reaches the server. Pinning "1"
// here means rolling this workflow back is a conscious edit of this test too.
describe("top-up-genres workflow: scoped release slugs flag (TRA-572)", () => {
	const FLAG = "ODYSSEY_SCOPED_RELEASE_SLUGS";
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const workflowEnvBlock = workflow.slice(workflow.indexOf("\nenv:"), workflow.indexOf("\njobs:"));
	const declared = workflowEnvBlock.match(new RegExp(`^ {2}${FLAG}:\\s*"([^"]*)"\\s*$`, "m"))?.[1];

	it("declares the flag at workflow level, so every step that could mint a slug receives it", () => {
		expect(declared).toBe("1");
	});

	it("never overrides the flag in the job or in a step (comments aside)", () => {
		const jobsCode = workflow
			.slice(workflow.indexOf("\njobs:"))
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.join("\n");
		expect(jobsCode).not.toContain(FLAG);
	});

	it("makes the crawler read the flag as on and mint the same transliterated slugs as the server", () => {
		expect(declared).toBeDefined();
		vi.stubEnv(FLAG, declared as string);
		expect(scopedReleaseSlugsEnabled()).toBe(true);
		const withWorkflowEnv = makeSlug("genre", "Mørk Æther");
		expect(withWorkflowEnv).toBe("genre:mork-aether");

		// Control: without the flag (how the workflow ran before) the slug differs.
		vi.stubEnv(FLAG, "");
		expect(scopedReleaseSlugsEnabled()).toBe(false);
		expect(makeSlug("genre", "Mørk Æther")).not.toBe(withWorkflowEnv);
	});

	it("documents the per-command flag for local crawls in the README", () => {
		const readme = readFileSync("README.md", "utf8");
		expect(readme).toContain(`${FLAG}=1 npm run crawl`);
	});
});
