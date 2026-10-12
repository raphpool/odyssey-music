import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// TRA-411: ios-ci and mobile-ci must run on pull requests only. Branch protection is strict, so the
// squash merge on main produces the tree the PR check already tested; a push run only occupied the
// two self-hosted runners (2026-10-12: ios-check of the next PR waited ~14 min behind it).
// No YAML parser is added as a dependency: the assertions read the top-level `on:` block as text.
const workflows = [
	{ name: "ios-ci", path: ".github/workflows/ios-ci.yml", job: "ios-check" },
	{ name: "mobile-ci", path: ".github/workflows/mobile-ci.yml", job: "mobile-check" },
] as const;

/** Drops full-line comments so a note such as "# no push trigger" is never read as configuration. */
function withoutComments(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

/** Returns the top-level `on:` block, from its key up to the next top-level key. */
function onBlockOf(source: string): string {
	const match = source.match(/^on:\n((?:[ \t]+.*\n|[ \t]*\n)*)/m);
	if (!match?.[1]) throw new Error("top-level on: block not found");
	return match[1];
}

describe.each(workflows)("$name triggers (TRA-411)", ({ path, job }) => {
	const source = withoutComments(readFileSync(path, "utf8").replaceAll("\r\n", "\n"));
	const onBlock = onBlockOf(source);

	it("runs on pull_request with the four lifecycle types", () => {
		expect(onBlock).toMatch(/^ {2}pull_request:\s*$/m);
		expect(onBlock).toMatch(/^ {4}types: \[opened, synchronize, reopened, ready_for_review\]\s*$/m);
	});

	it("does not run on push, so a merge to main does not re-run the check", () => {
		expect(onBlock).not.toMatch(/\bpush:/);
		expect(onBlock).not.toMatch(/\bbranches:/);
	});

	it("declares no other trigger", () => {
		const triggers = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
		expect(triggers).toEqual(["pull_request"]);
	});

	it("still skips draft pull requests", () => {
		const start = source.indexOf(`\n  ${job}:`);
		if (start === -1) throw new Error(`job ${job} not found in ${path}`);
		const jobBlock = source.slice(start);
		expect(jobBlock).toContain("github.event.pull_request.draft == false");
	});
});

// Two ios-check runs in parallel on the one Mac saturated it (2026-10-12, #335: load 274, simulator
// did not boot in 600 s), so ios-check is pinned to the single runner carrying the `ios` label.
describe("ios-check runner label (TRA-411)", () => {
	const runsOnOf = (source: string, job: string): string[] => {
		const start = source.indexOf(`\n  ${job}:`);
		if (start === -1) throw new Error(`job ${job} not found`);
		const match = source.slice(start + 1).match(/^ {4}runs-on: \[(.*)\]\s*$/m);
		if (!match?.[1]) throw new Error(`runs-on list not found for ${job}`);
		return match[1].split(",").map((label) => label.trim());
	};

	it("requires the ios label on ios-check", () => {
		const source = withoutComments(readFileSync(".github/workflows/ios-ci.yml", "utf8"));
		expect(runsOnOf(source, "ios-check")).toEqual(["self-hosted", "macOS", "ARM64", "ios"]);
	});

	it("does not require the ios label in any ci.yml job", () => {
		const source = withoutComments(readFileSync(".github/workflows/ci.yml", "utf8"));
		const runsOnLines = source.match(/^ {4}runs-on:.*$/gm) ?? [];
		expect(runsOnLines.length).toBeGreaterThan(0);
		for (const line of runsOnLines) expect(line).not.toMatch(/\bios\b/);
	});
});
