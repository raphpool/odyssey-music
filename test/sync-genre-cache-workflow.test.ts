import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural assertions on .github/workflows/sync-genre-cache.yml (TRA-269 / B6c), following the
// text-slice technique already used in test/top-up-genres-workflow.test.ts for the other
// workflow_dispatch job in this repo: no YAML parser dependency, just regex/string assertions on
// the raw file plus execution of the pure-logic pieces where that is safe. The steps here call out
// to deploy/sync-genre-cache.sh, which talks to a real production host over ssh/rsync -- that
// script's own behavior is covered by test/genre-cache-sync.test.ts against fake ssh/rsync/curl
// binaries. This file only tests the *wiring* around it: gating, concurrency, artifact publishing,
// and that no SERVER_* value can ever be steered by a workflow input.

const REPO_ROOT = join(__dirname, "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/sync-genre-cache.yml");
const DEPLOY_WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/deploy.yml");

const workflow = readFileSync(WORKFLOW_PATH, "utf8");
const deployWorkflow = readFileSync(DEPLOY_WORKFLOW_PATH, "utf8");

// Same technique as test/top-up-genres-workflow.test.ts: split the job's step list on the list
// marker at its fixed indentation (6 spaces under `jobs: <id>: steps:`), so each entry starts with
// either `name: ...` or `uses: ...`.
function jobSteps(yaml: string): string[] {
	return yaml.split(/\n {6}- /).slice(1);
}

function findStep(steps: string[], nameOrUses: string): string {
	const step = steps.find((s) => s.startsWith(`name: ${nameOrUses}`) || s.startsWith(`uses: ${nameOrUses}`));
	if (!step) {
		throw new Error(`step "${nameOrUses}" not found`);
	}
	return step;
}

const steps = jobSteps(workflow);
const deploySteps = jobSteps(deployWorkflow);

