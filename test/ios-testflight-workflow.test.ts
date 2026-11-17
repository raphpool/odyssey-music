import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// TRA-729 (2026-11-17): the `testflight` Environment has no required reviewer, so its secrets are protected by
// three things only: it accepts main alone, this workflow has the workflow_dispatch trigger alone, and a PR under
// .github/ gets the deep review. These tests pin the workflow side and, since TRA-775, how the secrets reach the job.
// Same approach as native-ci-triggers.test.ts: no YAML parser dependency, the file is read as text.
const WORKFLOW = ".github/workflows/ios-testflight.yml";
const SECRETS = [
	"ASC_API_ISSUER_ID",
	"ASC_API_KEY_ID",
	"ASC_API_KEY_P8_BASE64",
	"IOS_APPSTORE_PROFILE_BASE64",
	"IOS_DIST_CERT_P12_BASE64",
	"IOS_DIST_CERT_PASSWORD",
];
const VARS = ["TRACK1_API_BASE_URL", "TRACK1_APPSTORE_PROFILE_NAME", "TRACK1_TEAM_ID"];
// Xcode 16 moved the user's profiles to UserData: the profile goes into both folders and leaves both at cleanup.
const PROFILE_FOLDERS = [
	"Library/MobileDevice/Provisioning Profiles",
	"Library/Developer/Xcode/UserData/Provisioning Profiles",
];

/** Reads a workflow without its full-line comments, so a note such as "# no push trigger" is not configuration. */
const read = (path: string): string =>
	readFileSync(path, "utf8")
		.replaceAll("\r\n", "\n")
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");

/** The `run:` value of one step (the text after the `- ` marker), one line or a `|` block. */
function runOf(step: string): string {
	const lines = step.split("\n");
	const start = lines.findIndex((line) => /^(?: {8})?run:/.test(line));
	if (start === -1) return "";
	const body = lines.slice(start + 1);
	const end = body.findIndex((line) => line !== "" && !line.startsWith(" ".repeat(9)));
	return [lines[start], ...(end === -1 ? body : body.slice(0, end))].join("\n");
}

/** Every guard of the ticket, as the names of the ones the given workflow text breaks. */
function violations(source: string): string[] {
	const found: string[] = [];
	const onBlock = source.match(/^on:\n((?:[ \t]+.*\n|[ \t]*\n)*)/m)?.[1] ?? "";
	const triggers = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]);
	if (triggers.join() !== "workflow_dispatch" || /^\s+inputs:/m.test(onBlock)) found.push("trigger");
	if (!/^ {4}if: github\.ref == 'refs\/heads\/main'\s*$/m.test(source)) found.push("main guard");
	if (!/^ {4}environment: testflight\s*$/m.test(source)) found.push("environment");
	const steps = source.split(/^ {6}- /m).slice(1);
	const stepNamed = (name: string) => steps.find((step) => step.startsWith(`name: ${name}\n`)) ?? "";
	if (steps.some((step) => /\$\{\{[^}]*\bsecrets\b/.test(runOf(step)))) found.push("secret in run");
	if (!/^ {8}if: always\(\)\s*$/m.test(stepNamed("Remove signing material")))
		found.push("cleanup not always");
	for (const name of ["Install signing material", "Remove signing material"]) {
		if (!PROFILE_FOLDERS.every((folder) => stepNamed(name).includes(folder)))
			found.push(`profile folders: ${name}`);
	}
	// Every checkout, not the first: a later one with a persisted token would leave the secrets' job with a token.
	const checkouts = steps.filter((step) => step.includes("uses: actions/checkout@"));
	const persists = (step: string) => !/^ {10}persist-credentials: false\s*$/m.test(step);
	if (checkouts.length === 0 || checkouts.some(persists)) found.push("persist-credentials");
	// One job, so the `if:` and the `environment:` above cannot be satisfied by two different jobs.
	const jobs = [...(source.split(/^jobs:\n/m)[1] ?? "").matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]);
	if (jobs.join() !== "testflight") found.push("jobs");
	return found;
}

describe("ios-testflight workflow guards (TRA-729, TRA-775)", () => {
	const source = read(WORKFLOW);
	const swap = (from: string, to: string) => (text: string) => text.replace(from, to);
	/** Applies `change` to the text from the given step on, so a folder left in the cleanup step only is a real case. */
	const fromStep = (name: string, change: (rest: string) => string) => (text: string) => {
		const at = text.indexOf(`- name: ${name}`);
		return text.slice(0, at) + change(text.slice(at));
	};
	const otherFolder = swap("Library/Developer/Xcode/UserData", "Library/Developer/Xcode/Elsewhere");

	it("breaks none of the guards", () => {
		expect(violations(source)).toEqual([]);
	});

	// A guard that never fails proves nothing: each mutation must trip exactly the guard it targets.
	it.each([
		["a push trigger", swap("  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n"), "trigger"],
		["a dispatch input", swap("  workflow_dispatch:\n", "  workflow_dispatch:\n    inputs:\n"), "trigger"],
		["no main guard", swap("if: github.ref == 'refs/heads/main'", "if: always()"), "main guard"],
		["no Environment", swap("    environment: testflight\n", ""), "environment"],
		[
			"a secret in run",
			swap("umask 077\n", `umask 077\n          echo \${{ secrets.ASC_API_KEY_ID }}\n`),
			"secret in run",
		],
		["a cleanup that can be skipped", swap("if: always()", "if: success()"), "cleanup not always"],
		[
			"a persisted token",
			swap("persist-credentials: false", "persist-credentials: true"),
			"persist-credentials",
		],
		[
			"a second checkout that keeps the token",
			swap(
				"      - name: Select Xcode",
				"      - uses: actions/checkout@v6\n        with:\n          persist-credentials: true\n      - name: Select Xcode",
			),
			"persist-credentials",
		],
		["a second job", (text: string) => `${text}  other:\n    runs-on: ubuntu-latest\n`, "jobs"],
		["a profile missing from a folder", otherFolder, "profile folders: Install signing material"],
		[
			"a profile left in a folder",
			fromStep("Remove signing material", otherFolder),
			"profile folders: Remove signing material",
		],
	])("fails on %s", (_label, mutate, guard) => {
		const mutated = mutate(source);
		expect(mutated).not.toBe(source);
		expect(violations(mutated)).toEqual([guard]);
	});

	it("reads exactly the six secrets and the three variables of the Environment", () => {
		const used = (context: string): string[] => [
			...new Set(
				[...source.matchAll(new RegExp(`\\$\\{\\{ ${context}\\.(\\w+) \\}\\}`, "g"))].map((m) => m[1] ?? ""),
			),
		];
		expect(used("secrets").sort()).toEqual(SECRETS);
		expect(used("vars").sort()).toEqual(VARS);
	});

	it("runs the steps in the contract order", () => {
		const names = [...source.matchAll(/^ {6}- (?:name: (.*)|uses: (\S+))$/gm)].map((m) => m[1] ?? m[2]);
		expect(names).toEqual([
			"actions/checkout@v6",
			"Select Xcode",
			"Install signing material",
			"Archive and upload",
			"Remove signing material",
			"Job summary",
		]);
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

	it("uploads, locks the API key file and never traces the shell", () => {
		expect(source).toContain('TRACK1_UPLOAD: "1"');
		expect(source).toMatch(/key="\$RUNNER_TEMP\/track1-asc-key\.p8"[\s\S]*chmod 600 "\$key"/);
		expect(source).not.toMatch(/\bxtrace\b|\bset\s+-\w*x|\bbash\s+-\w*x/);
	});
});
