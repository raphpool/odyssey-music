import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// TRA-461: the `integrity` job of ci.yml runs the cache audit and, on pull requests, the threshold ratchet.
// Like native-ci-triggers.test.ts, no YAML parser is added: the job block is read as text.
const source = readFileSync(".github/workflows/ci.yml", "utf8")
	.replaceAll("\r\n", "\n")
	.split("\n")
	.filter((line) => !/^\s*#/.test(line))
	.join("\n");

/** Returns a job's text, from its key up to the next top-level job key. */
function jobBlock(name: string): string {
	const start = source.indexOf(`\n  ${name}:\n`);
	if (start === -1) throw new Error(`job ${name} not found in ci.yml`);
	const rest = source.slice(start + 1);
	const next = rest.slice(1).search(/^ {2}[a-z][\w-]*:\s*$/m);
	return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("ci.yml integrity job (TRA-461)", () => {
	const block = jobBlock("integrity");

	it("runs the audit on the cache directory", () => {
		expect(block).toContain("npm run audit:cache -- cache");
	});

	it("runs the threshold ratchet against the PR base, on pull requests only", () => {
		expect(block).toContain('BASE="origin/${{ github.event.pull_request.base.ref }}"');
		expect(block).toContain('scripts/ci/threshold-ratchet.ts "$BASE"');
		const ratchetStep = block.slice(block.lastIndexOf("- name:", block.indexOf("threshold-ratchet")));
		expect(ratchetStep).toContain("if: github.event_name == 'pull_request'");
	});

	it("uses the same runner labels and HOME isolation as the other jobs", () => {
		expect(block).toMatch(/^ {4}runs-on: \[self-hosted, macOS, ARM64\]\s*$/m);
		expect(block).toContain('echo "HOME=$RUNNER_TEMP/home" >> "$GITHUB_ENV"');
	});

	it("skips draft pull requests like the other jobs", () => {
		expect(block).toContain(
			"github.event_name != 'pull_request' || github.event.pull_request.draft == false",
		);
	});

	it("adds no timeout-minutes, consistently with the rest of ci.yml", () => {
		expect(source).not.toContain("timeout-minutes");
	});

	it("never reads the generated web/data.json", () => {
		expect(block).not.toContain("web/data.json");
	});
});
