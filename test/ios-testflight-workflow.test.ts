import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// TRA-729 (2026-11-17): the `testflight` Environment has no required reviewer, so its secrets are protected by
// three things only: it accepts main alone, this workflow has the workflow_dispatch trigger alone, and a PR under
// .github/ gets the deep review. These tests pin the workflow side. The guards on how the secrets reach the job
// come with the steps that use them (TRA-775).
// Same approach as native-ci-triggers.test.ts: no YAML parser dependency, the file is read as text.
const WORKFLOW = ".github/workflows/ios-testflight.yml";

/** Reads a workflow without its full-line comments, so a note such as "# no push trigger" is not configuration. */
const read = (path: string): string =>
	readFileSync(path, "utf8")
		.replaceAll("\r\n", "\n")
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");

/** Every guard of the ticket, as the names of the ones the given workflow text breaks. */
function violations(source: string): string[] {
	const found: string[] = [];
	const onBlock = source.match(/^on:\n((?:[ \t]+.*\n|[ \t]*\n)*)/m)?.[1] ?? "";
	const triggers = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]);
	if (triggers.join() !== "workflow_dispatch" || /^\s+inputs:/m.test(onBlock)) found.push("trigger");
	if (!/^ {4}if: github\.ref == 'refs\/heads\/main'\s*$/m.test(source)) found.push("main guard");
	if (!/^ {4}environment: testflight\s*$/m.test(source)) found.push("environment");
	const steps = source.split(/^ {6}- /m).slice(1);
	const checkout = steps.find((step) => step.includes("uses: actions/checkout@"));
	if (!checkout || !/^ {10}persist-credentials: false\s*$/m.test(checkout)) found.push("persist-credentials");
	return found;
}

describe("ios-testflight workflow guards (TRA-729)", () => {
	const source = read(WORKFLOW);

	it("breaks none of the guards", () => {
		expect(violations(source)).toEqual([]);
	});

	// A guard that never fails proves nothing: each mutation must trip exactly the guard it targets.
	it.each([
		["a push trigger", "  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n", "trigger"],
		["a dispatch input", "  workflow_dispatch:\n", "  workflow_dispatch:\n    inputs:\n", "trigger"],
		["no main guard", "if: github.ref == 'refs/heads/main'", "if: always()", "main guard"],
		["no Environment", "    environment: testflight\n", "", "environment"],
		["a persisted token", "persist-credentials: false", "persist-credentials: true", "persist-credentials"],
	])("fails on %s", (_label, from, to, guard) => {
		const mutated = source.replace(from, to);
		expect(mutated).not.toBe(source);
		expect(violations(mutated)).toEqual([guard]);
	});

	it("runs the steps in the contract order", () => {
		const names = [...source.matchAll(/^ {6}- (?:name: (.*)|uses: (\S+))$/gm)].map((m) => m[1] ?? m[2]);
		expect(names).toEqual(["actions/checkout@v6", "Select Xcode", "Stop until signing lands"]);
	});

	it("runs on the runner of ios-check, within the contract limits", () => {
		const runner = (text: string) => text.match(/^ {4}runs-on: (.*?)\s*$/m)?.[1];
		expect(runner(source)).toBeDefined();
		expect(runner(source)).toBe(runner(read(".github/workflows/ios-ci.yml")));
		expect(source).toMatch(/^ {4}timeout-minutes: 60\s*$/m);
		expect(source).toMatch(/^permissions:\n {2}contents: read\n/m);
		expect(source.match(/^\s*permissions:/gm)).toHaveLength(1); // no job-level block can widen the token
		expect(source).toMatch(/^concurrency:\n {2}group: ios-testflight\n {2}cancel-in-progress: false\n/m);
	});

	it("never traces the shell, which would print what a later step decodes", () => {
		expect(source).not.toMatch(/\bxtrace\b|\bset\s+-\w*x|\bbash\s+-\w*x/);
	});
});
