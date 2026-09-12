import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(".github/workflows/review-gate.yml"), "utf8");
const runStart = workflow.indexOf("        run: |\n");
const run = workflow.slice(runStart + "        run: |\n".length).replace(/^ {10}/gm, "");

function runGate(claude: string, codex: string, claudeBlocking = "false") {
	const directory = mkdtempSync(join(tmpdir(), "review-gate-"));
	const gh = join(directory, "gh");
	const sleep = join(directory, "sleep");
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
if [[ "$*" == *annotations* ]]; then printf '%s\\n' "$TEST_CLAUDE_BLOCKING"
elif [[ "$*" == *check-runs* ]]; then [ "$TEST_CLAUDE" = missing ] && printf '0\\tmissing\\n' || printf '123\\t%s\\n' "$TEST_CLAUDE"
elif [ -e "$MOCK_STATE" ]; then printf '%s\\n' "\${TEST_CODEX#*,}"
else printf '%s\\n' "\${TEST_CODEX%%,*}"; : > "$MOCK_STATE"; fi
`,
	);
	writeFileSync(sleep, "#!/usr/bin/env bash\nexit 0\n");
	chmodSync(gh, 0o755);
	chmodSync(sleep, 0o755);
	try {
		return spawnSync("bash", ["-c", run], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${directory}:${process.env.PATH ?? ""}`,
				REPOSITORY: "raphpool/odyssey-music",
				SHA: "0123456789012345678901234567890123456789",
				TEST_CLAUDE: claude,
				TEST_CODEX: codex,
				TEST_CLAUDE_BLOCKING: claudeBlocking,
				MOCK_STATE: join(directory, "state"),
			},
		});
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

describe("review gate policy", () => {
	it("passes when Claude succeeds", () => {
		expect(runGate("success", "missing").status).toBe(0);
	});

	it("passes when Codex succeeds after Claude fails", () => {
		expect(runGate("failure", "success").status).toBe(0);
	});

	it("does not let Codex pass while Claude is still running", () => {
		expect(runGate("missing", "success").status).toBe(1);
	});

	it.each(["missing", "pending"])("passes when Codex changes from %s to success", (initial) => {
		const result = runGate("failure", `${initial},success`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("attempt=2 claude=failure codex-review=success decision=pass");
	});

	it("blocks Claude findings even when Codex succeeds", () => {
		const result = runGate("failure", "success", "true");
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("decision=block");
	});

	it("blocks when Codex publishes a failure", () => {
		const result = runGate("missing", "failure");
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("decision=block");
	});

	it("waits for a fallback and leaves timeout to the workflow", () => {
		const result = runGate("failure", "missing");
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("decision=wait");
		expect(result.stdout).toContain("Aucun fournisseur");
	});
});
