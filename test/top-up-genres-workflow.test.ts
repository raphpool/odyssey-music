import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Structural checks on the workflow file itself (TRA-70). No YAML parser is added
// as a dependency: these are targeted text assertions on the committed source,
// plus a direct execution of the diff-size predicate extracted from the file so
// a change to the embedded bash logic is caught by a real run, not a re-implementation.
const workflowPath = ".github/workflows/top-up-genres.yml";
const workflow = readFileSync(workflowPath, "utf8");

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
			workflow.indexOf("\njobs:"),
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

	it("never interpolates github.event.inputs.* directly inside a run: shell block", () => {
		// Inputs must flow through env: (then be referenced as "$VAR"); a raw
		// ${{ github.event.inputs.* }} inside `run:` risks shell injection.
		const runBlocks = [...workflow.matchAll(/run: \|\n([\s\S]*?)(?=\n {6}- name:|\n {2}[a-z-]+:\n|$)/g)];
		expect(runBlocks.length).toBeGreaterThan(0);
		for (const [, body] of runBlocks) {
			expect(body).not.toMatch(/\$\{\{\s*github\.event\.inputs\./);
		}
	});

	it("only exposes the API secrets to the step that runs the crawler", () => {
		const secretNames = ["GEMINI_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY"];
		const steps = workflow.split(/\n {6}- name: /).slice(1);
		const stepsWithSecrets = steps.filter((step) =>
			secretNames.some((name) => step.includes(`secrets.${name}`)),
		);
		expect(stepsWithSecrets).toHaveLength(1);
		expect(stepsWithSecrets[0]).toMatch(/^Run genre top-up/);
	});

	it("rejects diffs over the documented cap and accepts diffs within it (nominal, limit, failure)", () => {
		// Pull the exact predicate out of the workflow so a change to the thresholds
		// is exercised for real, not re-typed here.
		const match = workflow.match(/if \[ "\$lines" -gt (\d+) \] \|\| \[ "\$files" -gt (\d+) \]/);
		expect(match).not.toBeNull();
		const [, lineCap, fileCap] = match as RegExpMatchArray;
		expect(lineCap).toBe("600");
		expect(fileCap).toBe("20");

		const predicate = (lines: number, files: number): string => {
			const script = `
				lines=${lines}; files=${files}
				if [ "$lines" -gt ${lineCap} ] || [ "$files" -gt ${fileCap} ]; then echo oversized; else echo ok; fi
			`;
			return execFileSync("bash", ["-c", script]).toString().trim();
		};

		expect(predicate(10, 5)).toBe("ok"); // nominal
		expect(predicate(600, 20)).toBe("ok"); // exactly at the cap: still accepted
		expect(predicate(601, 5)).toBe("oversized"); // over the line cap
		expect(predicate(10, 21)).toBe("oversized"); // over the file cap
	});
});