describe("sync-genre-cache workflow", () => {
	it("is a workflow_dispatch-only trigger with a boolean apply input defaulting to false", () => {
		const onBlock = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\nconcurrency:"));
		expect(onBlock).toMatch(/workflow_dispatch:/);
		// No push/schedule/pull_request trigger: --apply must only ever be reachable by an explicit,
		// interactive dispatch, never by a merge or a cron.
		expect(onBlock).not.toMatch(/\bpush:/);
		expect(onBlock).not.toMatch(/\bschedule:/);
		expect(onBlock).not.toMatch(/\bpull_request:/);

		const inputBlock = onBlock.slice(onBlock.indexOf("apply:"));
		expect(inputBlock).toMatch(/type:\s*boolean/);
		expect(inputBlock).toMatch(/default:\s*false/);
	});

	it("belongs to the deploy-prod concurrency group, same as the deploy job", () => {
		const concurrencyBlock = workflow.slice(workflow.indexOf("\nconcurrency:"), workflow.indexOf("\njobs:"));
		expect(concurrencyBlock).toMatch(/group:\s*deploy-prod/);
		expect(concurrencyBlock).toMatch(/cancel-in-progress:\s*false/);

		// Precondition from the ticket: a sync must not race a push-to-main deploy and restart the
		// service mid-cutover. Sharing the exact group name with deploy.yml is what serializes them.
		const deployConcurrencyBlock = deployWorkflow.slice(
			deployWorkflow.indexOf("\nconcurrency:"),
			deployWorkflow.indexOf("\njobs:"),
		);
		expect(deployConcurrencyBlock).toMatch(/group:\s*deploy-prod/);
	});

	it("pins the job timeout above deploy.yml's 15, to cover the doubled preview+apply invocation", () => {
		// Not previously pinned by any test (code-review finding): apply runs the whole
		// snapshot+union sequence twice in one job (once for the preview artifact, once again
		// inside --apply), against a real remote host and a cache/ tree that only grows, so 15
		// minutes -- fine for deploy.yml's single deploy-server.sh call -- is tight here.
		const jobBlock = workflow.slice(workflow.indexOf("\njobs:"), workflow.indexOf("\n    steps:"));
		expect(jobBlock).toMatch(/timeout-minutes:\s*30/);
	});

	it("reuses the deploy job's ssh-agent + known_hosts wrapper step verbatim", () => {
		const ours = findStep(steps, "Set up SSH");
		const theirs = findStep(deploySteps, "Set up SSH");
		expect(ours).toBe(theirs);
	});

	it("never derives a SERVER* value from a workflow input anywhere in the file", () => {
		// The ticket's explicit security requirement: SERVER_* is never fed from workflow inputs
		// (injection risk -- a dispatch input could otherwise redirect ssh/rsync to another host).
		// This workflow sets no SERVER* env at all (the script's own defaults are used), so the
		// stronger, simpler invariant to lock in is that no line assigns a SERVER*-named env key
		// from any `inputs.`/`github.event.inputs.` expression -- either as a YAML env mapping
		// (`SERVER_X: ${{ inputs.x }}`) or as a shell assignment inside a run: body
		// (`SERVER_X="${{ inputs.x }}"`), which the colon-only form would miss (code-review finding).
		expect(workflow).not.toMatch(/SERVER[A-Z_]*\s*:\s*.*inputs\./);
		expect(workflow).not.toMatch(/SERVER[A-Z_]*\s*=\s*.*inputs\./);
	});

	it("never sources a step-level env: value from an input, under any variable name", () => {
		// The SERVER*-named check above misses indirection: a step could set an *arbitrarily named*
		// env key from an input (`env: TARGET_HOST: ${{ inputs.apply }}`) and only build the actual
		// SERVER value from that variable inside its run: body (`export SERVER="root@$TARGET_HOST"`)
		// -- no literal "SERVER...inputs." substring ever appears, so the check above can't see it
		// (code-review mutation, confirmed to pass all 11 prior tests). None of this workflow's
		// steps need an input-derived env value at all (only `secrets.DEPLOY_SSH_KEY` is consumed),
		// so the safe, closed invariant is: no `<key>: ${{ ... inputs. ... }}` mapping anywhere,
		// except a step's own `if:` (the one place an input is legitimately read, evaluated by the
		// runner rather than substituted into a shell string).
		const keyValueFromInputs = /^(?! *if:)[ \t]*[A-Za-z_][A-Za-z0-9_]*:[ \t]*\$\{\{[^}]*\binputs\./m;
		expect(workflow).not.toMatch(keyValueFromInputs);
	});

	it("never interpolates the apply input directly inside a run: step body", () => {
		// Same forbidden-pattern check as test/top-up-genres-workflow.test.ts: an `${{ inputs.* }}`
		// or `${{ github.event.inputs.* }}` expression must only ever appear in a step-level `if:`
		// (evaluated by the runner), never substituted into a shell string a step executes.
		//
		// A step written as a single line (`- run: npm ci`, no `name:`) has its `run:` key at the
		// very start of the sliced step string, not preceded by `\n        ` the way a multi-line
		// `name: X\n        run: |` step's is -- the old `indexOf("\n        run:")` silently
		// skipped every such step (code-review mutation: `- run: npm ci` -> `- run: npm ci
		// --registry "${{ inputs.apply }}"` passed all 11 tests). Match `run:` at the start of the
		// step or after a newline, at any indentation, to cover both forms.
		expect(steps.length).toBeGreaterThan(0);
		let stepsWithRunBody = 0;
		for (const step of steps) {
			const runMatch = step.match(/(?:^|\n) *run:([\s\S]*)/);
			if (!runMatch) continue;
			stepsWithRunBody++;
			const body = runMatch[1] ?? "";
			expect(body).not.toMatch(/\$\{\{[^}]*\binputs\./);
		}
		// Guards the guard: if the extraction regex ever stops matching anything (e.g. the workflow's
		// indentation changes), this test would silently check zero steps and always pass.
		expect(stepsWithRunBody).toBeGreaterThanOrEqual(7);
	});

	it("always builds and publishes the preview before any apply step can run", () => {
		const previewIndex = workflow.indexOf("- name: Preview genre-cache sync");
		const uploadIndex = workflow.indexOf("- name: Upload preview artifact");
		const applyIndex = workflow.indexOf("- name: Apply genre-cache sync");
		expect(previewIndex).toBeGreaterThan(-1);
		expect(uploadIndex).toBeGreaterThan(previewIndex);
		expect(applyIndex).toBeGreaterThan(uploadIndex);

		const preview = findStep(steps, "Preview genre-cache sync");
		// No `if:` on the preview step: it is unconditional, unlike the apply/smoke steps below.
		expect(preview).not.toMatch(/\n {8}if:/);
		expect(preview).toMatch(/bash deploy\/sync-genre-cache\.sh 2>&1 \| tee/);
		// `set -euo pipefail` (not just `-eu`) is required here: without `pipefail`, a failing
		// script piped into `tee` would still exit 0 and the step would report success.
		expect(preview).toMatch(/set -euo pipefail/);
	});

	it("publishes the preview log as an artifact unconditionally, even on failure", () => {
		const upload = findStep(steps, "Upload preview artifact");
		expect(upload).toMatch(/if:\s*always\(\)/);
		expect(upload).toMatch(/uses:\s*actions\/upload-artifact@v4/);
		expect(upload).toMatch(/if-no-files-found:\s*error/);
		expect(upload).toMatch(/genre-cache-sync-preview\.log/);
	});

	it("gates --apply on the boolean dispatch input alone, and tees its output to a log", () => {
		const apply = findStep(steps, "Apply genre-cache sync");
		expect(apply).toMatch(/if:\s*\$\{\{\s*inputs\.apply\s*\}\}/);
		expect(apply).toMatch(/bash deploy\/sync-genre-cache\.sh --apply/);
		// The archive path and smoke-retry output are the script's own stdout/stderr; nothing here
		// discards it -- it lands in the job log, and is also teed to a file for the artifact
		// upload below ("imprimée", plus a durable copy of the rollback pointer on failure).
		expect(apply).not.toMatch(/>\s*\/dev\/null/);
		expect(apply).toMatch(/bash deploy\/sync-genre-cache\.sh --apply 2>&1 \| tee/);
		expect(apply).toMatch(/genre-cache-sync-apply\.log/);
	});

	it("publishes the apply log as an artifact even if --apply fails partway, but not when apply never ran", () => {
		const apply = findStep(steps, "Apply genre-cache sync");
		expect(apply).toMatch(/^\s*id:\s*apply\s*$/m);

		const upload = findStep(steps, "Upload apply artifact");
		// Keyed on the Apply step's own outcome (via its `id: apply` above), not `always() &&
		// inputs.apply`: an `if:` with no status-check function is implicitly ANDed with success(),
		// so when Preview fails, Apply is skipped (outcome "skipped") -- the old condition still
		// tried to upload here, found no log, and failed on if-no-files-found: error, adding a
		// second, confusing failure to an already-red job (code-review finding). Verified by
		// mutation: reverting to `always() && inputs.apply` here passes this repo's own
		// test/genre-cache-sync.test.ts-style reasoning but not this assertion.
		expect(upload).toMatch(
			/if:\s*\$\{\{\s*!cancelled\(\)\s*&&\s*steps\.apply\.outcome\s*!=\s*'skipped'\s*\}\}/,
		);
		expect(upload).not.toMatch(/if:\s*always\(\)\s*&&\s*inputs\.apply/);
		expect(upload).toMatch(/uses:\s*actions\/upload-artifact@v4/);
		expect(upload).toMatch(/if-no-files-found:\s*error/);
		expect(upload).toMatch(/genre-cache-sync-apply\.log/);
	});

	it("verifies the server's data.json taxonomy after a real apply, computed from data/genre-taxonomy.json, not hardcoded", () => {
		const dataJsonSmoke = findStep(steps, "Smoke - server data.json");
		expect(dataJsonSmoke).toMatch(/if:\s*\$\{\{\s*inputs\.apply\s*\}\}/);
		expect(dataJsonSmoke).toMatch(/curl -fsS https:\/\/dropcliffs\.com\/api\/odyssey\/data\.json/);
		// Base structural check (kept): the endpoint actually responds with a real nodes array.
		expect(dataJsonSmoke).toMatch(/\.nodes \| type\) == "array" and \(\.nodes \| length > 0\)/);

		// The real outcome this ticket ships: a `nodes`-only check already passes today, before any
		// sync ever runs -- prod serves ~1600 unrelated nodes and 0 published genre choices
		// (code-review finding, measured against the live server). `taxonomy` is entirely absent
		// from the response whenever src/graph.ts's "degrade" mode fails to project it, so the smoke
		// must assert on `.taxonomy.genres` specifically, with a floor computed IN THIS STEP from
		// data/genre-taxonomy.json -- the exact file deploy-server.sh ships -- never a literal count
		// (the published total moves with every publish PR, e.g. TRA-204/TRA-210, and again here).
		expect(dataJsonSmoke).toMatch(
			/EXPECTED_CHOICES="\$\(jq '\[\.genres\[\] \| select\(\.published == true\)\] \| length' data\/genre-taxonomy\.json\)"/,
		);
		expect(dataJsonSmoke).toMatch(/--argjson expected "\$EXPECTED_CHOICES"/);
		expect(dataJsonSmoke).toMatch(
			/\(\.taxonomy\.genres \| type\) == "array" and \(\.taxonomy\.genres \| length\) >= \$expected/,
		);

		// The two exhaustive families (house-techno, hip-hop-r-n-b) get the same dynamically
		// computed floor, per family, so a regression in one family can't hide behind the aggregate.
		expect(dataJsonSmoke).toMatch(/for FAMILY in house-techno hip-hop-r-n-b; do/);
		expect(dataJsonSmoke).toMatch(
			/\.taxonomy\.genres \| map\(select\(\.family == \$f\)\) \| length\) >= \$expected/,
		);

		// No hardcoded choice count anywhere in this step: the previous version of this assertion
		// (`not.toMatch(/\b(201|210)\b/)`) was vacuous -- the step contained no numbers at all, so it
		// could never fail (code-review finding). It's meaningful now that the step is long enough
		// for a future edit to plausibly reintroduce a literal instead of the computed $expected.
		expect(dataJsonSmoke).not.toMatch(/\b(201|210|39|23)\b/);
	});

	it("stops the ssh-agent unconditionally at the end of the job", () => {
		const stop = findStep(steps, "Stop SSH agent");
		expect(stop).toMatch(/if:\s*always\(\)/);
		expect(stop).toMatch(/ssh-agent -k/);
	});
});
